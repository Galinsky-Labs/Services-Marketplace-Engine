import crypto from 'node:crypto';
import http from 'node:http';
import {
  REQUEST_LIMITS, SECURITY_HEADERS, authorizeOrganizationAction, createRateLimiter,
  type OrganizationAuthorizationRequest,
} from '@services-marketplace/contracts';
import type {AppServices} from '../app.js';
import {authenticate} from '../auth.js';
import {AdapterDisabledError} from '../adapters/status.js';
import {compileRoutes, matchRoute, type RouteDefinition, type TenantContext} from './router.js';
import {validateSchema, type SchemaComponents} from './schema.js';

export const CONTRACT_VERSION = 1;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(code);
  }
}

function send(response: http.ServerResponse, status: number, body: unknown,
  contentType = 'application/json; charset=utf-8'): void {
  const payload = contentType.startsWith('application/json') ? JSON.stringify(body)
    : String(body ?? '');
  response.statusCode = status;
  response.setHeader('content-type', contentType);
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.end(payload);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > REQUEST_LIMITS.maximumBodyBytes) {
    throw new HttpError(413, 'payload_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > REQUEST_LIMITS.maximumBodyBytes) throw new HttpError(413, 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface ApiHandler {
  (request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
}

export function createApiHandler(services: AppServices, routes: readonly RouteDefinition[],
  components: SchemaComponents): ApiHandler {
  const compiled = compileRoutes(routes);
  const limiter = createRateLimiter({capacity: services.config.rateLimitPerMinute,
    refillPerSecond: services.config.rateLimitPerMinute / 60, maximumKeys: 10_000,
    now: services.now});
  const auditOptions = {sink: services.identity, createOpaqueId: services.createId,
    now: services.now};

  return async (request, response) => {
    const started = performance.now();
    const requestId = crypto.randomUUID();
    let operationId = 'unmatched';
    let status = 500;
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    response.setHeader('x-request-id', requestId);
    try {
      const origin = request.headers.origin;
      if (origin && services.config.corsOrigins.includes(origin)) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'origin');
        response.setHeader('access-control-allow-headers',
          'authorization, content-type, x-contract-version');
        response.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE');
        response.setHeader('access-control-max-age', '600');
      }
      if (request.method === 'OPTIONS') { status = 204; response.statusCode = 204; response.end(); return; }
      const rawUrl = request.url ?? '/';
      if (rawUrl.length > REQUEST_LIMITS.maximumUrlLength) throw new HttpError(414, 'uri_too_long');
      const url = new URL(rawUrl, 'http://internal.invalid');
      const matched = matchRoute(compiled, request.method ?? 'GET', url.pathname);
      if (matched.match === null) {
        throw matched.methodNotAllowed ? new HttpError(405, 'method_not_allowed')
          : new HttpError(404, 'not_found');
      }
      const {route} = matched.match;
      operationId = route.operationId;
      const forwarded = request.headers['x-forwarded-for'];
      const clientIp = (typeof forwarded === 'string' ? forwarded.split(',')[0]!.trim() : '') ||
        request.socket.remoteAddress || 'unknown';

      let tenant: TenantContext | null = null;
      if (route.auth === 'none') {
        if (!limiter.take('ip:' + clientIp)) throw new HttpError(429, 'rate_limited');
      } else {
        const authentication = await authenticate(request.headers.authorization,
          services.identity, services.config.platformAdminTokenHash);
        if (authentication.kind === 'none') {
          if (!limiter.take('ip:' + clientIp)) throw new HttpError(429, 'rate_limited');
          throw new HttpError(401, 'unauthenticated');
        }
        if (!limiter.take(authentication.kind === 'tenant' ? 'key:' + authentication.keyId
          : 'platform-admin')) throw new HttpError(429, 'rate_limited');
        if (url.pathname.startsWith('/v1/') &&
          request.headers['x-contract-version'] !== String(CONTRACT_VERSION)) {
          throw new HttpError(400, 'unsupported_contract_version');
        }
        if (route.auth === 'platform-admin') {
          if (authentication.kind !== 'platform-admin') throw new HttpError(403, 'authorization_denied');
        } else {
          if (authentication.kind !== 'tenant') throw new HttpError(403, 'authorization_denied');
          const pathOrganization = matched.params.organizationId ?? '';
          const state = await services.identity.loadAuthorizationState(
            authentication.organizationId, authentication.subjectId);
          const makeRequest = (permission: string): OrganizationAuthorizationRequest => ({
            subjectId: authentication.subjectId, organizationId: authentication.organizationId,
            resourceOrganizationId: pathOrganization, requiredPermission: permission,
          });
          const gate = makeRequest(route.permission ?? 'organization:read');
          const decision = authorizeOrganizationAction(gate, state);
          if (!decision.authorized) {
            await services.identity.append({eventId: services.createId(), occurredAt: services.now(),
              action: 'http.' + route.operationId, subjectId: authentication.subjectId,
              organizationId: authentication.organizationId,
              resourceOrganizationId: pathOrganization, outcome: 'denied'}).catch(() => {});
            throw new HttpError(403, 'authorization_denied');
          }
          tenant = {organizationId: authentication.organizationId,
            subjectId: authentication.subjectId, keyId: authentication.keyId, state,
            request: makeRequest};
        }
      }

      let body: unknown = undefined;
      if (route.requestBody) {
        const contentType = request.headers['content-type'] ?? '';
        if (!/^application\/json(;|$)/i.test(contentType)) throw new HttpError(415, 'unsupported_media_type');
        const raw = await readBody(request);
        try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_request', 'body is not JSON'); }
        const violation = validateSchema(route.requestBody, body, components);
        if (violation) throw new HttpError(400, 'invalid_request', violation);
      } else if (request.method === 'POST' || request.method === 'PUT') {
        const raw = await readBody(request);
        if (raw.trim().length > 0) throw new HttpError(400, 'invalid_request', 'no body expected');
      }
      for (const [name, schema] of Object.entries(route.queryParameters ?? {})) {
        const value = url.searchParams.get(name);
        if (value === null) continue;
        const parsed = schema.type === 'integer' ? Number(value) : value;
        const violation = validateSchema(schema, parsed, components, name);
        if (violation) throw new HttpError(400, 'invalid_request', violation);
      }

      const result = await route.handler({params: matched.params, query: url.searchParams, body,
        requestId, tenant});
      status = result.status;
      if (result.status === 204) { response.statusCode = 204; response.end(); return; }
      send(response, result.status, result.body, result.contentType);
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        send(response, error.status, error.detail ? {code: error.code, message: error.detail}
          : {code: error.code});
      } else if (error instanceof AdapterDisabledError) {
        status = 503;
        send(response, 503, {code: 'dependency_unavailable'});
      } else {
        status = 500;
        services.log({level: 'error', msg: 'unhandled request error', requestId, operationId,
          error: error instanceof Error ? error.name + ': ' + error.message : 'unknown'});
        if (!response.headersSent) send(response, 500, {code: 'internal_error'});
      }
    } finally {
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      services.metrics.record('http.latency_ms', durationMs);
      services.metrics.record('http.requests', 1);
      if (status >= 500) services.metrics.record('http.5xx', 1);
      services.log({level: status >= 500 ? 'error' : 'info', msg: 'request', requestId,
        method: request.method, operationId, status, durationMs});
    }
  };
}

export function createHttpServer(handler: ApiHandler): http.Server {
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  server.requestTimeout = REQUEST_LIMITS.requestTimeoutMs;
  server.headersTimeout = Math.min(REQUEST_LIMITS.requestTimeoutMs, 10_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}
