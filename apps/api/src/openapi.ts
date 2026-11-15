import type {RouteDefinition} from './http/router.js';
import {s, type JsonSchema} from './http/schema.js';

export const errorSchemas: Record<string, JsonSchema> = {
  UnsupportedContractVersion: s.object({code: {const: 'unsupported_contract_version'}}),
  AuthorizationDenied: s.object({code: {const: 'authorization_denied'}}),
  BadRequest: s.object({code: s.enum('invalid_request', 'unsupported_contract_version'),
    message: s.string()}, ['code']),
  Unauthenticated: s.object({code: {const: 'unauthenticated'}}),
  NotFound: s.object({code: {const: 'not_found'}}),
  Conflict: s.object({code: {const: 'conflict'}}),
  PayloadTooLarge: s.object({code: {const: 'payload_too_large'}}),
  RateLimited: s.object({code: {const: 'rate_limited'}}),
  DependencyUnavailable: s.object({code: {const: 'dependency_unavailable'}}),
};

const json = (schema: JsonSchema) => ({'application/json': {schema}});

function standardErrors(route: RouteDefinition): Record<string, unknown> {
  const errors: Record<string, unknown> = {
    429: {description: 'Rate limited', content: json(s.ref('RateLimited'))},
  };
  if (route.auth === 'none') return errors;
  return {
    400: {description: 'Invalid request or unsupported contract version', content: json(s.ref('BadRequest'))},
    401: {description: 'Missing or invalid credentials', content: json(s.ref('Unauthenticated'))},
    403: {description: 'Authorization denied without resource disclosure',
      content: json(s.ref('AuthorizationDenied'))},
    404: {description: 'Not found', content: json(s.ref('NotFound'))},
    409: {description: 'Concurrent modification', content: json(s.ref('Conflict'))},
    413: {description: 'Body too large', content: json(s.ref('PayloadTooLarge'))},
    ...errors,
    503: {description: 'Required external adapter is not configured',
      content: json(s.ref('DependencyUnavailable'))},
  };
}

export interface OpenApiOptions {
  readonly version: string;
  readonly serverUrl: string;
}

export function buildOpenApiDocument(routes: readonly RouteDefinition[],
  components: Readonly<Record<string, JsonSchema>>, options: OpenApiOptions): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    if (route.internal) continue;
    const parameters: unknown[] = [...route.path.matchAll(/\{([A-Za-z0-9]+)\}/g)].map(match => ({
      name: match[1], in: 'path', required: true, schema: {type: 'string', minLength: 1},
    }));
    for (const [name, schema] of Object.entries(route.queryParameters ?? {})) {
      parameters.push({name, in: 'query', required: false, schema});
    }
    if (route.auth !== 'none' && route.path.startsWith('/v1/')) {
      parameters.push({$ref: '#/components/parameters/ContractVersion'});
    }
    const responses: Record<string, unknown> = {};
    for (const [status, spec] of Object.entries(route.responses)) {
      responses[status] = spec.schema ? {description: spec.description, content: json(spec.schema)}
        : {description: spec.description};
    }
    for (const [status, spec] of Object.entries(standardErrors(route))) {
      if (!(status in responses)) responses[status] = spec;
    }
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: [route.tag],
      ...(route.auth === 'none' ? {security: []} : {security: [{bearerAuth: []}]}),
      ...(route.permission ? {'x-required-permission': route.permission} : {}),
      ...(route.auth === 'platform-admin' ? {'x-platform-admin': true} : {}),
      ...(parameters.length > 0 ? {parameters} : {}),
      ...(route.requestBody ? {requestBody: {required: true, content: json(route.requestBody)}} : {}),
      responses: Object.fromEntries(Object.entries(responses).sort(([left], [right]) =>
        left < right ? -1 : 1)),
    };
    paths[route.path] = {...(paths[route.path] ?? {}), [route.method.toLowerCase()]: operation};
  }
  const sortedPaths = Object.fromEntries(Object.entries(paths).sort(([left], [right]) =>
    left < right ? -1 : 1));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Services Marketplace Engine API',
      version: options.version,
      description: 'Industry-neutral services marketplace engine. Tenant routes require a bearer ' +
        'API key bound to one organization plus the X-Contract-Version header. Domain ' +
        'rejections are deliberately generic (fail closed).',
    },
    servers: [{url: options.serverUrl}],
    tags: [...new Set(routes.filter(route => !route.internal).map(route => route.tag))].sort()
      .map(name => ({name})),
    paths: sortedPaths,
    components: {
      parameters: {
        ContractVersion: {name: 'X-Contract-Version', in: 'header', required: true,
          schema: {type: 'integer', const: 1}},
      },
      schemas: Object.fromEntries(Object.entries({...components, ...errorSchemas})
        .sort(([left], [right]) => left < right ? -1 : 1)),
      securitySchemes: {bearerAuth: {type: 'http', scheme: 'bearer'}},
    },
  };
}
