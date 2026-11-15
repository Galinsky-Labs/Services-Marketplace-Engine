import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const RESEARCH_SOURCING_CONTRACT_VERSION = 1 as const;
export const RESEARCH_SOURCING_REJECTED = 'research_sourcing_rejected' as const;

export type ResearchSourceLicense = 'public-record' | 'open-license' | 'permission-granted';
export type ResearchClaimType =
  | 'license' | 'certification' | 'business-registration' | 'sanction' | 'other';

export interface ResearchOperator {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

/** A public, professionally maintained source (for example a licensing board register). */
export interface ResearchSource {
  readonly sourceId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly sourceKey: string;
  readonly publisherName: string;
  readonly origin: string;
  readonly allowedPathPrefixes: readonly string[];
  readonly license: ResearchSourceLicense;
  readonly retentionDays: number;
  readonly status: 'active' | 'retired';
  readonly revision: number;
  readonly actorSubjectId: string;
  readonly registeredAt: number;
}

/** An unverified, cited observation. Findings never approve credentials on their own. */
export interface ResearchFinding {
  readonly findingId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly providerOrganizationId: string;
  readonly sourceUrl: string;
  readonly retrievedAt: number;
  readonly contentDigest: string;
  readonly excerpt: string;
  readonly claimType: ResearchClaimType;
  readonly claimValue: string;
  readonly verification: 'unverified';
  readonly expiresAt: number;
  readonly actorSubjectId: string;
  readonly recordedAt: number;
}

export interface RegisterResearchSourceInput {
  readonly requestKey: string;
  readonly sourceKey: string;
  readonly publisherName: string;
  readonly baseUrl: string;
  readonly allowedPathPrefixes: readonly string[];
  readonly license: ResearchSourceLicense;
  readonly retentionDays: number;
  readonly status: 'active' | 'retired';
  readonly expectedRevision: number;
}

export interface RecordResearchFindingInput {
  readonly requestKey: string;
  readonly sourceKey: string;
  readonly providerOrganizationId: string;
  readonly sourceUrl: string;
  readonly retrievedAt: number;
  readonly contentDigest: string;
  readonly excerpt: string;
  readonly claimType: ResearchClaimType;
  readonly claimValue: string;
}

export interface ResearchSourcingStore {
  getOperator(organizationId: string, subjectId: string): Promise<ResearchOperator | null>;
  getSource(organizationId: string, sourceKey: string): Promise<ResearchSource | null>;
  getSourceByRequestKey(organizationId: string, requestKey: string):
    Promise<ResearchSource | null>;
  commitSource(current: ResearchSource | null, next: ResearchSource): Promise<boolean>;
  providerExists(organizationId: string, providerOrganizationId: string): Promise<boolean>;
  getFindingByRequestKey(organizationId: string, requestKey: string):
    Promise<ResearchFinding | null>;
  createFinding(finding: ResearchFinding): Promise<boolean>;
}

export interface ResearchSourcingOptions {
  readonly store: ResearchSourcingStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type ResearchSourcingResult<T> =
  | {readonly accepted: true; readonly value: T; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof RESEARCH_SOURCING_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,15}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PREFIX = /^\/[A-Za-z0-9._~\/-]{0,199}$/;
const DATE = 8_640_000_000_000_000;
const DAY = 86_400_000;
const LICENSES: readonly string[] = ['public-record', 'open-license', 'permission-granted'];
const CLAIMS: readonly string[] =
  ['license', 'certification', 'business-registration', 'sanction', 'other'];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /\+?\(?\d[\d\s().-]{8,}\d/g;
const NATIONAL_ID = /\b\d{3}-\d{2}-\d{4}\b/;
const rejected = <T>(): ResearchSourcingResult<T> =>
  ({accepted: false, code: RESEARCH_SOURCING_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const text = (value: string, maximum: number): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

/**
 * Returns true only for hosts that are plausibly public internet names. Literal IP
 * addresses, single-label names, localhost and internal suffixes are refused so the
 * research boundary cannot be turned into a server-side request forgery primitive.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.length === 0 || host.length > 253 || !host.includes('.')) return false;
  if (/^[0-9.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return false;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host))
    return false;
  return host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function parsePublicHttpsUrl(value: string): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    (url.port !== '' && url.port !== '443') || !isPublicHostname(url.hostname)) return null;
  return url;
}

/** Rejects excerpts that carry direct personal contact or national identifiers. */
export function containsPersonalIdentifiers(value: string): boolean {
  return EMAIL.test(value) || NATIONAL_ID.test(value) ||
    (value.match(PHONE) ?? []).some(run => run.replace(/\D/g, '').length >= 10);
}

function validSource(value: ResearchSource | null, organizationId: string):
  value is ResearchSource {
  return value?.organizationId === organizationId && ID.test(value.sourceId) &&
    ID.test(value.requestKey) && KEY.test(value.sourceKey) && text(value.publisherName, 200) &&
    parsePublicHttpsUrl(value.origin)?.origin === value.origin &&
    Array.isArray(value.allowedPathPrefixes) && value.allowedPathPrefixes.length > 0 &&
    value.allowedPathPrefixes.length <= 16 &&
    value.allowedPathPrefixes.every(prefix => PREFIX.test(prefix) && !prefix.includes('..')) &&
    LICENSES.includes(value.license) && integer(value.retentionDays, 1, 3650) &&
    (value.status === 'active' || value.status === 'retired') &&
    integer(value.revision, 1, Number.MAX_SAFE_INTEGER) && ID.test(value.actorSubjectId) &&
    integer(value.registeredAt, 0, DATE);
}

async function operatorFor(options: ResearchSourcingOptions, organizationId: string,
  subjectId: string, permission: string): Promise<boolean> {
  const operator = await options.store.getOperator(organizationId, subjectId);
  return operator?.organizationId === organizationId && operator.subjectId === subjectId &&
    operator.status === 'active' && operator.permissions.includes(permission);
}

export async function registerResearchSource(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: RegisterResearchSourceInput,
  options: ResearchSourcingOptions): Promise<ResearchSourcingResult<ResearchSource>> {
  try {
    const authorization = await authorizeAndAuditOrganizationAction(
      request, state, 'research.source.register', options.audit);
    const now = options.now();
    const base = parsePublicHttpsUrl(input.baseUrl);
    if (!authorization.authorized || request.requiredPermission !== 'research:sources:write' ||
      contractVersion !== RESEARCH_SOURCING_CONTRACT_VERSION || base === null ||
      !ID.test(input.requestKey) || !KEY.test(input.sourceKey) ||
      !text(input.publisherName, 200) || !Array.isArray(input.allowedPathPrefixes) ||
      input.allowedPathPrefixes.length === 0 || input.allowedPathPrefixes.length > 16 ||
      new Set(input.allowedPathPrefixes).size !== input.allowedPathPrefixes.length ||
      !input.allowedPathPrefixes.every(prefix => PREFIX.test(prefix) && !prefix.includes('..')) ||
      !LICENSES.includes(input.license) || !integer(input.retentionDays, 1, 3650) ||
      (input.status !== 'active' && input.status !== 'retired') ||
      !integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) ||
      !integer(now, 0, DATE)) return rejected();
    const organizationId = authorization.organizationId;
    if (!await operatorFor(options, organizationId, authorization.subjectId,
      'research:sources:write')) return rejected();
    const [current, replay] = await Promise.all([
      options.store.getSource(organizationId, input.sourceKey),
      options.store.getSourceByRequestKey(organizationId, input.requestKey),
    ]);
    if (replay !== null) {
      return validSource(replay, organizationId) &&
        replay.actorSubjectId === authorization.subjectId &&
        replay.sourceKey === input.sourceKey && replay.origin === base.origin &&
        replay.revision === input.expectedRevision + 1 && replay.status === input.status &&
        replay.license === input.license && replay.retentionDays === input.retentionDays &&
        replay.allowedPathPrefixes.join('\n') === input.allowedPathPrefixes.join('\n')
        ? {accepted: true, value: replay, replayed: true} : rejected();
    }
    if ((current === null && input.expectedRevision !== 0) || (current !== null &&
      (!validSource(current, organizationId) || current.revision !== input.expectedRevision ||
        current.registeredAt > now))) return rejected();
    const sourceId = options.createOpaqueId();
    const next: ResearchSource = Object.freeze({
      sourceId, organizationId, requestKey: input.requestKey, sourceKey: input.sourceKey,
      publisherName: input.publisherName.trim(), origin: base.origin,
      allowedPathPrefixes: Object.freeze([...input.allowedPathPrefixes]),
      license: input.license, retentionDays: input.retentionDays, status: input.status,
      revision: input.expectedRevision + 1, actorSubjectId: authorization.subjectId,
      registeredAt: now,
    });
    return validSource(next, organizationId) && await options.store.commitSource(current, next)
      ? {accepted: true, value: next, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

export function sourceAllowsUrl(source: ResearchSource, candidate: string): boolean {
  const url = parsePublicHttpsUrl(candidate);
  if (url === null || url.origin !== source.origin || url.hash !== '') return false;
  const decoded = (() => { try { return decodeURIComponent(url.pathname); } catch { return null; } })();
  if (decoded === null || decoded.includes('..')) return false;
  return source.allowedPathPrefixes.some(prefix => url.pathname.startsWith(prefix));
}

export async function recordResearchFinding(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: RecordResearchFindingInput,
  options: ResearchSourcingOptions): Promise<ResearchSourcingResult<ResearchFinding>> {
  try {
    const authorization = await authorizeAndAuditOrganizationAction(
      request, state, 'research.finding.record', options.audit);
    const now = options.now();
    if (!authorization.authorized || request.requiredPermission !== 'research:findings:write' ||
      contractVersion !== RESEARCH_SOURCING_CONTRACT_VERSION || !integer(now, 0, DATE) ||
      !ID.test(input.requestKey) || !KEY.test(input.sourceKey) ||
      !ID.test(input.providerOrganizationId) || !integer(input.retrievedAt, 0, now) ||
      now - input.retrievedAt > 30 * DAY || !DIGEST.test(input.contentDigest) ||
      !text(input.excerpt, 1000) || containsPersonalIdentifiers(input.excerpt) ||
      !CLAIMS.includes(input.claimType) || !text(input.claimValue, 200) ||
      containsPersonalIdentifiers(input.claimValue)) return rejected();
    const organizationId = authorization.organizationId;
    if (!await operatorFor(options, organizationId, authorization.subjectId,
      'research:findings:write')) return rejected();
    const [source, replay, providerExists] = await Promise.all([
      options.store.getSource(organizationId, input.sourceKey),
      options.store.getFindingByRequestKey(organizationId, input.requestKey),
      options.store.providerExists(organizationId, input.providerOrganizationId),
    ]);
    if (!validSource(source, organizationId) || source.status !== 'active' ||
      !providerExists || !sourceAllowsUrl(source, input.sourceUrl)) return rejected();
    if (replay !== null) {
      return replay.organizationId === organizationId && replay.requestKey === input.requestKey &&
        replay.actorSubjectId === authorization.subjectId &&
        replay.sourceKey === input.sourceKey && replay.sourceUrl === input.sourceUrl &&
        replay.contentDigest === input.contentDigest && replay.claimType === input.claimType &&
        replay.claimValue === input.claimValue &&
        replay.providerOrganizationId === input.providerOrganizationId
        ? {accepted: true, value: replay, replayed: true} : rejected();
    }
    const findingId = options.createOpaqueId();
    if (!ID.test(findingId)) return rejected();
    const finding: ResearchFinding = Object.freeze({
      findingId, organizationId, requestKey: input.requestKey, sourceId: source.sourceId,
      sourceKey: source.sourceKey, providerOrganizationId: input.providerOrganizationId,
      sourceUrl: input.sourceUrl, retrievedAt: input.retrievedAt,
      contentDigest: input.contentDigest, excerpt: input.excerpt.trim(),
      claimType: input.claimType, claimValue: input.claimValue.trim(),
      verification: 'unverified', expiresAt: now + source.retentionDays * DAY,
      actorSubjectId: authorization.subjectId, recordedAt: now,
    });
    return await options.store.createFinding(finding)
      ? {accepted: true, value: finding, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

/** Returns only unexpired findings for the provider, newest first, as detached values. */
export function selectActiveResearchFindings(findings: readonly ResearchFinding[],
  organizationId: string, providerOrganizationId: string, now: number): readonly ResearchFinding[] {
  if (!Array.isArray(findings) || !integer(now, 0, DATE)) return Object.freeze([]);
  return Object.freeze(findings
    .filter(finding => finding.organizationId === organizationId &&
      finding.providerOrganizationId === providerOrganizationId && finding.expiresAt > now &&
      finding.verification === 'unverified')
    .sort((left, right) => right.recordedAt - left.recordedAt ||
      (left.findingId < right.findingId ? -1 : 1))
    .map(finding => Object.freeze({...finding})));
}
