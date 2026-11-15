import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const CONSENT_LEDGER_CONTRACT_VERSION = 1 as const;
export const CONSENT_LEDGER_REJECTED = 'consent_ledger_rejected' as const;
export const CONSENT_GENESIS_HASH = 'sha256:' + '0'.repeat(64);

export type ConsentPurpose =
  | 'terms-of-service' | 'privacy-notice' | 'marketing-email' | 'marketing-sms'
  | 'push-notifications' | 'ai-processing' | 'data-sharing' | 'call-recording';
export type ConsentDecision = 'granted' | 'withdrawn';
export type ConsentChannel = 'web' | 'mobile' | 'api' | 'support';

/** Append-only, hash-chained consent entry. Each subject has one chain per tenant. */
export interface ConsentEntry {
  readonly entryId: string;
  readonly organizationId: string;
  readonly subjectId: string;
  readonly sequence: number;
  readonly requestKey: string;
  readonly purpose: ConsentPurpose;
  readonly decision: ConsentDecision;
  readonly noticeVersion: string;
  readonly channel: ConsentChannel;
  readonly recordedBySubjectId: string;
  readonly recordedAt: number;
  readonly previousHash: string;
  readonly entryHash: string;
}

export interface ConsentLedgerStore {
  getHead(organizationId: string, subjectId: string): Promise<ConsentEntry | null>;
  getByRequestKey(organizationId: string, requestKey: string): Promise<ConsentEntry | null>;
  /** Appends only when the subject's current head still equals `expectedHead`. */
  append(expectedHead: ConsentEntry | null, entry: ConsentEntry): Promise<boolean>;
}

export interface ConsentLedgerOptions {
  readonly store: ConsentLedgerStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
  /** Returns `sha256:<64 lowercase hex>` of the UTF-8 input. */
  readonly sha256: (value: string) => string;
}

