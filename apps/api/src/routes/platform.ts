import {evaluateAlertRules, type AlertRule} from '@services-marketplace/contracts';
import type {AppServices} from '../app.js';
import {issueApiKey} from '../auth.js';
import type {RouteDefinition} from '../http/router.js';
import {s, type JsonSchema} from '../http/schema.js';
import {organizationPath, route, tenantOf} from './common.js';

export const PERMISSION_CATALOG: readonly string[] = Object.freeze([
  'organization:manage', 'organization:read', 'audit:read', 'resource:read',
  'customer-profile:read', 'customer-profile:write', 'provider:read', 'provider:write',
  'provider-location:read', 'provider-location:write', 'feature-flags:write', 'feature-flags:read',
  'assistant-registry:write', 'assistant-registry:read', 'knowledge-base:write',
  'knowledge-base:read', 'ai-gateway:admin', 'ai-gateway:invoke', 'ai-grounding:correct',
  'ai-grounding:review', 'request-drafts:create', 'turn-director:invoke',
  'research:sources:write', 'research:findings:write', 'research:findings:read',
  'consent:record', 'consent:manage', 'consent:read', 'privacy:request', 'privacy:manage',
  'operations:incidents:write', 'operations:incidents:read', 'job-rooms:write',
  'commerce:payment-accounts:write', 'commerce:payment-intents:create', 'notifications:write',
  'notifications:dispatch',
].sort());

export const DEFAULT_ALERT_RULES: readonly AlertRule[] = Object.freeze([
  {ruleKey: 'http.error-burst', metric: 'http.5xx', aggregation: 'count', comparator: '>=',
    threshold: 10, windowMs: 300_000, minimumSamples: 1, severity: 'sev2'},
  {ruleKey: 'http.latency-p95', metric: 'http.latency_ms', aggregation: 'p95', comparator: '>',
    threshold: 1_000, windowMs: 300_000, minimumSamples: 50, severity: 'sev3'},
]);

export const platformSchemas: Record<string, JsonSchema> = {
  Error: s.object({code: s.string(), message: s.string()}, ['code']),
  Health: s.object({status: {const: 'ok'}, version: s.string(), uptimeSeconds: s.integer({minimum: 0})}),
  Readiness: s.object({status: s.enum('ready', 'not_ready'), persistence: s.enum('postgres', 'memory'),
    database: s.boolean()}),
  Resource: s.object({id: s.string(), organizationId: s.string()}),
  ProvisionedOrganization: s.object({organizationId: s.string(), ownerSubjectId: s.string(),
    roleId: s.string(), apiKey: s.object({keyId: s.string(), token: s.string()})}),
  Role: s.object({organizationId: s.string(), roleId: s.string(), permissions: s.array(s.string())}),
  Membership: s.object({organizationId: s.string(), subjectId: s.string(),
    status: s.enum('active', 'suspended', 'revoked'), roleIds: s.array(s.string())}),
  IssuedApiKey: s.object({keyId: s.string(), token: s.string(), subjectId: s.string(),
    label: s.string()}),
  AuditEvent: s.object({eventId: s.string(), occurredAt: s.integer(), action: s.string(),
    subjectId: s.nullable(s.string()), organizationId: s.nullable(s.string()),
    resourceOrganizationId: s.string(), outcome: s.enum('authorized', 'denied')}),
  AdapterStatus: s.object({name: s.string(), mode: s.enum('disabled', 'sandbox', 'live'),
    detail: s.string()}),
  MetricsSnapshot: s.object({uptimeSeconds: s.integer(), counters: s.map(s.integer({minimum: 0}), 256),
    alerts: s.array(s.object({ruleKey: s.string(), severity: s.enum('sev1', 'sev2', 'sev3'),
      observed: s.number(), threshold: s.number(), sampleCount: s.integer(), dedupeKey: s.string()}))}),
};

