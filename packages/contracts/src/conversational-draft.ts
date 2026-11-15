import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const CONVERSATIONAL_DRAFT_CONTRACT_VERSION = 1 as const;
export const CONVERSATIONAL_DRAFT_REJECTED = 'conversational_draft_rejected' as const;

export type DraftValue = string | number | boolean;
export type ExtractionSource = 'ai-provider' | 'deterministic-fallback';

export interface ConversationTurn {
  readonly role: 'customer' | 'assistant';
  readonly text: string;
}

/**
 * A structured service-request draft assembled from a conversation. Assistants may
 * propose drafts, but only the owning customer can approve one; approval never submits
 * a lead by itself.
 */
export interface ConversationalRequestDraft {
  readonly draftId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly customerSubjectId: string;
  readonly serviceKey: string;
  readonly fields: Readonly<Record<string, DraftValue>>;
  readonly missingFieldKeys: readonly string[];
  readonly turnCount: number;
  readonly extractionSource: ExtractionSource;
  readonly status: 'pending_approval' | 'approved' | 'rejected';
  readonly revision: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
}

export interface DraftFieldSpec {
  readonly key: string;
  readonly type: 'text' | 'number' | 'boolean' | 'date' | 'postal-code';
  readonly required: boolean;
}

export interface ConversationalDraftStore {
  getDraft(organizationId: string, draftId: string): Promise<ConversationalRequestDraft | null>;
  getDraftByRequestKey(organizationId: string, requestKey: string):
    Promise<ConversationalRequestDraft | null>;
  commitDraft(current: ConversationalRequestDraft | null,
    next: ConversationalRequestDraft): Promise<boolean>;
}

export interface ConversationalDraftOptions {
  readonly store: ConversationalDraftStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
  readonly draftTtlMs?: number;
}

export type ConversationalDraftResult =
  | {readonly accepted: true; readonly value: ConversationalRequestDraft;
      readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof CONVERSATIONAL_DRAFT_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,15}$/;
