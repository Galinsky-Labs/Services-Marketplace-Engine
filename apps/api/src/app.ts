import crypto from 'node:crypto';
import type {QuarantineObjectStore} from '@services-marketplace/contracts';
import type {AIProvider} from './adapters/ai.js';
import type {HttpCredentialCheckAdapter} from './adapters/credential-check.js';
import type {HttpEsignAdapter} from './adapters/esign.js';
import type {
  ExpoPushAdapter, ResendEmailAdapter, TwilioSmsAdapter,
} from './adapters/notifications.js';
import type {AdapterStatus} from './adapters/status.js';
import type {StripeConnectAdapter} from './adapters/stripe.js';
import type {MetricsRecorder} from './metrics.js';
import type {DocumentStore} from './store/documents.js';
import type {IdentityRepository} from './store/identity.js';

export interface AppAdapters {
  readonly ai: AIProvider;
  readonly stripe: StripeConnectAdapter;
  readonly credentialCheck: HttpCredentialCheckAdapter;
  readonly esign: HttpEsignAdapter;
  readonly email: ResendEmailAdapter;
  readonly sms: TwilioSmsAdapter;
  readonly push: ExpoPushAdapter;
  readonly objectStorage: QuarantineObjectStore & {readonly status: AdapterStatus};
}

export interface AppConfig {
  readonly environment: 'development' | 'staging' | 'production';
  /** SHA-256 hex of PLATFORM_ADMIN_TOKEN, or null when platform admin is disabled. */
  readonly platformAdminTokenHash: string | null;
  readonly appBaseUrl: string;
  readonly turnDirectorEnabled: boolean;
  readonly rateLimitPerMinute: number;
  readonly corsOrigins: readonly string[];
  readonly stripeWebhookSecret: string | null;
  readonly version: string;
  readonly persistence: 'postgres' | 'memory';
}

export interface AppServices {
  readonly identity: IdentityRepository;
  readonly documents: DocumentStore;
  readonly adapters: AppAdapters;
  readonly config: AppConfig;
  readonly metrics: MetricsRecorder;
  readonly now: () => number;
  readonly createId: () => string;
  readonly log: (entry: Readonly<Record<string, unknown>>) => void;
}

export const createOpaqueId = (): string => crypto.randomUUID();

export const sha256Digest = (value: string): string =>
  'sha256:' + crypto.createHash('sha256').update(value, 'utf8').digest('hex');
