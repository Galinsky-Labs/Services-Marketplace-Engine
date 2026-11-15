import {createAIProvider, type AIProvider} from './adapters/ai.js';
import {HttpCredentialCheckAdapter} from './adapters/credential-check.js';
import {HttpEsignAdapter} from './adapters/esign.js';
import {ExpoPushAdapter, ResendEmailAdapter, TwilioSmsAdapter} from './adapters/notifications.js';
import {S3QuarantineObjectStore} from './adapters/object-storage.js';
import type {FetchLike} from './adapters/status.js';
import {StripeConnectAdapter} from './adapters/stripe.js';
import {createOpaqueId, type AppAdapters, type AppConfig, type AppServices} from './app.js';
import {sha256Hex} from './auth.js';
import type {RouteDefinition} from './http/router.js';
import {createApiHandler, type ApiHandler} from './http/server.js';
import type {JsonSchema} from './http/schema.js';
import {MetricsRecorder} from './metrics.js';
import {buildOpenApiDocument, errorSchemas} from './openapi.js';
import {aiRoutes, aiSchemas} from './routes/ai.js';
import {commerceRoutes, commerceSchemas, recipientResolver} from './routes/commerce.js';
import {configurationRoutes, configurationSchemas} from './routes/configuration.js';
import {marketplaceRoutes, marketplaceSchemas} from './routes/marketplace.js';
import {platformRoutes, platformSchemas} from './routes/platform.js';
import {trustRoutes, trustSchemas} from './routes/trust.js';
import {MemoryDocumentStore, type DocumentStore} from './store/documents.js';
import {MemoryIdentityRepository, type IdentityRepository} from './store/identity.js';

export const API_VERSION = '1.0.0';
export const PUBLIC_SERVER_URL = 'https://services-marketplace-engine.onrender.com';

export const componentSchemas: Readonly<Record<string, JsonSchema>> = {
  ...platformSchemas, ...marketplaceSchemas, ...configurationSchemas, ...aiSchemas,
  ...trustSchemas, ...commerceSchemas,
};

export type Environment = Readonly<Record<string, string | undefined>>;

export function createAdapters(env: Environment, documents: DocumentStore, now: () => number,
  fetchImpl?: FetchLike, ai?: AIProvider): AppAdapters {
  const resolve = recipientResolver(documents);
  const base = env.APP_BASE_URL || PUBLIC_SERVER_URL;
  return {
    ai: ai ?? createAIProvider(env),
    stripe: new StripeConnectAdapter(env.STRIPE_SECRET_KEY, fetchImpl),
    credentialCheck: new HttpCredentialCheckAdapter({url: env.BACKGROUND_CHECK_API_URL,
      apiKey: env.BACKGROUND_CHECK_API_KEY, mode: env.BACKGROUND_CHECK_MODE}, now, fetchImpl),
    esign: new HttpEsignAdapter({url: env.ESIGN_API_URL, apiKey: env.ESIGN_API_KEY,
      webhookSecret: env.ESIGN_WEBHOOK_SECRET}, fetchImpl),
    email: new ResendEmailAdapter({apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM}, resolve, base, fetchImpl),
    sms: new TwilioSmsAdapter({accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM}, resolve, base, fetchImpl),
    push: new ExpoPushAdapter({provider: env.PUSH_PROVIDER, accessToken: env.EXPO_ACCESS_TOKEN},
      resolve, base, fetchImpl),
    objectStorage: new S3QuarantineObjectStore(env, () => new Date(now()), fetchImpl),
  };
}

export function configFromEnv(env: Environment, persistence: 'postgres' | 'memory'): AppConfig {
  const environment = env.APP_ENV === 'production' || env.APP_ENV === 'staging' ? env.APP_ENV : 'development';
  const adminToken = env.PLATFORM_ADMIN_TOKEN;
  return {
    environment,
    platformAdminTokenHash: adminToken && /^smeadmin_[0-9a-f]{64}$/.test(adminToken) ? sha256Hex(adminToken) : null,
    appBaseUrl: env.APP_BASE_URL || PUBLIC_SERVER_URL,
    turnDirectorEnabled: env.TURN_DIRECTOR_ENABLED === 'true',
    rateLimitPerMinute: Math.max(10, Math.min(10_000, Number(env.RATE_LIMIT_PER_MINUTE) || 600)),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map(origin => origin.trim())
      .filter(origin => /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin)),
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    version: env.RENDER_GIT_COMMIT ? API_VERSION + '+' + env.RENDER_GIT_COMMIT.slice(0, 7) : API_VERSION,
    persistence,
  };
}

export interface App {
  readonly services: AppServices;
  readonly routes: readonly RouteDefinition[];
  readonly handler: ApiHandler;
  openApiDocument(): unknown;
}

export function buildRoutes(services: AppServices, openApi: () => unknown): RouteDefinition[] {
  return [...platformRoutes(services, openApi), ...marketplaceRoutes(services),
    ...configurationRoutes(services), ...aiRoutes(services), ...trustRoutes(services),
    ...commerceRoutes(services)];
}

export function createApp(services: AppServices): App {
  let document: unknown = null;
  const routes = buildRoutes(services, () => document);
  document = buildOpenApiDocument(routes, componentSchemas,
    {version: API_VERSION, serverUrl: PUBLIC_SERVER_URL});
  for (const route of routes) {
    if (route.auth === 'tenant' && !route.permission) throw new Error('Tenant route without permission: ' + route.operationId);
  }
  return {services, routes, handler: createApiHandler(services, routes, {...componentSchemas, ...errorSchemas}),
    openApiDocument: () => document};
}

/** In-memory application for tests, local development and contract generation. */
export function createMemoryApp(options: {readonly env?: Environment; readonly now?: () => number;
  readonly fetch?: FetchLike; readonly ai?: AIProvider;
  readonly log?: (entry: Readonly<Record<string, unknown>>) => void} = {}): App & {
  readonly identity: MemoryIdentityRepository; readonly documents: MemoryDocumentStore} {
  const env = options.env ?? {};
  const now = options.now ?? Date.now;
  const identity = new MemoryIdentityRepository();
  const documents = new MemoryDocumentStore();
  const services: AppServices = {identity, documents,
    adapters: createAdapters(env, documents, now, options.fetch, options.ai),
    config: configFromEnv(env, 'memory'), metrics: new MetricsRecorder(now), now,
    createId: createOpaqueId, log: options.log ?? (() => {})};
  return {...createApp(services), identity, documents};
}

export function createServicesWith(identity: IdentityRepository, documents: DocumentStore,
  env: Environment, persistence: 'postgres' | 'memory',
  log: (entry: Readonly<Record<string, unknown>>) => void): AppServices {
  const now = Date.now;
  return {identity, documents, adapters: createAdapters(env, documents, now),
    config: configFromEnv(env, persistence), metrics: new MetricsRecorder(now), now,
    createId: createOpaqueId, log};
}
