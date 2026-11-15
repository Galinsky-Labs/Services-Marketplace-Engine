import {
  ASSISTANT_REGISTRY_REJECTED, FEATURE_FLAG_REJECTED, KNOWLEDGE_BASE_REJECTED, configureAssistant,
  configureFeatureFlag, evaluateFeatureFlag, resolveActiveAssistant,
  resolvePublishedKnowledgeBaseArticle, reviseKnowledgeBaseArticle, type AssistantConfiguration,
  type AssistantRegistryStore, type FeatureFlagConfiguration, type FeatureFlagEnvironment,
  type FeatureFlagStore, type KnowledgeBaseArticleRevision, type KnowledgeBaseStore,
  type KnowledgeChunk, type OrganizationAuthorizationState,
} from '@services-marketplace/contracts';
import type {AppServices} from '../app.js';
import type {RouteDefinition} from '../http/router.js';
import {s, type JsonSchema} from '../http/schema.js';
import type {DocumentStore} from '../store/documents.js';
import {contractOptions, operatorFrom, organizationPath, respond, route, tenantOf} from './common.js';

type StateLoader = (organizationId: string, subjectId: string) =>
  Promise<OrganizationAuthorizationState>;

export function featureFlagStore(documents: DocumentStore, load: StateLoader): FeatureFlagStore {
  return {
    getOperator: async (organizationId, subjectId) =>
      operatorFrom(await load(organizationId, subjectId), organizationId, subjectId),
    getCurrent: (organizationId, flagKey, environment) => documents.get<FeatureFlagConfiguration>(
      organizationId, 'feature-flag', flagKey + '@' + environment),
    getByRequestKey: (organizationId, requestKey) => documents.findOne<FeatureFlagConfiguration>(
      organizationId, 'feature-flag-revision', {requestKey}),
    commit: (current, next) => documents.putAll(next.organizationId, [
      {kind: 'feature-flag', id: next.flagKey + '@' + next.environment, expected: current, next},
      {kind: 'feature-flag-revision', id: next.configurationId, expected: null, next,
        uniqueKeys: ['requestKey']},
    ]),
  };
}

export function assistantStore(documents: DocumentStore, load: StateLoader): AssistantRegistryStore {
  return {
    getOperator: async (organizationId, subjectId) =>
      operatorFrom(await load(organizationId, subjectId), organizationId, subjectId),
    getCurrent: (organizationId, assistantKey) => documents.get<AssistantConfiguration>(
      organizationId, 'assistant', assistantKey),
    getByRequestKey: (organizationId, requestKey) => documents.findOne<AssistantConfiguration>(
      organizationId, 'assistant-revision', {requestKey}),
    commit: (current, next) => documents.putAll(next.organizationId, [
      {kind: 'assistant', id: next.assistantKey, expected: current, next},
      {kind: 'assistant-revision', id: next.configurationId, expected: null, next,
        uniqueKeys: ['requestKey']},
    ]),
  };
}

export function knowledgeBaseStore(documents: DocumentStore, load: StateLoader): KnowledgeBaseStore {
  return {
    getOperator: async (organizationId, subjectId) =>
      operatorFrom(await load(organizationId, subjectId), organizationId, subjectId),
    getCurrent: (organizationId, articleKey, locale) => documents.get<KnowledgeBaseArticleRevision>(
      organizationId, 'kb-article', articleKey + '@' + locale),
    getByRequestKey: (organizationId, requestKey) => documents.findOne<KnowledgeBaseArticleRevision>(
      organizationId, 'kb-article-revision', {requestKey}),
    commit: (current, next) => documents.putAll(next.organizationId, [
      {kind: 'kb-article', id: next.articleKey + '@' + next.locale, expected: current, next},
      {kind: 'kb-article-revision', id: next.revisionId, expected: null, next,
        uniqueKeys: ['requestKey']},
    ]),
  };
}

