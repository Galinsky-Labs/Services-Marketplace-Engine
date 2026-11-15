import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const RETRIEVAL_GROUNDING_CONTRACT_VERSION = 1 as const;
export const RETRIEVAL_GROUNDING_REJECTED = 'retrieval_grounding_rejected' as const;

/** A tenant-bound, published passage that answers may cite. */
export interface KnowledgeChunk {
  readonly organizationId: string;
  readonly chunkId: string;
  readonly sourceKey: string;
  readonly text: string;
  readonly status: 'published' | 'retired';
  readonly revision: number;
}

export interface RetrievedChunk {
  readonly chunkId: string;
  readonly sourceKey: string;
  readonly score: number;
  readonly text: string;
}

export interface AnswerCitation {
  readonly chunkId: string;
  readonly quote: string;
}

export type GroundingVerdict = 'grounded' | 'partially_grounded' | 'ungrounded';

export interface GroundingReport {
  readonly verdict: GroundingVerdict;
  readonly supportedCitations: readonly AnswerCitation[];
  readonly rejectedCitations: readonly {readonly citation: AnswerCitation;
    readonly reason: 'unknown_chunk' | 'suppressed_chunk' | 'quote_not_found' | 'malformed'}[];
  readonly coverage: number;
}

export type CorrectionType = 'incorrect' | 'outdated' | 'missing-citation' | 'unsafe';

export interface GroundingCorrection {
  readonly correctionId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly answerId: string;
  readonly chunkId: string;
  readonly correctionType: CorrectionType;
  readonly note: string;
  readonly status: 'submitted' | 'accepted' | 'rejected';
  readonly submittedBySubjectId: string;
  readonly reviewedBySubjectId: string | null;
  readonly revision: number;
  readonly submittedAt: number;
  readonly reviewedAt: number | null;
}

export interface GroundingCorrectionStore {
  getChunk(organizationId: string, chunkId: string): Promise<KnowledgeChunk | null>;
  getCorrection(organizationId: string, correctionId: string):
    Promise<GroundingCorrection | null>;
  getCorrectionByRequestKey(organizationId: string, requestKey: string):
    Promise<GroundingCorrection | null>;
  commitCorrection(current: GroundingCorrection | null,
    next: GroundingCorrection): Promise<boolean>;
}

