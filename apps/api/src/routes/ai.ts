import {
  AI_GATEWAY_REJECTED, CONVERSATIONAL_DRAFT_REJECTED, RETRIEVAL_GROUNDING_REJECTED,
  TURN_DIRECTOR_DEFAULTS, createConversationalDraft, decideConversationalDraft, directNextTurn,
  evaluateFeatureFlag, reserveAIInvocation, reviewGroundingCorrection, submitGroundingCorrection,
  suppressedChunkIds, verifyGrounding, type AIGatewayQuota, type AIGatewayStore,
  type AIInvocationReservation, type ConversationalDraftStore, type ConversationalRequestDraft,
  type FeatureFlagConfiguration, type GroundingCorrection, type GroundingCorrectionStore,
  type KnowledgeChunk, type OrganizationAuthorizationState,
} from '@services-marketplace/contracts';
import {answerFromChunks, extractDraftFields, DETERMINISTIC_FALLBACK_LABEL} from '../adapters/ai.js';
import type {AppServices} from '../app.js';
import type {RouteDefinition} from '../http/router.js';
import {s, type JsonSchema} from '../http/schema.js';
import type {DocumentStore} from '../store/documents.js';
import {contractOptions, operatorFrom, organizationPath, respond, route, tenantOf} from './common.js';

type StateLoader = (organizationId: string, subjectId: string) =>
  Promise<OrganizationAuthorizationState>;

export function aiGatewayStore(documents: DocumentStore, load: StateLoader): AIGatewayStore {
  return {
    getOperator: async (organizationId, subjectId) =>
      operatorFrom(await load(organizationId, subjectId), organizationId, subjectId),
    getQuota: (organizationId, quotaKey) => documents.get<AIGatewayQuota>(organizationId, 'ai-quota', quotaKey),
    getByRequestKey: (organizationId, requestKey) => documents.findOne<AIInvocationReservation>(
      organizationId, 'ai-reservation', {requestKey}),
    commit: (expected, next, reservation) => documents.putAll(next.organizationId, [
      {kind: 'ai-quota', id: next.quotaKey, expected, next},
      {kind: 'ai-reservation', id: reservation.reservationId, expected: null, next: reservation,
        uniqueKeys: ['requestKey']},
    ]),
  };
}

export function groundingStore(documents: DocumentStore): GroundingCorrectionStore {
  return {
    getChunk: (organizationId, chunkId) => documents.get<KnowledgeChunk>(organizationId, 'knowledge-chunk', chunkId),
    getCorrection: (organizationId, id) => documents.get<GroundingCorrection>(organizationId, 'grounding-correction', id),
    getCorrectionByRequestKey: (organizationId, requestKey) => documents.findOne<GroundingCorrection>(
      organizationId, 'grounding-correction', {requestKey}),
    commitCorrection: (current, next) => documents.put(next.organizationId, {kind: 'grounding-correction',
      id: next.correctionId, expected: current, next, uniqueKeys: ['requestKey']}),
  };
}

export function draftStore(documents: DocumentStore): ConversationalDraftStore {
  return {
    getDraft: (organizationId, id) => documents.get<ConversationalRequestDraft>(organizationId, 'request-draft', id),
    getDraftByRequestKey: (organizationId, requestKey) => documents.findOne<ConversationalRequestDraft>(
      organizationId, 'request-draft', {requestKey}),
    commitDraft: (current, next) => documents.put(next.organizationId, {kind: 'request-draft',
      id: next.draftId, expected: current, next, uniqueKeys: ['requestKey']}),
  };
}

const groundingReport = s.object({verdict: s.enum('grounded', 'partially_grounded', 'ungrounded'),
  coverage: s.number({minimum: 0, maximum: 1}),
  supportedCitations: s.array(s.ref('Citation')),
  rejectedCitations: s.array(s.object({citation: s.ref('Citation'),
    reason: s.enum('unknown_chunk', 'suppressed_chunk', 'quote_not_found', 'malformed')}))});

