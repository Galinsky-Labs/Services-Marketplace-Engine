import {
  AUTHORIZATION_DENIED,
  BOOTSTRAP_CONTRACT_VERSION,
  authorizeTenantAccess,
  type AuthorizationContext,
} from '@services-marketplace/contracts';

export interface ApiRequest {
  readonly contractVersion: number;
  readonly context: AuthorizationContext;
  readonly organizationId: string;
  readonly resourceId: string;
}

export type ApiResponse =
  | { readonly status: 200; readonly body: { readonly id: string; readonly organizationId: string } }
  | { readonly status: 400; readonly body: { readonly code: 'unsupported_contract_version' } }
  | { readonly status: 403; readonly body: { readonly code: typeof AUTHORIZATION_DENIED } };

export async function handleResourceRead(
  request: ApiRequest,
  findResource: (organizationId: string, resourceId: string) => Promise<{id: string}>,
): Promise<ApiResponse> {
  if (request.contractVersion !== BOOTSTRAP_CONTRACT_VERSION) {
    return {status: 400, body: {code: 'unsupported_contract_version'}};
  }

  const authorization = authorizeTenantAccess(
    request.context,
    request.organizationId,
    'resource:read',
  );
  if (!authorization.authorized) {
    return {status: 403, body: {code: authorization.code}};
  }

  const resource = await findResource(authorization.organizationId, request.resourceId);
  return {
    status: 200,
    body: {id: resource.id, organizationId: authorization.organizationId},
  };
}

export {createApp, createMemoryApp, createAdapters, configFromEnv, componentSchemas, buildRoutes, createServicesWith,
  API_VERSION, PUBLIC_SERVER_URL} from './create-app.js';
export {buildOpenApiDocument} from './openapi.js';
export {createHttpServer, createApiHandler} from './http/server.js';
export {validateSchema} from './http/schema.js';
export {MemoryDocumentStore, PostgresDocumentStore, canonicalJson} from './store/documents.js';
export {MemoryIdentityRepository, PostgresIdentityRepository} from './store/identity.js';
export {runMigrations, discoverMigrations} from './db/migrate.js';
export {issueApiKey, authenticate, sha256Hex} from './auth.js';
export {
  AnthropicAIProvider, DeterministicAIProvider, answerFromChunks, extractDraftFields,
  DETERMINISTIC_FALLBACK_LABEL,
} from './adapters/ai.js';
export {StripeConnectAdapter, verifyStripeSignature} from './adapters/stripe.js';
export {HttpCredentialCheckAdapter} from './adapters/credential-check.js';
export {HttpEsignAdapter, esignEventPayload} from './adapters/esign.js';
export {ResendEmailAdapter, TwilioSmsAdapter, ExpoPushAdapter, renderTemplate} from './adapters/notifications.js';
export {S3QuarantineObjectStore, presignS3Url} from './adapters/object-storage.js';
export {renderStatusPage, adapterStatuses, PERMISSION_CATALOG, STATUS_PAGE_COLORS} from './routes/platform.js';