export interface GroundingCorrectionOptions {
  readonly store: GroundingCorrectionStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type GroundingCorrectionResult =
  | {readonly accepted: true; readonly value: GroundingCorrection; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof RETRIEVAL_GROUNDING_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE = 8_640_000_000_000_000;
const SUPPRESSING: readonly CorrectionType[] = ['incorrect', 'outdated', 'unsafe'];
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your', 'do', 'does', 'can']);
const rejected = (): GroundingCorrectionResult =>
  ({accepted: false, code: RETRIEVAL_GROUNDING_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export function tokenize(value: string): readonly string[] {
  return value.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

const normalizeQuote = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

function validChunk(chunk: KnowledgeChunk, organizationId: string): boolean {
  return chunk?.organizationId === organizationId && ID.test(chunk.chunkId) &&
    typeof chunk.text === 'string' && chunk.text.length > 0 && chunk.text.length <= 20_000 &&
    chunk.status === 'published' && integer(chunk.revision, 1, Number.MAX_SAFE_INTEGER);
}

/**
 * Deterministic lexical retrieval (BM25) over published tenant chunks. Chunks named in
 * `suppressedChunkIds` (accepted corrections) are never returned. Ties break on chunk id.
 */
export function retrieveChunks(organizationId: string, query: string,
  chunks: readonly KnowledgeChunk[], limit: number,
  suppressedChunkIds: ReadonlySet<string> = new Set()): readonly RetrievedChunk[] {
  if (!ID.test(organizationId) || typeof query !== 'string' || query.length > 2_000 ||
    !integer(limit, 1, 50) || !Array.isArray(chunks)) return Object.freeze([]);
  const terms = [...new Set(tokenize(query))];
  const eligible = chunks.filter(chunk => validChunk(chunk, organizationId) &&
    !suppressedChunkIds.has(chunk.chunkId));
  if (terms.length === 0 || eligible.length === 0) return Object.freeze([]);
  const documents = eligible.map(chunk => ({chunk, tokens: tokenize(chunk.text)}));
  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) /
    documents.length || 1;
  const k1 = 1.2;
  const b = 0.75;
  const scored = documents.map(({chunk, tokens}) => {
    let score = 0;
    for (const term of terms) {
      const frequency = tokens.filter(token => token === term).length;
      if (frequency === 0) continue;
      const containing = documents.filter(document => document.tokens.includes(term)).length;
      const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
      score += idf * (frequency * (k1 + 1)) /
        (frequency + k1 * (1 - b + b * tokens.length / averageLength));
    }
    return {chunk, score: Math.round(score * 1_000_000) / 1_000_000};
  });
  return Object.freeze(scored.filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score ||
      (left.chunk.chunkId < right.chunk.chunkId ? -1 : 1))
    .slice(0, limit)
    .map(entry => Object.freeze({chunkId: entry.chunk.chunkId, sourceKey: entry.chunk.sourceKey,
      score: entry.score, text: entry.chunk.text})));
}

/**
 * Verifies every citation quote appears verbatim (whitespace and case-insensitive) in a
 * published, unsuppressed tenant chunk. Coverage is the share of answer sentences that
 * contain at least one supported quote. Anything unverifiable lowers the verdict.
 */
export function verifyGrounding(organizationId: string, answerText: string,
  citations: readonly AnswerCitation[], chunks: readonly KnowledgeChunk[],
  suppressedChunkIds: ReadonlySet<string> = new Set()): GroundingReport {
  const supported: AnswerCitation[] = [];
  const rejectedCitations: {citation: AnswerCitation;
    reason: 'unknown_chunk' | 'suppressed_chunk' | 'quote_not_found' | 'malformed'}[] = [];
  const byId = new Map(chunks.filter(chunk => validChunk(chunk, organizationId))
    .map(chunk => [chunk.chunkId, chunk]));
  for (const citation of Array.isArray(citations) ? citations.slice(0, 64) : []) {
    if (!citation || !ID.test(citation.chunkId) || typeof citation.quote !== 'string' ||
      normalizeQuote(citation.quote).length < 8 || citation.quote.length > 1_000) {
      rejectedCitations.push({citation, reason: 'malformed'}); continue;
    }
    if (suppressedChunkIds.has(citation.chunkId)) {
      rejectedCitations.push({citation, reason: 'suppressed_chunk'}); continue;
    }
    const chunk = byId.get(citation.chunkId);
    if (!chunk) { rejectedCitations.push({citation, reason: 'unknown_chunk'}); continue; }
    if (!normalizeQuote(chunk.text).includes(normalizeQuote(citation.quote))) {
      rejectedCitations.push({citation, reason: 'quote_not_found'}); continue;
    }
    supported.push(Object.freeze({chunkId: citation.chunkId, quote: citation.quote}));
  }
  const sentences = (typeof answerText === 'string' ? answerText : '')
    .split(/(?<=[.!?])\s+/).map(normalizeQuote).filter(sentence => sentence.length > 0);
  const covered = sentences.filter(sentence => supported.some(citation => {
    const quote = normalizeQuote(citation.quote);
    return sentence.includes(quote) || quote.includes(sentence) ||
      tokenize(sentence).filter(token => tokenize(quote).includes(token)).length >=
        Math.max(2, Math.ceil(tokenize(sentence).length * 0.6));
  })).length;
  const coverage = sentences.length === 0 ? 0 : Math.round(covered / sentences.length * 1000) / 1000;
  const verdict: GroundingVerdict = supported.length === 0 || coverage === 0 ? 'ungrounded'
    : rejectedCitations.length === 0 && coverage === 1 ? 'grounded' : 'partially_grounded';
  return Object.freeze({verdict, supportedCitations: Object.freeze(supported),
    rejectedCitations: Object.freeze(rejectedCitations.map(entry => Object.freeze(entry))),
    coverage});
}

/** Chunk ids removed from retrieval by accepted suppressing corrections. */
export function suppressedChunkIds(organizationId: string,
  corrections: readonly GroundingCorrection[]): ReadonlySet<string> {
  return new Set(corrections.filter(correction => correction.organizationId === organizationId &&
    correction.status === 'accepted' && SUPPRESSING.includes(correction.correctionType))
    .map(correction => correction.chunkId));
}

export async function submitGroundingCorrection(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly requestKey: string; readonly answerId: string; readonly chunkId: string;
    readonly correctionType: CorrectionType; readonly note: string},
  options: GroundingCorrectionOptions): Promise<GroundingCorrectionResult> {
  try {
    const authorization = await authorizeAndAuditOrganizationAction(
      request, state, 'ai.grounding.correction.submit', options.audit);
    const now = options.now();
    if (!authorization.authorized || request.requiredPermission !== 'ai-grounding:correct' ||
      contractVersion !== RETRIEVAL_GROUNDING_CONTRACT_VERSION || !integer(now, 0, DATE) ||
      !ID.test(input.requestKey) || !ID.test(input.answerId) || !ID.test(input.chunkId) ||
      !['incorrect', 'outdated', 'missing-citation', 'unsafe'].includes(input.correctionType) ||
      typeof input.note !== 'string' || input.note.trim().length === 0 ||
      input.note.length > 2_000) return rejected();
    const organizationId = authorization.organizationId;
    const [chunk, replay] = await Promise.all([
      options.store.getChunk(organizationId, input.chunkId),
      options.store.getCorrectionByRequestKey(organizationId, input.requestKey),
    ]);
    if (chunk?.organizationId !== organizationId || chunk.chunkId !== input.chunkId)
      return rejected();
    if (replay !== null) {
      return replay.organizationId === organizationId &&
        replay.submittedBySubjectId === authorization.subjectId &&
        replay.answerId === input.answerId && replay.chunkId === input.chunkId &&
        replay.correctionType === input.correctionType && replay.note === input.note.trim()
        ? {accepted: true, value: replay, replayed: true} : rejected();
    }
    const correctionId = options.createOpaqueId();
    if (!ID.test(correctionId)) return rejected();
    const value: GroundingCorrection = Object.freeze({
      correctionId, organizationId, requestKey: input.requestKey, answerId: input.answerId,
      chunkId: input.chunkId, correctionType: input.correctionType, note: input.note.trim(),
      status: 'submitted', submittedBySubjectId: authorization.subjectId,
      reviewedBySubjectId: null, revision: 1, submittedAt: now, reviewedAt: null,
    });
    return await options.store.commitCorrection(null, value)
      ? {accepted: true, value, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

/** Reviewers cannot decide their own submissions (separation of duties). */
export async function reviewGroundingCorrection(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly correctionId: string; readonly decision: 'accepted' | 'rejected';
    readonly expectedRevision: number},
  options: GroundingCorrectionOptions): Promise<GroundingCorrectionResult> {
  try {
    const authorization = await authorizeAndAuditOrganizationAction(
      request, state, 'ai.grounding.correction.review', options.audit);
    const now = options.now();
    if (!authorization.authorized || request.requiredPermission !== 'ai-grounding:review' ||
      contractVersion !== RETRIEVAL_GROUNDING_CONTRACT_VERSION || !integer(now, 0, DATE) ||
      !ID.test(input.correctionId) ||
      (input.decision !== 'accepted' && input.decision !== 'rejected') ||
      !integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1)) return rejected();
    const current = await options.store.getCorrection(authorization.organizationId,
      input.correctionId);
    if (current?.organizationId !== authorization.organizationId ||
      current.correctionId !== input.correctionId || current.status !== 'submitted' ||
      current.revision !== input.expectedRevision || current.submittedAt > now ||
      current.submittedBySubjectId === authorization.subjectId) return rejected();
    const next: GroundingCorrection = Object.freeze({...current, status: input.decision,
      reviewedBySubjectId: authorization.subjectId, revision: current.revision + 1,
      reviewedAt: now});
    return await options.store.commitCorrection(current, next)
      ? {accepted: true, value: next, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
