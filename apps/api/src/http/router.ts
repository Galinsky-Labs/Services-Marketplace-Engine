import type {
  OrganizationAuthorizationRequest, OrganizationAuthorizationState,
} from '@services-marketplace/contracts';
import type {JsonSchema} from './schema.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface TenantContext {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly keyId: string;
  readonly state: OrganizationAuthorizationState;
  /** Authorization request for a contract call needing `permission`. */
  request(permission: string): OrganizationAuthorizationRequest;
}

export interface RouteContext {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly requestId: string;
  readonly tenant: TenantContext | null;
}

export interface RouteResult {
  readonly status: number;
  readonly body?: unknown;
  readonly contentType?: string;
}

export interface ResponseSpec {
  readonly description: string;
  readonly schema?: JsonSchema;
}

export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tag: string;
  readonly auth: 'none' | 'tenant' | 'platform-admin';
  /** RBAC permission checked against the path organization before the handler runs. */
  readonly permission?: string;
  /** Domain rejection code returned as 422 by this route, if any. */
  readonly rejectionCode?: string;
  readonly requestBody?: JsonSchema;
  readonly queryParameters?: Readonly<Record<string, JsonSchema>>;
  readonly responses: Readonly<Record<number, ResponseSpec>>;
  /** Excluded from the public OpenAPI document and SDK (e.g. HTML status page). */
  readonly internal?: boolean;
  handler(context: RouteContext): Promise<RouteResult>;
}

export interface CompiledRoute {
  readonly route: RouteDefinition;
  readonly pattern: RegExp;
  readonly parameterNames: readonly string[];
}

export function compileRoutes(routes: readonly RouteDefinition[]): readonly CompiledRoute[] {
  const seen = new Set<string>();
  return routes.map(route => {
    const signature = route.method + ' ' + route.path;
    if (seen.has(signature) || seen.has(route.operationId)) {
      throw new Error('Duplicate route ' + signature + ' / ' + route.operationId);
    }
    seen.add(signature);
    seen.add(route.operationId);
    const parameterNames: string[] = [];
    const source = route.path.split('/').map(segment => {
      const match = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(segment);
      if (!match) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      parameterNames.push(match[1]!);
      return '([^/]+)';
    }).join('/');
    return {route, pattern: new RegExp('^' + source + '$'), parameterNames};
  });
}

export function matchRoute(routes: readonly CompiledRoute[], method: string,
  pathname: string): {readonly match: CompiledRoute; readonly params: Record<string, string>} |
  {readonly match: null; readonly methodNotAllowed: boolean} {
  let pathMatched = false;
  for (const compiled of routes) {
    const result = compiled.pattern.exec(pathname);
    if (!result) continue;
    pathMatched = true;
    if (compiled.route.method !== method) continue;
    const params: Record<string, string> = {};
    try {
      compiled.parameterNames.forEach((name, index) => {
        params[name] = decodeURIComponent(result[index + 1]!);
      });
    } catch {
      return {match: null, methodNotAllowed: false};
    }
    return {match: compiled, params};
  }
  return {match: null, methodNotAllowed: pathMatched};
}
