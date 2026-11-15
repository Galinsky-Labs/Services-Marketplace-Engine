import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const DATA_PRIVACY_CONTRACT_VERSION = 1 as const;
export const DATA_PRIVACY_REJECTED = 'data_privacy_rejected' as const;
export const PRIVACY_RESPONSE_WINDOW_MS = 30 * 86_400_000;

export type PrivacyRequestKind = 'export' | 'deletion';
export type PrivacyRequestStatus = 'received' | 'completed' | 'denied';

export interface PrivacyRequest {
  readonly privacyRequestId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly subjectId: string;
  readonly kind: PrivacyRequestKind;
  readonly status: PrivacyRequestStatus;
  readonly requestedBySubjectId: string;
  readonly receivedAt: number;
  readonly dueAt: number;
  readonly completedAt: number | null;
  readonly resultDigest: string | null;
  readonly revision: number;
}

/** A stored record as seen by privacy tooling, independent of its domain. */
export interface PrivacyRecord {
  readonly kind: string;
  readonly recordId: string;
  readonly ownerSubjectId: string | null;
  readonly createdAt: number;
  readonly legalHold: boolean;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RetentionPolicy {
  readonly kind: string;
  readonly retainDays: number;
  readonly onExpiry: 'delete' | 'anonymize';
  /** When true, a subject deletion request anonymizes instead of deleting (e.g. invoices). */
  readonly statutoryRetention: boolean;
}

export interface PrivacyAction {
  readonly kind: string;
  readonly recordId: string;
  readonly action: 'delete' | 'anonymize' | 'retain';
  readonly reason: 'retention_expired' | 'subject_request' | 'legal_hold' |
    'statutory_retention' | 'no_policy' | 'within_retention';
}

export interface PrivacyExport {
  readonly subjectId: string;
  readonly generatedAt: number;
  readonly collections: readonly {readonly kind: string;
    readonly records: readonly Readonly<Record<string, unknown>>[]}[];
  readonly recordCount: number;
}

export interface DataPrivacyStore {
  getRequest(organizationId: string, privacyRequestId: string): Promise<PrivacyRequest | null>;
  getRequestByKey(organizationId: string, requestKey: string): Promise<PrivacyRequest | null>;
  commitRequest(current: PrivacyRequest | null, next: PrivacyRequest): Promise<boolean>;
}

export interface DataPrivacyOptions {
  readonly store: DataPrivacyStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type DataPrivacyResult =
  | {readonly accepted: true; readonly value: PrivacyRequest; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof DATA_PRIVACY_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DATE = 8_640_000_000_000_000;
const DAY = 86_400_000;
const REDACTED = '[redacted]';
const SUBJECT_FIELDS = /^(subjectId|customerSubjectId|actorSubjectId|recordedBySubjectId|ownerSubjectId|createdBySubjectId|approvedBySubjectId|submittedBySubjectId|reviewedBySubjectId|requestedBySubjectId)$/;
const rejected = (): DataPrivacyResult => ({accepted: false, code: DATA_PRIVACY_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function redactOtherSubjects(value: unknown, subjectId: string, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => redactOtherSubjects(item, subjectId));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : 1)
      .map(([childKey, child]) => [childKey, redactOtherSubjects(child, subjectId, childKey)]));
  }
  if (SUBJECT_FIELDS.test(key) && typeof value === 'string' && value !== subjectId) return REDACTED;
  return value;
}

/**
 * Builds a portable export of every record owned by the subject. Identifiers of other
 * subjects inside those records are redacted; records owned by others are excluded.
 */
export function buildPrivacyExport(subjectId: string, records: readonly PrivacyRecord[],
  generatedAt: number): PrivacyExport {
  if (!ID.test(subjectId) || !integer(generatedAt, 0, DATE) || !Array.isArray(records)) {
    return Object.freeze({subjectId, generatedAt, collections: Object.freeze([]), recordCount: 0});
  }
  const owned = records.filter(record => record.ownerSubjectId === subjectId &&
    KIND.test(record.kind) && ID.test(record.recordId));
  const kinds = [...new Set(owned.map(record => record.kind))].sort();
  const collections = kinds.map(kind => Object.freeze({kind, records: Object.freeze(owned
    .filter(record => record.kind === kind)
    .sort((left, right) => left.createdAt - right.createdAt ||
      (left.recordId < right.recordId ? -1 : 1))
    .map(record => Object.freeze({recordId: record.recordId, createdAt: record.createdAt,
      data: redactOtherSubjects(record.data, subjectId)} as Record<string, unknown>)))}));
  return Object.freeze({subjectId, generatedAt, collections: Object.freeze(collections),
    recordCount: owned.length});
}

function validPolicies(policies: readonly RetentionPolicy[]): Map<string, RetentionPolicy> | null {
  if (!Array.isArray(policies)) return null;
  const map = new Map<string, RetentionPolicy>();
  for (const policy of policies) {
    if (!KIND.test(policy?.kind) || map.has(policy.kind) ||
      !integer(policy.retainDays, 1, 36_500) ||
      (policy.onExpiry !== 'delete' && policy.onExpiry !== 'anonymize') ||
      typeof policy.statutoryRetention !== 'boolean') return null;
    map.set(policy.kind, policy);
  }
  return map;
}

/**
 * Scheduled retention plan. Records without a policy are retained (no deletion without an
 * explicit rule), legal holds always win, and an invalid policy set plans nothing.
 */
export function planRetention(records: readonly PrivacyRecord[],
  policies: readonly RetentionPolicy[], now: number): readonly PrivacyAction[] {
  const map = validPolicies(policies);
  if (map === null || !integer(now, 0, DATE) || !Array.isArray(records)) return Object.freeze([]);
  return Object.freeze(records.map(record => {
    const policy = map.get(record.kind);
    const base = {kind: record.kind, recordId: record.recordId};
    if (record.legalHold) return Object.freeze({...base, action: 'retain', reason: 'legal_hold'} as PrivacyAction);
    if (!policy) return Object.freeze({...base, action: 'retain', reason: 'no_policy'} as PrivacyAction);
    if (now - record.createdAt < policy.retainDays * DAY)
      return Object.freeze({...base, action: 'retain', reason: 'within_retention'} as PrivacyAction);
    return Object.freeze({...base, action: policy.onExpiry, reason: 'retention_expired'} as PrivacyAction);
  }));
}

/**
 * Plan for a verified subject deletion request: delete owned records, but anonymize kinds
 * under statutory retention and keep records under legal hold.
 */
export function planSubjectDeletion(subjectId: string, records: readonly PrivacyRecord[],
  policies: readonly RetentionPolicy[]): readonly PrivacyAction[] {
  const map = validPolicies(policies);
  if (map === null || !ID.test(subjectId) || !Array.isArray(records)) return Object.freeze([]);
  return Object.freeze(records.filter(record => record.ownerSubjectId === subjectId)
    .map(record => {
      const base = {kind: record.kind, recordId: record.recordId};
      if (record.legalHold) return Object.freeze({...base, action: 'retain', reason: 'legal_hold'} as PrivacyAction);
      if (map.get(record.kind)?.statutoryRetention)
        return Object.freeze({...base, action: 'anonymize', reason: 'statutory_retention'} as PrivacyAction);
      return Object.freeze({...base, action: 'delete', reason: 'subject_request'} as PrivacyAction);
    }));
}

/**
 * Opens a privacy request. Subjects file their own with `privacy:request`; privacy
 * officers may file for another subject with `privacy:manage`.
 */
export async function openPrivacyRequest(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly requestKey: string; readonly subjectId: string;
    readonly kind: PrivacyRequestKind},
  options: DataPrivacyOptions): Promise<DataPrivacyResult> {
  try {
    const onBehalf = request.subjectId !== input.subjectId;
    const authorization = await authorizeAndAuditOrganizationAction(request, state,
      'privacy.request.open', options.audit);
    const now = options.now();
    if (!authorization.authorized ||
      request.requiredPermission !== (onBehalf ? 'privacy:manage' : 'privacy:request') ||
      contractVersion !== DATA_PRIVACY_CONTRACT_VERSION || !integer(now, 0, DATE) ||
      !ID.test(input.requestKey) || !ID.test(input.subjectId) ||
      (input.kind !== 'export' && input.kind !== 'deletion')) return rejected();
    const organizationId = authorization.organizationId;
    const replay = await options.store.getRequestByKey(organizationId, input.requestKey);
    if (replay !== null) {
      return replay.organizationId === organizationId && replay.subjectId === input.subjectId &&
        replay.kind === input.kind && replay.requestedBySubjectId === authorization.subjectId
        ? {accepted: true, value: replay, replayed: true} : rejected();
    }
    const privacyRequestId = options.createOpaqueId();
    if (!ID.test(privacyRequestId)) return rejected();
    const value: PrivacyRequest = Object.freeze({privacyRequestId, organizationId,
      requestKey: input.requestKey, subjectId: input.subjectId, kind: input.kind,
      status: 'received', requestedBySubjectId: authorization.subjectId, receivedAt: now,
      dueAt: now + PRIVACY_RESPONSE_WINDOW_MS, completedAt: null, resultDigest: null,
      revision: 1});
    return await options.store.commitRequest(null, value)
      ? {accepted: true, value, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

/** Completes or denies a request; only privacy officers (`privacy:manage`) may do so. */
export async function completePrivacyRequest(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly privacyRequestId: string; readonly outcome: 'completed' | 'denied';
    readonly resultDigest: string | null; readonly expectedRevision: number},
  options: DataPrivacyOptions): Promise<DataPrivacyResult> {
  try {
    const authorization = await authorizeAndAuditOrganizationAction(request, state,
      'privacy.request.complete', options.audit);
    const now = options.now();
    if (!authorization.authorized || request.requiredPermission !== 'privacy:manage' ||
      contractVersion !== DATA_PRIVACY_CONTRACT_VERSION || !integer(now, 0, DATE) ||
      !ID.test(input.privacyRequestId) ||
      (input.outcome !== 'completed' && input.outcome !== 'denied') ||
      (input.outcome === 'completed') !== (input.resultDigest !== null) ||
      (input.resultDigest !== null && !DIGEST.test(input.resultDigest)) ||
      !integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1)) return rejected();
    const current = await options.store.getRequest(authorization.organizationId,
      input.privacyRequestId);
    if (current?.organizationId !== authorization.organizationId ||
      current.privacyRequestId !== input.privacyRequestId || current.status !== 'received' ||
      current.revision !== input.expectedRevision || current.receivedAt > now) return rejected();
    const next: PrivacyRequest = Object.freeze({...current, status: input.outcome,
      completedAt: now, resultDigest: input.resultDigest, revision: current.revision + 1});
    return await options.store.commitRequest(current, next)
      ? {accepted: true, value: next, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