export const configurationSchemas: Record<string, JsonSchema> = {
  FeatureFlagConfiguration: s.object({configurationId: s.string(), organizationId: s.string(),
    requestKey: s.string(), flagKey: s.string(), environment: s.enum('development', 'staging', 'production'),
    enabled: s.boolean(), variantKey: s.string(), revision: s.integer(), actorSubjectId: s.string(),
    changedAt: s.integer()}),
  FeatureFlagEvaluation: s.object({flagKey: s.string(), environment: s.string(), enabled: s.boolean(),
    variantKey: s.nullable(s.string()), revision: s.integer({minimum: 0})}),
  AssistantConfiguration: s.object({configurationId: s.string(), organizationId: s.string(),
    requestKey: s.string(), assistantKey: s.string(), status: s.enum('active', 'disabled'),
    modelKey: s.string(), toolKeys: s.array(s.string()), instructionTemplateKey: s.string(),
    knowledgeSourceKeys: s.array(s.string()), revision: s.integer(), actorSubjectId: s.string(),
    configuredAt: s.integer()}),
  KnowledgeBaseArticleRevision: s.object({revisionId: s.string(), organizationId: s.string(),
    requestKey: s.string(), articleKey: s.string(), locale: s.string(), title: s.string(),
    contentReference: s.string(), contentDigest: s.string(),
    status: s.enum('draft', 'published', 'archived'), revision: s.integer(), actorSubjectId: s.string(),
    updatedAt: s.integer(), publishedAt: s.nullable(s.integer())}),
  KnowledgeChunk: s.object({organizationId: s.string(), chunkId: s.string(), sourceKey: s.string(),
    text: s.string(), status: s.enum('published', 'retired'), revision: s.integer()}),
};