const FIELD = /^[a-z][a-zA-Z0-9]{0,63}$/;
const DATE = 8_640_000_000_000_000;
const DEFAULT_TTL = 7 * 86_400_000;
const rejected = (): ConversationalDraftResult =>
  ({accepted: false, code: CONVERSATIONAL_DRAFT_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function validSpecs(specs: readonly DraftFieldSpec[]): boolean {
  return Array.isArray(specs) && specs.length > 0 && specs.length <= 64 &&
    new Set(specs.map(spec => spec.key)).size === specs.length &&
    specs.every(spec => FIELD.test(spec.key) && typeof spec.required === 'boolean' &&
      ['text', 'number', 'boolean', 'date', 'postal-code'].includes(spec.type));
}

function validValue(spec: DraftFieldSpec, value: DraftValue): boolean {
  switch (spec.type) {
  case 'text': return typeof value === 'string' && value.trim().length > 0 && value.length <= 2_000;
  case 'number': return typeof value === 'number' && Number.isFinite(value) &&
    Math.abs(value) <= 1_000_000_000;
  case 'boolean': return typeof value === 'boolean';
  case 'date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
  case 'postal-code': return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$/.test(value);
  }
}

function validTurns(turns: readonly ConversationTurn[]): boolean {
  return Array.isArray(turns) && turns.length > 0 && turns.length <= 100 &&
    turns.every(turn => (turn.role === 'customer' || turn.role === 'assistant') &&
      typeof turn.text === 'string' && turn.text.length > 0 && turn.text.length <= 4_000) &&
    turns.some(turn => turn.role === 'customer');
}

/**
 * Deterministic fallback extractor used when no AI provider is configured. It only reads
 * customer turns and recognizes explicit `field: value` statements, ISO dates and postal
 * codes. It never invents values: unrecognized required fields stay missing.
 */
export function extractDraftFieldsDeterministic(turns: readonly ConversationTurn[],
  specs: readonly DraftFieldSpec[]): Readonly<Record<string, DraftValue>> {
  if (!validTurns(turns) || !validSpecs(specs)) return Object.freeze({});
  const fields: Record<string, DraftValue> = {};
  const customerText = turns.filter(turn => turn.role === 'customer').map(turn => turn.text);
  for (const spec of specs) {
    const label = spec.key.replace(/([A-Z])/g, ' $1').toLowerCase();
    const labelPattern = new RegExp(
      `(?:^|[\\n;,.])\\s*(?:${spec.key.toLowerCase()}|${label})\\s*[:=]\\s*([^\\n;]+)`, 'i');
    for (const text of customerText) {
      const match = labelPattern.exec(text);
      let candidate: DraftValue | undefined;
      if (match?.[1] !== undefined) {
        const raw = match[1].trim().replace(/[.,]+$/, '');
        candidate = spec.type === 'number' ? Number(raw.replace(/[^0-9.-]/g, ''))
          : spec.type === 'boolean' ? /^(yes|true|y)$/i.test(raw) ? true
            : /^(no|false|n)$/i.test(raw) ? false : undefined
            : raw;
      } else if (spec.type === 'date') {
        candidate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
      } else if (spec.type === 'postal-code' && /postal|zip/i.test(spec.key)) {
        candidate = /\b(\d{5})(?:-\d{4})?\b/.exec(text)?.[1];
      }
      if (candidate !== undefined && validValue(spec, candidate)) fields[spec.key] = candidate;
    }
  }
  return Object.freeze(fields);
}

export async function createConversationalDraft(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly requestKey: string; readonly serviceKey: string;
    readonly fieldSpecs: readonly DraftFieldSpec[]; readonly turns: readonly ConversationTurn[];
    readonly proposedFields: Readonly<Record<string, DraftValue>>;
    readonly extractionSource: ExtractionSource},
  options: ConversationalDraftOptions): Promise<ConversationalDraftResult> {
  try {
    const authorization = await authorizeAndAuditOrganizationAction(
      request, state, 'request-draft.create', options.audit);
    const now = options.now();
    const ttl = options.draftTtlMs ?? DEFAULT_TTL;
    if (!authorization.authorized || request.requiredPermission !== 'request-drafts:create' ||
      contractVersion !== CONVERSATIONAL_DRAFT_CONTRACT_VERSION || !integer(now, 0, DATE) ||
      !integer(ttl, 60_000, 30 * 86_400_000) || !ID.test(input.requestKey) ||
      !KEY.test(input.serviceKey) || !validSpecs(input.fieldSpecs) || !validTurns(input.turns) ||
      (input.extractionSource !== 'ai-provider' &&
        input.extractionSource !== 'deterministic-fallback') ||
      typeof input.proposedFields !== 'object' || input.proposedFields === null) return rejected();
    const specs = new Map(input.fieldSpecs.map(spec => [spec.key, spec]));
    const entries = Object.entries(input.proposedFields);
    // Unknown or invalid proposed values are a contaminated extraction: fail closed.
    if (entries.length > 64 || entries.some(([key, value]) => {
      const spec = specs.get(key);
      return spec === undefined || !validValue(spec, value);
    })) return rejected();
    const organizationId = authorization.organizationId;
    const replay = await options.store.getDraftByRequestKey(organizationId, input.requestKey);
    const fields = Object.freeze(Object.fromEntries(entries.sort(([left], [right]) =>
      left < right ? -1 : 1).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])));
    const missingFieldKeys = Object.freeze(input.fieldSpecs
      .filter(spec => spec.required && !(spec.key in fields)).map(spec => spec.key).sort());
    if (replay !== null) {
      return replay.organizationId === organizationId &&
        replay.customerSubjectId === authorization.subjectId &&
        replay.serviceKey === input.serviceKey &&
        JSON.stringify(replay.fields) === JSON.stringify(fields)
        ? {accepted: true, value: replay, replayed: true} : rejected();
    }
    const draftId = options.createOpaqueId();
    if (!ID.test(draftId)) return rejected();
    const value: ConversationalRequestDraft = Object.freeze({
      draftId, organizationId, requestKey: input.requestKey,
      customerSubjectId: authorization.subjectId, serviceKey: input.serviceKey, fields,
      missingFieldKeys, turnCount: input.turns.length, extractionSource: input.extractionSource,
      status: 'pending_approval', revision: 1, createdAt: now, expiresAt: now + ttl,
      decidedAt: null,
    });
    return await options.store.commitDraft(null, value)
      ? {accepted: true, value, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

export async function decideConversationalDraft(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly draftId: string; readonly decision: 'approve' | 'reject';
    readonly expectedRevision: number},
  options: ConversationalDraftOptions): Promise<ConversationalDraftResult> {
  try {
    const authorization = await authorizeAndAuditOrganizationAction(
      request, state, 'request-draft.decide', options.audit);
    const now = options.now();
    if (!authorization.authorized || request.requiredPermission !== 'request-drafts:create' ||
      contractVersion !== CONVERSATIONAL_DRAFT_CONTRACT_VERSION || !integer(now, 0, DATE) ||
      !ID.test(input.draftId) || (input.decision !== 'approve' && input.decision !== 'reject') ||
      !integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1)) return rejected();
    const current = await options.store.getDraft(authorization.organizationId, input.draftId);
    if (current?.organizationId !== authorization.organizationId ||
      current.draftId !== input.draftId ||
      current.customerSubjectId !== authorization.subjectId ||
      current.status !== 'pending_approval' || current.revision !== input.expectedRevision ||
      now >= current.expiresAt || current.createdAt > now ||
      (input.decision === 'approve' && current.missingFieldKeys.length > 0)) return rejected();
    const next: ConversationalRequestDraft = Object.freeze({...current,
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      revision: current.revision + 1, decidedAt: now});
    return await options.store.commitDraft(current, next)
      ? {accepted: true, value: next, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