const uuid = s.string({pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'});
const roleIdSchema = s.string({pattern: '^[a-z][a-z0-9-]{0,63}$'});
const permissionList = s.array(s.enum(...PERMISSION_CATALOG), {maxItems: 64});

export const STATUS_PAGE_COLORS = Object.freeze([{foreground: '#1b1f24', background: '#ffffff'},
  {foreground: '#0b5cad', background: '#ffffff'}]);

export function renderStatusPage(version: string, adapters: readonly {name: string; mode: string}[]): string {
  const rows = adapters.map(adapter =>
    `<tr><th scope="row">${adapter.name}</th><td>${adapter.mode}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Services Marketplace Engine</title>
<style>body{font:16px/1.5 system-ui,sans-serif;color:#1b1f24;background:#ffffff;margin:0 auto;max-width:42rem;padding:1rem}a{color:#0b5cad}table{border-collapse:collapse}th,td{text-align:left;padding:.25rem .75rem .25rem 0}</style>
</head>
<body>
<main>
<h1>Services Marketplace Engine</h1>
<p>Version ${version}. This is an API service; there is no end-user interface here.</p>
<h2>Documentation</h2>
<p><a href="/openapi.json">OpenAPI contract (JSON)</a></p>
<h2>Integrations</h2>
<table><caption>Adapter modes</caption><thead><tr><th scope="col">Adapter</th><th scope="col">Mode</th></tr></thead><tbody>${rows}</tbody></table>
</main>
</body>
</html>
`;
}

export function adapterStatuses(services: AppServices) {
  const adapters = services.adapters;
  return [adapters.ai.status, adapters.stripe.status, adapters.credentialCheck.status,
    adapters.esign.status, adapters.email.status, adapters.sms.status, adapters.push.status,
    adapters.objectStorage.status];
}

export function platformRoutes(services: AppServices,
  openApiDocument: () => unknown): RouteDefinition[] {
  return [
    route({method: 'GET', path: '/health', operationId: 'getHealth', tag: 'Platform', auth: 'none',
      summary: 'Liveness probe (no dependencies checked)',
      success: {status: 200, description: 'Process is alive', schema: s.ref('Health')},
      handler: async () => ({status: 200, body: {status: 'ok', version: services.config.version,
        uptimeSeconds: Math.max(0, Math.floor((services.now() - services.metrics.startedAt) / 1000))}})}),
    route({method: 'GET', path: '/ready', operationId: 'getReadiness', tag: 'Platform', auth: 'none',
      summary: 'Readiness probe (database reachable)',
      success: {status: 200, description: 'Ready to serve traffic', schema: s.ref('Readiness')},
      handler: async () => {
        const database = await services.identity.ping().catch(() => false);
        return {status: database ? 200 : 503, body: {status: database ? 'ready' : 'not_ready',
          persistence: services.config.persistence, database}};
      }}),
    route({method: 'GET', path: '/', operationId: 'getStatusPage', tag: 'Platform', auth: 'none',
      internal: true, summary: 'Accessible HTML status page',
      success: {status: 200, description: 'HTML page'},
      handler: async () => ({status: 200, contentType: 'text/html; charset=utf-8',
        body: renderStatusPage(services.config.version, adapterStatuses(services))})}),
    route({method: 'GET', path: '/openapi.json', operationId: 'getOpenApiDocument', tag: 'Platform',
      auth: 'none', internal: true, summary: 'OpenAPI document',
      success: {status: 200, description: 'OpenAPI 3.1 document'},
      handler: async () => ({status: 200, body: openApiDocument()})}),
    route({method: 'GET', path: '/v1/admin/system', operationId: 'getSystemStatus', tag: 'Platform',
      auth: 'platform-admin', summary: 'Adapter modes and metrics (platform operators only)',
      success: {status: 200, description: 'System status', schema: s.object({
        adapters: s.array(s.ref('AdapterStatus')), metrics: s.ref('MetricsSnapshot')})},
      handler: async () => ({status: 200, body: {adapters: adapterStatuses(services), metrics: {
        uptimeSeconds: Math.max(0, Math.floor((services.now() - services.metrics.startedAt) / 1000)),
        counters: services.metrics.counters(),
        alerts: evaluateAlertRules(DEFAULT_ALERT_RULES, services.metrics.samples(), services.now())}}})}),
    route({method: 'POST', path: '/v1/admin/organizations', operationId: 'provisionOrganization',
      tag: 'Platform', auth: 'platform-admin',
      summary: 'Create an organization with an owner role, owner membership and first API key',
      requestBody: s.object({name: s.string({minLength: 1, maxLength: 200}),
        ownerSubjectId: uuid}, ['name']),
      success: {status: 201, description: 'Organization provisioned; the token is shown once',
        schema: s.ref('ProvisionedOrganization')},
      handler: async context => {
        const body = context.body as {name: string; ownerSubjectId?: string};
        const organizationId = services.createId();
        const ownerSubjectId = body.ownerSubjectId ?? services.createId();
        await services.identity.createOrganization(organizationId, body.name.trim());
        await services.identity.putRole({organizationId, roleId: 'owner',
          permissions: PERMISSION_CATALOG});
        await services.identity.putMembership({organizationId, subjectId: ownerSubjectId,
          status: 'active', roleIds: ['owner']});
        const key = issueApiKey();
        await services.identity.createApiKey({keyId: key.keyId, organizationId,
          subjectId: ownerSubjectId, secretHash: key.secretHash, label: 'owner bootstrap key',
          status: 'active'});
        return {status: 201, body: {organizationId, ownerSubjectId, roleId: 'owner',
          apiKey: {keyId: key.keyId, token: key.token}}};
      }}),
    route({method: 'PUT', path: organizationPath + '/roles/{roleId}', operationId: 'putRole',
      tag: 'Organizations', auth: 'tenant', permission: 'organization:manage',
      summary: 'Create or replace a role and its permissions',
      requestBody: s.object({permissions: permissionList}),
      success: {status: 200, description: 'Role stored', schema: s.ref('Role')},
      handler: async context => {
        const tenant = tenantOf(context);
        const roleId = context.params.roleId!;
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(roleId)) return {status: 400, body: {code: 'invalid_request'}};
        const permissions = [...new Set((context.body as {permissions: string[]}).permissions)].sort();
        await services.identity.putRole({organizationId: tenant.organizationId, roleId, permissions});
        return {status: 200, body: {organizationId: tenant.organizationId, roleId, permissions}};
      }}),
    route({method: 'PUT', path: organizationPath + '/members/{subjectId}', operationId: 'putMembership',
      tag: 'Organizations', auth: 'tenant', permission: 'organization:manage',
      summary: 'Create or update a membership (subject ids are UUIDs)',
      requestBody: s.object({status: s.enum('active', 'suspended', 'revoked'),
        roleIds: s.array(roleIdSchema, {maxItems: 16})}),
      success: {status: 200, description: 'Membership stored', schema: s.ref('Membership')},
      handler: async context => {
        const tenant = tenantOf(context);
        const subjectId = context.params.subjectId!;
        const body = context.body as {status: 'active' | 'suspended' | 'revoked'; roleIds: string[]};
        if (!/^[0-9a-f-]{36}$/.test(subjectId)) return {status: 400, body: {code: 'invalid_request'}};
        const roleIds = [...new Set(body.roleIds)].sort();
        const known = new Set(tenant.state.roles.map(role => role.roleId));
        if (roleIds.some(roleId => !known.has(roleId))) return {status: 400, body: {code: 'invalid_request'}};
        await services.identity.putMembership({organizationId: tenant.organizationId, subjectId,
          status: body.status, roleIds});
        return {status: 200, body: {organizationId: tenant.organizationId, subjectId,
          status: body.status, roleIds}};
      }}),
    route({method: 'POST', path: organizationPath + '/api-keys', operationId: 'createApiKey',
      tag: 'Organizations', auth: 'tenant', permission: 'organization:manage',
      summary: 'Issue an API key for a member; the token is returned once',
      requestBody: s.object({subjectId: uuid, label: s.string({minLength: 1, maxLength: 120})}),
      success: {status: 201, description: 'Key issued', schema: s.ref('IssuedApiKey')},
      handler: async context => {
        const tenant = tenantOf(context);
        const body = context.body as {subjectId: string; label: string};
        const state = await services.identity.loadAuthorizationState(tenant.organizationId, body.subjectId);
        if (state.memberships[0]?.status !== 'active') return {status: 400, body: {code: 'invalid_request'}};
        const key = issueApiKey();
        await services.identity.createApiKey({keyId: key.keyId, organizationId: tenant.organizationId,
          subjectId: body.subjectId, secretHash: key.secretHash, label: body.label, status: 'active'});
        return {status: 201, body: {keyId: key.keyId, token: key.token, subjectId: body.subjectId,
          label: body.label}};
      }}),
    route({method: 'DELETE', path: organizationPath + '/api-keys/{keyId}', operationId: 'revokeApiKey',
      tag: 'Organizations', auth: 'tenant', permission: 'organization:manage',
      summary: 'Revoke an API key', success: {status: 204, description: 'Revoked'},
      handler: async context => {
        const tenant = tenantOf(context);
        return await services.identity.revokeApiKey(tenant.organizationId, context.params.keyId!)
          ? {status: 204} : {status: 404, body: {code: 'not_found'}};
      }}),
    route({method: 'GET', path: organizationPath + '/audit-events', operationId: 'listAuditEvents',
      tag: 'Organizations', auth: 'tenant', permission: 'audit:read',
      summary: 'Most recent authorization audit events for the organization',
      queryParameters: {limit: s.integer({minimum: 1, maximum: 200})},
      success: {status: 200, description: 'Audit events, newest first',
        schema: s.object({items: s.array(s.ref('AuditEvent'))})},
      handler: async context => {
        const tenant = tenantOf(context);
        const limit = Number(context.query.get('limit') ?? '50');
        return {status: 200, body: {items: await services.identity.listAuditEvents(
          tenant.organizationId, limit)}};
      }}),
    route({method: 'GET', path: organizationPath + '/resources/{resourceId}', operationId: 'getResource',
      tag: 'Organizations', auth: 'tenant', permission: 'resource:read',
      summary: 'Read a tenant resource (bootstrap contract)',
      success: {status: 200, description: 'Resource visible to the authorized tenant member',
        schema: s.ref('Resource')},
      handler: async context => {
        const tenant = tenantOf(context);
        const resource = await services.documents.get<{id: string}>(tenant.organizationId,
          'resource', context.params.resourceId!);
        return resource ? {status: 200, body: {id: resource.id, organizationId: tenant.organizationId}}
          : {status: 404, body: {code: 'not_found'}};
      }}),
  ];
}