export function configurationRoutes(services: AppServices): RouteDefinition[] {
  const load: StateLoader = (organizationId, subjectId) =>
    services.identity.loadAuthorizationState(organizationId, subjectId);
  const flags = {...contractOptions(services), store: featureFlagStore(services.documents, load)};
  const assistants = {...contractOptions(services), store: assistantStore(services.documents, load)};
  const knowledge = {...contractOptions(services), store: knowledgeBaseStore(services.documents, load)};
  const environment = s.enum('development', 'staging', 'production');
  return [
    route({method: 'PUT', path: organizationPath + '/feature-flags/{flagKey}',
      operationId: 'configureFeatureFlag', tag: 'Configuration', auth: 'tenant',
      permission: 'feature-flags:write', rejectionCode: FEATURE_FLAG_REJECTED,
      summary: 'Create or revise a feature flag for one environment',
      requestBody: s.object({requestKey: s.id(), environment, enabled: s.boolean(),
        variantKey: s.key(), expectedRevision: s.integer({minimum: 0})}),
      success: {status: 200, description: 'Flag configured', schema: s.ref('FeatureFlagConfiguration')},
      handler: async context => respond(await configureFeatureFlag(1,
        tenantOf(context).request('feature-flags:write'), tenantOf(context).state,
        {...(context.body as object), flagKey: context.params.flagKey!} as never, flags))}),
    route({method: 'GET', path: organizationPath + '/feature-flags/{flagKey}',
      operationId: 'evaluateFeatureFlag', tag: 'Configuration', auth: 'tenant',
      permission: 'feature-flags:read', summary: 'Evaluate a flag; unknown flags evaluate to disabled',
      queryParameters: {environment},
      success: {status: 200, description: 'Evaluation', schema: s.ref('FeatureFlagEvaluation')},
      handler: async context => {
        const tenant = tenantOf(context);
        const flagKey = context.params.flagKey!;
        const env = (context.query.get('environment') ?? services.config.environment) as FeatureFlagEnvironment;
        const current = await flags.store.getCurrent(tenant.organizationId, flagKey, env);
        const evaluation = evaluateFeatureFlag(1, tenant.organizationId, flagKey, env, current);
        return {status: 200, body: evaluation.accepted
          ? {flagKey, environment: env, enabled: evaluation.enabled, variantKey: evaluation.variantKey,
            revision: evaluation.revision}
          : {flagKey, environment: env, enabled: false, variantKey: null, revision: 0}};
      }}),
    route({method: 'PUT', path: organizationPath + '/assistants/{assistantKey}',
      operationId: 'configureAssistant', tag: 'AI', auth: 'tenant', permission: 'assistant-registry:write',
      rejectionCode: ASSISTANT_REGISTRY_REJECTED, summary: 'Create or revise an assistant configuration',
      requestBody: s.object({requestKey: s.id(), status: s.enum('active', 'disabled'), modelKey: s.key(),
        toolKeys: s.array(s.key(), {maxItems: 32}), instructionTemplateKey: s.key(),
        knowledgeSourceKeys: s.array(s.key(), {maxItems: 64}), expectedRevision: s.integer({minimum: 0})}),
      success: {status: 200, description: 'Assistant configured', schema: s.ref('AssistantConfiguration')},
      handler: async context => respond(await configureAssistant(1,
        tenantOf(context).request('assistant-registry:write'), tenantOf(context).state,
        {...(context.body as object), assistantKey: context.params.assistantKey!} as never, assistants))}),
    route({method: 'GET', path: organizationPath + '/assistants/{assistantKey}',
      operationId: 'getActiveAssistant', tag: 'AI', auth: 'tenant', permission: 'assistant-registry:read',
      rejectionCode: ASSISTANT_REGISTRY_REJECTED, summary: 'Resolve the active assistant configuration',
      success: {status: 200, description: 'Active configuration', schema: s.ref('AssistantConfiguration')},
      handler: async context => {
        const tenant = tenantOf(context);
        const key = context.params.assistantKey!;
        return respond(resolveActiveAssistant(1, tenant.organizationId, key,
          await assistants.store.getCurrent(tenant.organizationId, key)));
      }}),
    route({method: 'PUT', path: organizationPath + '/knowledge-articles/{articleKey}',
      operationId: 'reviseKnowledgeArticle', tag: 'Knowledge', auth: 'tenant',
      permission: 'knowledge-base:write', rejectionCode: KNOWLEDGE_BASE_REJECTED,
      summary: 'Create or revise a knowledge base article revision (content by reference)',
      requestBody: s.object({requestKey: s.id(), locale: s.string({pattern: '^[a-z]{2,3}(?:-[A-Z]{2})?$'}),
        title: s.string({minLength: 1, maxLength: 200}), contentReference: s.id(),
        contentDigest: s.string({pattern: '^[a-f0-9]{64}$'}), status: s.enum('draft', 'published', 'archived'),
        expectedRevision: s.integer({minimum: 0})}),
      success: {status: 200, description: 'Revision stored', schema: s.ref('KnowledgeBaseArticleRevision')},
      handler: async context => respond(await reviseKnowledgeBaseArticle(1,
        tenantOf(context).request('knowledge-base:write'), tenantOf(context).state,
        {...(context.body as object), articleKey: context.params.articleKey!} as never, knowledge))}),
    route({method: 'GET', path: organizationPath + '/knowledge-articles/{articleKey}',
      operationId: 'getPublishedKnowledgeArticle', tag: 'Knowledge', auth: 'tenant',
      permission: 'knowledge-base:read', rejectionCode: KNOWLEDGE_BASE_REJECTED,
      summary: 'Resolve the published revision of an article', queryParameters: {locale: s.string({pattern: '^[a-z]{2,3}(?:-[A-Z]{2})?$'})},
      success: {status: 200, description: 'Published revision', schema: s.ref('KnowledgeBaseArticleRevision')},
      handler: async context => {
        const tenant = tenantOf(context);
        const locale = context.query.get('locale') ?? 'en';
        const key = context.params.articleKey!;
        return respond(resolvePublishedKnowledgeBaseArticle(1, tenant.organizationId, key, locale,
          await knowledge.store.getCurrent(tenant.organizationId, key, locale)));
      }}),
    route({method: 'PUT', path: organizationPath + '/knowledge-chunks/{chunkId}',
      operationId: 'putKnowledgeChunk', tag: 'Knowledge', auth: 'tenant', permission: 'knowledge-base:write',
      summary: 'Publish or retire a retrievable knowledge passage used for grounded answers',
      requestBody: s.object({sourceKey: s.key(), text: s.string({minLength: 1, maxLength: 20_000}),
        status: s.enum('published', 'retired')}),
      success: {status: 200, description: 'Chunk stored', schema: s.ref('KnowledgeChunk')},
      handler: async context => {
        const tenant = tenantOf(context);
        const chunkId = context.params.chunkId!;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(chunkId)) return {status: 400, body: {code: 'invalid_request'}};
        const body = context.body as {sourceKey: string; text: string; status: 'published' | 'retired'};
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await services.documents.get<KnowledgeChunk>(tenant.organizationId,
            'knowledge-chunk', chunkId);
          const next: KnowledgeChunk = {organizationId: tenant.organizationId, chunkId,
            sourceKey: body.sourceKey, text: body.text, status: body.status,
            revision: (current?.revision ?? 0) + 1};
          if (await services.documents.put(tenant.organizationId, {kind: 'knowledge-chunk', id: chunkId,
            expected: current, next})) return {status: 200, body: next};
        }
        return {status: 409, body: {code: 'conflict'}};
      }}),
  ];
}
