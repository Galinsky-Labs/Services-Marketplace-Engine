import type {OrganizationAuthorizationState, TenantAuditOptions} from '@services-marketplace/contracts';
import type {AppServices} from '../app.js';
import type {RouteContext, RouteDefinition, RouteResult, TenantContext} from '../http/router.js';
import {s, type JsonSchema} from '../http/schema.js';

export const organizationPath = '/v1/organizations/{organizationId}';

export function tenantOf(context: RouteContext): TenantContext {
  if (context.tenant === null) throw new Error('tenant context missing');
  return context.tenant;
}

export function auditOptions(services: AppServices): TenantAuditOptions {
  return {sink: services.identity, createOpaqueId: services.createId, now: services.now};
}

export function contractOptions(services: AppServices) {
  return {audit: auditOptions(services), createOpaqueId: services.createId, now: services.now};
}

/**
 * Operator grant derived from RBAC: active only while the membership is active, carrying
 * the union of the subject's role permissions inside that organization.
 */
export function operatorFrom(state: OrganizationAuthorizationState, organizationId: string,
  subjectId: string): {organizationId: string; subjectId: string; status: 'active' | 'inactive';
    permissions: readonly string[]} | null {
  const membership = state.memberships.find(candidate =>
    candidate.organizationId === organizationId && candidate.subjectId === subjectId);
  if (!membership) return null;
  const permissions = new Set<string>();
  for (const roleId of membership.roleIds) {
    for (const role of state.roles) {
      if (role.roleId === roleId && role.organizationId === organizationId) {
        role.permissions.forEach(permission => permissions.add(permission));
      }
    }
  }
  return {organizationId, subjectId, status: membership.status === 'active' ? 'active' : 'inactive',
    permissions: [...permissions].sort()};
}

export type ContractOutcome<T> =
  | {readonly accepted: true; readonly value: T; readonly replayed?: boolean}
  | {readonly accepted: false; readonly code: string};

/** Maps a contract result to HTTP: accepted -> success status, rejected -> 422 {code}. */
export function respond<T>(outcome: ContractOutcome<T>, successStatus = 200,
  map: (value: T, replayed: boolean) => unknown = value => value): RouteResult {
  if (!outcome.accepted) return {status: 422, body: {code: outcome.code}};
  const replayed = outcome.replayed === true;
  return {status: replayed && successStatus === 201 ? 200 : successStatus,
    body: map(outcome.value, replayed)};
}

export const errorResponses = (rejectionCode?: string): Record<number, {description: string;
  schema: JsonSchema}> => ({
  ...(rejectionCode ? {422: {description: 'Rejected by the domain contract (fail closed)',
    schema: s.object({code: {const: rejectionCode}})}} : {}),
});

/** Builds a route with consistent defaults. */
export function route(definition: Omit<RouteDefinition, 'responses'> & {
  readonly success: {readonly status: number; readonly description: string;
    readonly schema?: JsonSchema};
}): RouteDefinition {
  const {success, ...rest} = definition;
  return {...rest, responses: {
    [success.status]: success.schema ? {description: success.description, schema: success.schema}
      : {description: success.description},
    ...(success.status === 201 ? {200: {description: 'Exact replay of an earlier request',
      ...(success.schema ? {schema: success.schema} : {})}} : {}),
    ...errorResponses(definition.rejectionCode),
  }};
}

export const listOf = (schema: JsonSchema): JsonSchema => s.object({items: s.array(schema)});