export const aiSchemas: Record<string, JsonSchema> = {
  AIQuota: s.object({organizationId: s.string(), quotaKey: s.string(), periodStartsAt: s.integer(),
    periodEndsAt: s.integer(), revision: s.integer(), maximumRequests: s.integer(),
    maximumInputTokens: s.integer(), maximumOutputTokens: s.integer(),
    maximumInputTokensPerRequest: s.integer(), maximumOutputTokensPerRequest: s.integer(),
    usedRequests: s.integer(), usedInputTokens: s.integer(), usedOutputTokens: s.integer(),
    allowedModelKeys: s.array(s.string()), allowedToolKeys: s.array(s.string())}),
  Citation: s.object({chunkId: s.string(), quote: s.string()}),
  GroundedAnswer: s.object({answerId: s.string(), reservationId: s.string(), answer: s.string(),
    citations: s.array(s.ref('Citation')), grounding: groundingReport,
    provider: s.enum('anthropic', 'deterministic-fallback'), model: s.string(),
    fallbackNotice: s.nullable(s.string()), inputTokens: s.integer(), outputTokens: s.integer()}),
  GroundingCorrection: s.object({correctionId: s.string(), organizationId: s.string(),
    requestKey: s.string(), answerId: s.string(), chunkId: s.string(),
    correctionType: s.enum('incorrect', 'outdated', 'missing-citation', 'unsafe'), note: s.string(),
    status: s.enum('submitted', 'accepted', 'rejected'), submittedBySubjectId: s.string(),
    reviewedBySubjectId: s.nullable(s.string()), revision: s.integer(), submittedAt: s.integer(),
    reviewedAt: s.nullable(s.integer())}),
  RequestDraft: s.object({draftId: s.string(), organizationId: s.string(), requestKey: s.string(),
    customerSubjectId: s.string(), serviceKey: s.string(),
    fields: s.map({type: ['string', 'number', 'boolean']}), missingFieldKeys: s.array(s.string()),
    turnCount: s.integer(), extractionSource: s.enum('ai-provider', 'deterministic-fallback'),
    status: s.enum('pending_approval', 'approved', 'rejected'), revision: s.integer(),
    createdAt: s.integer(), expiresAt: s.integer(), decidedAt: s.nullable(s.integer())}),
  TurnDirection: s.object({directed: s.boolean(), agentKey: s.string(), reason: s.string()},
    ['directed', 'reason']),
};