export type ConsentLedgerResult =
  | {readonly accepted: true; readonly value: ConsentEntry; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof CONSENT_LEDGER_REJECTED};

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = Object.freeze(['terms-of-service',
  'privacy-notice', 'marketing-email', 'marketing-sms', 'push-notifications', 'ai-processing',
  'data-sharing', 'call-recording']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const DATE = 8_640_000_000_000_000;
const CHANNELS: readonly string[] = ['web', 'mobile', 'api', 'support'];
const rejected = (): ConsentLedgerResult => ({accepted: false, code: CONSENT_LEDGER_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/** Canonical, field-ordered serialization that the entry hash commits to. */
export function canonicalConsentPayload(entry: Omit<ConsentEntry, 'entryHash'>): string {
  return JSON.stringify([entry.entryId, entry.organizationId, entry.subjectId, entry.sequence,
    entry.requestKey, entry.purpose, entry.decision, entry.noticeVersion, entry.channel,
    entry.recordedBySubjectId, entry.recordedAt, entry.previousHash]);
}

function structurallyValid(entry: ConsentEntry): boolean {
  return ID.test(entry?.entryId) && ID.test(entry.organizationId) && ID.test(entry.subjectId) &&
    integer(entry.sequence, 1, Number.MAX_SAFE_INTEGER) && ID.test(entry.requestKey) &&
    CONSENT_PURPOSES.includes(entry.purpose) &&
    (entry.decision === 'granted' || entry.decision === 'withdrawn') &&
    VERSION.test(entry.noticeVersion) && CHANNELS.includes(entry.channel) &&
    ID.test(entry.recordedBySubjectId) && integer(entry.recordedAt, 0, DATE) &&
    HASH.test(entry.previousHash) && HASH.test(entry.entryHash);
}

/** Verifies sequence, linkage, ownership and every hash of a subject's full chain. */
export function verifyConsentChain(entries: readonly ConsentEntry[], organizationId: string,
  subjectId: string, sha256: (value: string) => string): boolean {
  if (!Array.isArray(entries)) return false;
  let previousHash = CONSENT_GENESIS_HASH;
  let previousTime = 0;
  for (const [index, entry] of entries.entries()) {
    if (!structurallyValid(entry) || entry.organizationId !== organizationId ||
      entry.subjectId !== subjectId || entry.sequence !== index + 1 ||
      entry.previousHash !== previousHash || entry.recordedAt < previousTime) return false;
    const {entryHash, ...rest} = entry;
    if (sha256(canonicalConsentPayload(rest)) !== entryHash) return false;
    previousHash = entryHash;
    previousTime = entry.recordedAt;
  }
  return true;
}

export interface ConsentStatus {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly noticeVersion: string | null;
  readonly decidedAt: number | null;
  readonly chainValid: boolean;
}

/**
 * Effective consent for a purpose at a time. A broken chain, unknown purpose or no entry
 * all evaluate to not granted (fail closed). A required notice version, when given, must
 * match the latest grant.
 */
export function evaluateConsent(entries: readonly ConsentEntry[], organizationId: string,
  subjectId: string, purpose: ConsentPurpose, at: number, sha256: (value: string) => string,
  requiredNoticeVersion?: string): ConsentStatus {
  const chainValid = verifyConsentChain(entries, organizationId, subjectId, sha256);
  const latest = chainValid && CONSENT_PURPOSES.includes(purpose)
    ? [...entries].reverse().find(entry => entry.purpose === purpose && entry.recordedAt <= at)
    : undefined;
  const granted = latest?.decision === 'granted' &&
    (requiredNoticeVersion === undefined || latest.noticeVersion === requiredNoticeVersion);
  return Object.freeze({purpose, granted, noticeVersion: latest?.noticeVersion ?? null,
    decidedAt: latest?.recordedAt ?? null, chainValid});
}

/**
 * Records a consent decision. Subjects record their own decisions with `consent:record`;
 * staff recording on behalf of a subject (for example by phone) need `consent:manage`
 * and must use the `support` channel.
 */
export async function recordConsent(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly requestKey: string; readonly subjectId: string;
    readonly purpose: ConsentPurpose; readonly decision: ConsentDecision;
    readonly noticeVersion: string; readonly channel: ConsentChannel},
  options: ConsentLedgerOptions): Promise<ConsentLedgerResult> {
  try {
    const onBehalf = request.subjectId !== input.subjectId;
    const authorization = await authorizeAndAuditOrganizationAction(
      request, state, onBehalf ? 'consent.record.on-behalf' : 'consent.record', options.audit);
    const now = options.now();
    if (!authorization.authorized ||
      request.requiredPermission !== (onBehalf ? 'consent:manage' : 'consent:record') ||
      (onBehalf && input.channel !== 'support') ||
      contractVersion !== CONSENT_LEDGER_CONTRACT_VERSION || !integer(now, 0, DATE) ||
      !ID.test(input.requestKey) || !ID.test(input.subjectId) ||
      !CONSENT_PURPOSES.includes(input.purpose) ||
      (input.decision !== 'granted' && input.decision !== 'withdrawn') ||
      !VERSION.test(input.noticeVersion) || !CHANNELS.includes(input.channel)) return rejected();
    const organizationId = authorization.organizationId;
    const [head, replay] = await Promise.all([
      options.store.getHead(organizationId, input.subjectId),
      options.store.getByRequestKey(organizationId, input.requestKey),
    ]);
    if (replay !== null) {
      return structurallyValid(replay) && replay.organizationId === organizationId &&
        replay.subjectId === input.subjectId && replay.purpose === input.purpose &&
        replay.decision === input.decision && replay.noticeVersion === input.noticeVersion &&
        replay.channel === input.channel &&
        replay.recordedBySubjectId === authorization.subjectId
        ? {accepted: true, value: replay, replayed: true} : rejected();
    }
    if (head !== null && (!structurallyValid(head) || head.organizationId !== organizationId ||
      head.subjectId !== input.subjectId || head.recordedAt > now)) return rejected();
    const entryId = options.createOpaqueId();
    const unsigned = {
      entryId, organizationId, subjectId: input.subjectId,
      sequence: head === null ? 1 : head.sequence + 1, requestKey: input.requestKey,
      purpose: input.purpose, decision: input.decision, noticeVersion: input.noticeVersion,
      channel: input.channel, recordedBySubjectId: authorization.subjectId, recordedAt: now,
      previousHash: head === null ? CONSENT_GENESIS_HASH : head.entryHash,
    };
    const entry: ConsentEntry = Object.freeze({...unsigned,
      entryHash: options.sha256(canonicalConsentPayload(unsigned))});
    return structurallyValid(entry) && await options.store.append(head, entry)
      ? {accepted: true, value: entry, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