export function aiRoutes(services: AppServices): RouteDefinition[] {
  const load: StateLoader = (organizationId, subjectId) =>
    services.identity.loadAuthorizationState(organizationId, subjectId);
  const gateway = {...contractOptions(services), store: aiGatewayStore(services.documents, load)};
  const grounding = {...contractOptions(services), store: groundingStore(services.documents)};
  const drafts = {...contractOptions(services), store: draftStore(services.documents)};
  const fieldSpec = s.object({key: s.string({pattern: '^[a-z][a-zA-Z0-9]{0,63}$'}),
    type: s.enum('text', 'number', 'boolean', 'date', 'postal-code'), required: s.boolean()});
  const turn = s.object({role: s.enum('customer', 'assistant'), text: s.string({minLength: 1, maxLength: 4_000})});

  return [
    route({method: 'PUT', path: organizationPath + '/ai-quotas/{quotaKey}', operationId: 'putAIQuota',
      tag: 'AI', auth: 'tenant', permission: 'ai-gateway:admin',
      summary: 'Set an AI usage quota period (resets usage counters)',
      requestBody: s.object({periodStartsAt: s.integer({minimum: 0}), periodEndsAt: s.integer({minimum: 1}),
        maximumRequests: s.integer({minimum: 1}), maximumInputTokens: s.integer({minimum: 1}),
        maximumOutputTokens: s.integer({minimum: 1}),
        maximumInputTokensPerRequest: s.integer({minimum: 1, maximum: 1_000_000}),
        maximumOutputTokensPerRequest: s.integer({minimum: 1, maximum: 1_000_000}),
        allowedModelKeys: s.array(s.key(), {minItems: 1, maxItems: 64}),
        allowedToolKeys: s.array(s.key(), {maxItems: 128})}),
      success: {status: 200, description: 'Quota stored', schema: s.ref('AIQuota')},
      handler: async context => {
        const tenant = tenantOf(context);
        const quotaKey = context.params.quotaKey!;
        if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,15}$/.test(quotaKey)) return {status: 400, body: {code: 'invalid_request'}};
        const body = context.body as Omit<AIGatewayQuota, 'organizationId' | 'quotaKey' | 'revision' |
          'usedRequests' | 'usedInputTokens' | 'usedOutputTokens'>;
        const current = await gateway.store.getQuota(tenant.organizationId, quotaKey);
        const next: AIGatewayQuota = {...body, organizationId: tenant.organizationId, quotaKey,
          allowedModelKeys: [...new Set(body.allowedModelKeys)].sort(),
          allowedToolKeys: [...new Set(body.allowedToolKeys)].sort(),
          revision: (current?.revision ?? 0) + 1, usedRequests: 0, usedInputTokens: 0, usedOutputTokens: 0};
        return await services.documents.put(tenant.organizationId, {kind: 'ai-quota', id: quotaKey,
          expected: current, next}) ? {status: 200, body: next} : {status: 409, body: {code: 'conflict'}};
      }}),
    route({method: 'POST', path: organizationPath + '/ai/answers', operationId: 'createGroundedAnswer',
      tag: 'AI', auth: 'tenant', permission: 'ai-gateway:invoke', rejectionCode: AI_GATEWAY_REJECTED,
      summary: 'Answer a question from published tenant knowledge with verified citations',
      requestBody: s.object({requestKey: s.id(), quotaKey: s.key(), modelKey: s.key(),
        question: s.string({minLength: 1, maxLength: 2_000}),
        maximumOutputTokens: s.integer({minimum: 64, maximum: 4_096})}),
      success: {status: 201, description: 'Answer with grounding report', schema: s.ref('GroundedAnswer')},
      handler: async context => {
        const tenant = tenantOf(context);
        const body = context.body as {requestKey: string; quotaKey: string; modelKey: string;
          question: string; maximumOutputTokens: number};
        const reservation = await reserveAIInvocation(1, tenant.request('ai-gateway:invoke'), tenant.state,
          {requestKey: body.requestKey, quotaKey: body.quotaKey, modelKey: body.modelKey, toolKeys: [],
            maximumInputTokens: 8_000, maximumOutputTokens: body.maximumOutputTokens}, gateway);
        if (!reservation.accepted) return {status: 422, body: {code: reservation.code}};
        const answerId = 'answer-' + reservation.value.reservationId;
        if (reservation.replayed) {
          const stored = await services.documents.get(tenant.organizationId, 'ai-answer', answerId);
          return stored ? {status: 200, body: stored} : {status: 409, body: {code: 'conflict'}};
        }
        const [chunks, corrections] = await Promise.all([
          services.documents.list<KnowledgeChunk>(tenant.organizationId, 'knowledge-chunk', {status: 'published'}, 1000),
          services.documents.list<GroundingCorrection>(tenant.organizationId, 'grounding-correction', {status: 'accepted'}, 1000),
        ]);
        const suppressed = suppressedChunkIds(tenant.organizationId, corrections);
        const answer = await answerFromChunks(services.adapters.ai, tenant.organizationId, body.question,
          chunks, suppressed, body.maximumOutputTokens);
        const report = verifyGrounding(tenant.organizationId, answer.answer, answer.citations, chunks, suppressed);
        const stored = {answerId, reservationId: reservation.value.reservationId, answer: answer.answer,
          citations: answer.citations, grounding: report, provider: answer.provider, model: answer.model,
          fallbackNotice: answer.provider === 'deterministic-fallback' ? DETERMINISTIC_FALLBACK_LABEL : null,
          inputTokens: answer.inputTokens, outputTokens: answer.outputTokens};
        await services.documents.put(tenant.organizationId, {kind: 'ai-answer', id: answerId,
          expected: null, next: stored});
        return {status: 201, body: stored};
      }}),
    route({method: 'POST', path: organizationPath + '/ai/grounding-corrections',
      operationId: 'submitGroundingCorrection', tag: 'AI', auth: 'tenant', permission: 'ai-grounding:correct',
      rejectionCode: RETRIEVAL_GROUNDING_REJECTED, summary: 'Report an incorrect, outdated or unsafe cited passage',
      requestBody: s.object({requestKey: s.id(), answerId: s.id(), chunkId: s.id(),
        correctionType: s.enum('incorrect', 'outdated', 'missing-citation', 'unsafe'),
        note: s.string({minLength: 1, maxLength: 2_000})}),
      success: {status: 201, description: 'Correction submitted', schema: s.ref('GroundingCorrection')},
      handler: async context => respond(await submitGroundingCorrection(1,
        tenantOf(context).request('ai-grounding:correct'), tenantOf(context).state,
        context.body as never, grounding), 201)}),
    route({method: 'POST', path: organizationPath + '/ai/grounding-corrections/{correctionId}/review',
      operationId: 'reviewGroundingCorrection', tag: 'AI', auth: 'tenant', permission: 'ai-grounding:review',
      rejectionCode: RETRIEVAL_GROUNDING_REJECTED,
      summary: 'Accept or reject a correction (not by its submitter); accepted ones suppress the chunk',
      requestBody: s.object({decision: s.enum('accepted', 'rejected'), expectedRevision: s.integer({minimum: 1})}),
      success: {status: 200, description: 'Correction reviewed', schema: s.ref('GroundingCorrection')},
      handler: async context => respond(await reviewGroundingCorrection(1,
        tenantOf(context).request('ai-grounding:review'), tenantOf(context).state,
        {...(context.body as object), correctionId: context.params.correctionId!} as never, grounding))}),
    route({method: 'POST', path: organizationPath + '/request-drafts', operationId: 'createRequestDraft',
      tag: 'AI', auth: 'tenant', permission: 'request-drafts:create', rejectionCode: CONVERSATIONAL_DRAFT_REJECTED,
      summary: 'Turn a conversation into a structured request draft awaiting the customer\'s approval',
      requestBody: s.object({requestKey: s.id(), serviceKey: s.key(),
        fieldSpecs: s.array(fieldSpec, {minItems: 1, maxItems: 64}), turns: s.array(turn, {minItems: 1, maxItems: 100})}),
      success: {status: 201, description: 'Draft created', schema: s.ref('RequestDraft')},
      handler: async context => {
        const tenant = tenantOf(context);
        const body = context.body as {requestKey: string; serviceKey: string; fieldSpecs: never[]; turns: never[]};
        const extracted = await extractDraftFields(services.adapters.ai, body.turns, body.fieldSpecs);
        return respond(await createConversationalDraft(1, tenant.request('request-drafts:create'), tenant.state,
          {requestKey: body.requestKey, serviceKey: body.serviceKey, fieldSpecs: body.fieldSpecs,
            turns: body.turns, proposedFields: extracted.fields, extractionSource: extracted.source}, drafts), 201);
      }}),
    route({method: 'POST', path: organizationPath + '/request-drafts/{draftId}/decision',
      operationId: 'decideRequestDraft', tag: 'AI', auth: 'tenant', permission: 'request-drafts:create',
      rejectionCode: CONVERSATIONAL_DRAFT_REJECTED, summary: 'The owning customer approves or rejects a draft',
      requestBody: s.object({decision: s.enum('approve', 'reject'), expectedRevision: s.integer({minimum: 1})}),
      success: {status: 200, description: 'Draft decided', schema: s.ref('RequestDraft')},
      handler: async context => respond(await decideConversationalDraft(1,
        tenantOf(context).request('request-drafts:create'), tenantOf(context).state,
        {...(context.body as object), draftId: context.params.draftId!} as never, drafts))}),
    route({method: 'POST', path: organizationPath + '/ai/turn-director', operationId: 'directNextTurn',
      tag: 'AI', auth: 'tenant', permission: 'turn-director:invoke',
      summary: 'Choose the next assistant in a multi-agent conversation (disabled unless enabled and flagged)',
      requestBody: s.object({maximumTotalTurns: s.integer({minimum: 1, maximum: 100}),
        agents: s.array(s.object({agentKey: s.key(), status: s.enum('active', 'disabled'),
          topics: s.array(s.key(), {maxItems: 32}), maximumTurns: s.integer({minimum: 1, maximum: 50})}), {maxItems: 16}),
        transcript: s.array(s.object({speaker: s.string({minLength: 1, maxLength: 128}),
          text: s.string({maxLength: 4_000})}), {maxItems: 200})}),
      success: {status: 200, description: 'Direction', schema: s.ref('TurnDirection')},
      handler: async context => {
        const tenant = tenantOf(context);
        const body = context.body as {maximumTotalTurns: number; agents: never[]; transcript: never[]};
        const flag = await services.documents.get<FeatureFlagConfiguration>(tenant.organizationId,
          'feature-flag', 'ai.turn-director@' + services.config.environment);
        const evaluation = evaluateFeatureFlag(1, tenant.organizationId, 'ai.turn-director',
          services.config.environment, flag);
        const direction = directNextTurn({...TURN_DIRECTOR_DEFAULTS, enabled: services.config.turnDirectorEnabled,
          maximumTotalTurns: body.maximumTotalTurns, agents: body.agents},
        evaluation.accepted && evaluation.enabled, body.transcript);
        return {status: 200, body: direction};
      }}),
  ];
}
