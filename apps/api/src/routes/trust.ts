import {
  CONSENT_LEDGER_REJECTED, CONSENT_PURPOSES, DATA_PRIVACY_REJECTED, MONITORING_REJECTED,
  RESEARCH_SOURCING_REJECTED, buildPrivacyExport, completePrivacyRequest, evaluateConsent,
  openIncident, openPrivacyRequest, planSubjectDeletion, recordConsent, recordResearchFinding,
  registerResearchSource, selectActiveResearchFindings, transitionIncident, type ConsentEntry,
  type ConsentLedgerStore, type ConsentPurpose, type DataPrivacyStore, type Incident,
  type IncidentStore, type OrganizationAuthorizationState, type PrivacyRecord, type PrivacyRequest,
  type ResearchFinding, type ResearchSource, type ResearchSourcingStore, type RetentionPolicy,
} from '@services-marketplace/contracts';
import {sha256Digest, type AppServices} from '../app.js';
import type {RouteDefinition} from '../http/router.js';
import {s, type JsonSchema} from '../http/schema.js';
import type {DocumentStore} from '../store/documents.js';
import {contractOptions, operatorFrom, organizationPath, respond, route, tenantOf} from './common.js';

type StateLoader = (organizationId: string, subjectId: string) =>
  Promise<OrganizationAuthorizationState>;

export function researchStore(documents: DocumentStore, load: StateLoader): ResearchSourcingStore {
  return {
    getOperator: async (organizationId, subjectId) =>
      operatorFrom(await load(organizationId, subjectId), organizationId, subjectId),
    getSource: (organizationId, sourceKey) => documents.get<ResearchSource>(organizationId, 'research-source', sourceKey),
    getSourceByRequestKey: (organizationId, requestKey) => documents.findOne<ResearchSource>(
      organizationId, 'research-source-revision', {requestKey}),
    commitSource: (current, next) => documents.putAll(next.organizationId, [
      {kind: 'research-source', id: next.sourceKey, expected: current, next},
      {kind: 'research-source-revision', id: next.sourceId, expected: null, next, uniqueKeys: ['requestKey']},
    ]),
    providerExists: async (organizationId, providerOrganizationId) =>
      (await documents.get(organizationId, 'provider', providerOrganizationId)) !== null,
    getFindingByRequestKey: (organizationId, requestKey) => documents.findOne<ResearchFinding>(
      organizationId, 'research-finding', {requestKey}),
    createFinding: finding => documents.put(finding.organizationId, {kind: 'research-finding',
      id: finding.findingId, expected: null, next: finding, uniqueKeys: ['requestKey']}),
  };
}

const chainId = (subjectId: string): string => 'chain:' + subjectId;

export function consentStore(documents: DocumentStore): ConsentLedgerStore {
  return {
    getHead: async (organizationId, subjectId) => {
      const head = await documents.get<{entryId: string}>(organizationId, 'consent-head', chainId(subjectId));
      return head ? documents.get<ConsentEntry>(organizationId, 'consent-entry', head.entryId) : null;
    },
    getByRequestKey: (organizationId, requestKey) => documents.findOne<ConsentEntry>(
      organizationId, 'consent-entry', {requestKey}),
    append: async (expected, entry) => documents.putAll(entry.organizationId, [
      {kind: 'consent-head', id: chainId(entry.subjectId),
        expected: expected ? {entryId: expected.entryId} : null, next: {entryId: entry.entryId}},
      {kind: 'consent-entry', id: entry.entryId, expected: null, next: entry, uniqueKeys: ['requestKey']},
    ]),
  };
}

export function privacyStore(documents: DocumentStore): DataPrivacyStore {
  return {
    getRequest: (organizationId, id) => documents.get<PrivacyRequest>(organizationId, 'privacy-request', id),
    getRequestByKey: (organizationId, requestKey) => documents.findOne<PrivacyRequest>(
      organizationId, 'privacy-request', {requestKey}),
    commitRequest: (current, next) => documents.put(next.organizationId, {kind: 'privacy-request',
      id: next.privacyRequestId, expected: current, next, uniqueKeys: ['requestKey']}),
  };
}

export function incidentStore(documents: DocumentStore): IncidentStore {
  return {
    getIncident: (organizationId, id) => documents.get<Incident>(organizationId, 'incident', id),
    getOpenByDedupeKey: async (organizationId, dedupeKey) => {
      const open = (await documents.list<Incident>(organizationId, 'incident', {dedupeKey}, 50))
        .filter(incident => incident.status !== 'resolved');
      return open.length === 1 ? open[0]! : null;
    },
    getByRequestKey: (organizationId, requestKey) => documents.findOne<Incident>(organizationId, 'incident', {requestKey}),
    commitIncident: (current, next) => documents.put(next.organizationId, {kind: 'incident',
      id: next.incidentId, expected: current, next, uniqueKeys: ['requestKey']}),
  };
}

/** Kinds holding personal data, and the field naming the owning subject. */
export const PERSONAL_DATA_KINDS: Readonly<Record<string, string>> = Object.freeze({
  'customer-profile': 'customerSubjectId',
  'request-draft': 'customerSubjectId',
  'consent-entry': 'subjectId',
  'privacy-request': 'subjectId',
});

/** Retention for personal-data kinds. Consent and privacy records are statutory evidence. */
export const RETENTION_POLICIES: readonly RetentionPolicy[] = Object.freeze([
  {kind: 'customer-profile', retainDays: 1_095, onExpiry: 'anonymize', statutoryRetention: false},
  {kind: 'request-draft', retainDays: 90, onExpiry: 'delete', statutoryRetention: false},
  {kind: 'consent-entry', retainDays: 2_555, onExpiry: 'anonymize', statutoryRetention: true},
  {kind: 'privacy-request', retainDays: 2_555, onExpiry: 'anonymize', statutoryRetention: true},
]);

async function subjectRecords(documents: DocumentStore, organizationId: string,
  subjectId: string): Promise<PrivacyRecord[]> {
  const records: PrivacyRecord[] = [];
  for (const [kind, field] of Object.entries(PERSONAL_DATA_KINDS)) {
    const values = await documents.list<Record<string, unknown>>(organizationId, kind, {[field]: subjectId}, 1000);
    for (const value of values) {
      const recordId = String(value.customerProfileId ?? value.draftId ?? value.entryId ??
        value.privacyRequestId ?? '');
      records.push({kind, recordId, ownerSubjectId: subjectId,
        createdAt: Number(value.createdAt ?? value.recordedAt ?? value.receivedAt ?? 0),
        legalHold: value.legalHold === true, data: value});
    }
  }
  return records;
}

const ANONYMIZED_FIELDS = ['displayName', 'email', 'phone', 'fields'];

export const trustSchemas: Record<string, JsonSchema> = {
  ResearchSource: s.object({sourceId: s.string(), organizationId: s.string(), requestKey: s.string(),
    sourceKey: s.string(), publisherName: s.string(), origin: s.string(),
    allowedPathPrefixes: s.array(s.string()), license: s.enum('public-record', 'open-license', 'permission-granted'),
    retentionDays: s.integer(), status: s.enum('active', 'retired'), revision: s.integer(),
    actorSubjectId: s.string(), registeredAt: s.integer()}),
  ResearchFinding: s.object({findingId: s.string(), organizationId: s.string(), requestKey: s.string(),
    sourceId: s.string(), sourceKey: s.string(), providerOrganizationId: s.string(), sourceUrl: s.string(),
    retrievedAt: s.integer(), contentDigest: s.string(), excerpt: s.string(),
    claimType: s.enum('license', 'certification', 'business-registration', 'sanction', 'other'),
    claimValue: s.string(), verification: {const: 'unverified'}, expiresAt: s.integer(),
    actorSubjectId: s.string(), recordedAt: s.integer()}),
  ConsentEntry: s.object({entryId: s.string(), organizationId: s.string(), subjectId: s.string(),
    sequence: s.integer(), requestKey: s.string(), purpose: s.enum(...CONSENT_PURPOSES),
    decision: s.enum('granted', 'withdrawn'), noticeVersion: s.string(),
    channel: s.enum('web', 'mobile', 'api', 'support'), recordedBySubjectId: s.string(),
    recordedAt: s.integer(), previousHash: s.string(), entryHash: s.string()}),
  ConsentStatus: s.object({purpose: s.enum(...CONSENT_PURPOSES), granted: s.boolean(),
    noticeVersion: s.nullable(s.string()), decidedAt: s.nullable(s.integer()), chainValid: s.boolean()}),
  PrivacyRequest: s.object({privacyRequestId: s.string(), organizationId: s.string(), requestKey: s.string(),
    subjectId: s.string(), kind: s.enum('export', 'deletion'), status: s.enum('received', 'completed', 'denied'),
    requestedBySubjectId: s.string(), receivedAt: s.integer(), dueAt: s.integer(),
    completedAt: s.nullable(s.integer()), resultDigest: s.nullable(s.string()), revision: s.integer()}),
  PrivacyExport: s.object({subjectId: s.string(), generatedAt: s.integer(), recordCount: s.integer(),
    collections: s.array(s.object({kind: s.string(), records: s.array({type: 'object'})}))}),
  Incident: s.object({incidentId: s.string(), organizationId: s.string(), requestKey: s.string(),
    dedupeKey: s.string(), title: s.string(), severity: s.enum('sev1', 'sev2', 'sev3'),
    status: s.enum('open', 'acknowledged', 'mitigated', 'resolved'), openedAt: s.integer(),
    updatedAt: s.integer(), commanderSubjectId: s.nullable(s.string()), postmortemUrl: s.nullable(s.string()),
    timeline: s.array(s.object({at: s.integer(), subjectId: s.string(),
      status: s.enum('open', 'acknowledged', 'mitigated', 'resolved'), note: s.string()})),
    revision: s.integer()}),
};

export function trustRoutes(services: AppServices): RouteDefinition[] {
  const load: StateLoader = (organizationId, subjectId) =>
    services.identity.loadAuthorizationState(organizationId, subjectId);
  const research = {...contractOptions(services), store: researchStore(services.documents, load)};
  const consent = {...contractOptions(services), store: consentStore(services.documents), sha256: sha256Digest};
  const privacy = {...contractOptions(services), store: privacyStore(services.documents)};
  const incidents = {...contractOptions(services), store: incidentStore(services.documents)};
  const purpose = s.enum(...CONSENT_PURPOSES);

  async function consentChain(organizationId: string, subjectId: string): Promise<ConsentEntry[]> {
    const entries = await services.documents.list<ConsentEntry>(organizationId, 'consent-entry', {subjectId}, 1000);
    return entries.sort((left, right) => left.sequence - right.sequence);
  }

  return [
    route({method: 'PUT', path: organizationPath + '/research-sources/{sourceKey}',
      operationId: 'registerResearchSource', tag: 'Research', auth: 'tenant', permission: 'research:sources:write',
      rejectionCode: RESEARCH_SOURCING_REJECTED, summary: 'Register or revise a public professional research source',
      requestBody: s.object({requestKey: s.id(), publisherName: s.string({minLength: 1, maxLength: 200}),
        baseUrl: s.string({maxLength: 2_048}), allowedPathPrefixes: s.array(s.string({maxLength: 200}), {minItems: 1, maxItems: 16}),
        license: s.enum('public-record', 'open-license', 'permission-granted'),
        retentionDays: s.integer({minimum: 1, maximum: 3650}), status: s.enum('active', 'retired'),
        expectedRevision: s.integer({minimum: 0})}),
      success: {status: 200, description: 'Source registered', schema: s.ref('ResearchSource')},
      handler: async context => respond(await registerResearchSource(1,
        tenantOf(context).request('research:sources:write'), tenantOf(context).state,
        {...(context.body as object), sourceKey: context.params.sourceKey!} as never, research))}),
    route({method: 'POST', path: organizationPath + '/research-findings', operationId: 'recordResearchFinding',
      tag: 'Research', auth: 'tenant', permission: 'research:findings:write', rejectionCode: RESEARCH_SOURCING_REJECTED,
      summary: 'Record a cited, unverified finding about a provider from a registered source',
      requestBody: s.object({requestKey: s.id(), sourceKey: s.key(), providerOrganizationId: s.id(),
        sourceUrl: s.string({maxLength: 2_048}), retrievedAt: s.integer({minimum: 0}),
        contentDigest: s.string({pattern: '^sha256:[0-9a-f]{64}$'}), excerpt: s.string({minLength: 1, maxLength: 1_000}),
        claimType: s.enum('license', 'certification', 'business-registration', 'sanction', 'other'),
        claimValue: s.string({minLength: 1, maxLength: 200})}),
      success: {status: 201, description: 'Finding recorded', schema: s.ref('ResearchFinding')},
      handler: async context => respond(await recordResearchFinding(1,
        tenantOf(context).request('research:findings:write'), tenantOf(context).state,
        context.body as never, research), 201)}),
    route({method: 'GET', path: organizationPath + '/providers/{providerOrganizationId}/research-findings',
      operationId: 'listResearchFindings', tag: 'Research', auth: 'tenant', permission: 'research:findings:read',
      summary: 'Unexpired research findings for a provider, newest first',
      success: {status: 200, description: 'Findings', schema: s.object({items: s.array(s.ref('ResearchFinding'))})},
      handler: async context => {
        const tenant = tenantOf(context);
        const providerOrganizationId = context.params.providerOrganizationId!;
        const findings = await services.documents.list<ResearchFinding>(tenant.organizationId,
          'research-finding', {providerOrganizationId}, 500);
        return {status: 200, body: {items: selectActiveResearchFindings(findings, tenant.organizationId,
          providerOrganizationId, services.now())}};
      }}),
    route({method: 'POST', path: organizationPath + '/consents', operationId: 'recordConsent', tag: 'Privacy',
      auth: 'tenant', permission: 'consent:record', rejectionCode: CONSENT_LEDGER_REJECTED,
      summary: 'Append a consent decision to the subject\'s hash-chained ledger (staff need consent:manage)',
      requestBody: s.object({requestKey: s.id(), subjectId: s.id(), purpose,
        decision: s.enum('granted', 'withdrawn'), noticeVersion: s.string({pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'}),
        channel: s.enum('web', 'mobile', 'api', 'support')}),
      success: {status: 201, description: 'Entry appended', schema: s.ref('ConsentEntry')},
      handler: async context => {
        const tenant = tenantOf(context);
        const body = context.body as {subjectId: string};
        const permission = body.subjectId === tenant.subjectId ? 'consent:record' : 'consent:manage';
        return respond(await recordConsent(1, tenant.request(permission), tenant.state, context.body as never,
          consent), 201);
      }}),
    route({method: 'GET', path: organizationPath + '/consents/{subjectId}/{purpose}', operationId: 'getConsentStatus',
      tag: 'Privacy', auth: 'tenant', permission: 'consent:read',
      summary: 'Effective consent for a purpose; broken chains evaluate to not granted',
      success: {status: 200, description: 'Consent status', schema: s.ref('ConsentStatus')},
      handler: async context => {
        const tenant = tenantOf(context);
        const subjectId = context.params.subjectId!;
        const requested = context.params.purpose as ConsentPurpose;
        if (!CONSENT_PURPOSES.includes(requested)) return {status: 400, body: {code: 'invalid_request'}};
        return {status: 200, body: evaluateConsent(await consentChain(tenant.organizationId, subjectId),
          tenant.organizationId, subjectId, requested, services.now(), sha256Digest)};
      }}),
    route({method: 'POST', path: organizationPath + '/privacy-requests', operationId: 'openPrivacyRequest',
      tag: 'Privacy', auth: 'tenant', permission: 'privacy:request', rejectionCode: DATA_PRIVACY_REJECTED,
      summary: 'Open a data export or deletion request (30-day response window)',
      requestBody: s.object({requestKey: s.id(), subjectId: s.id(), kind: s.enum('export', 'deletion')}),
      success: {status: 201, description: 'Request opened', schema: s.ref('PrivacyRequest')},
      handler: async context => {
        const tenant = tenantOf(context);
        const body = context.body as {subjectId: string};
        const permission = body.subjectId === tenant.subjectId ? 'privacy:request' : 'privacy:manage';
        return respond(await openPrivacyRequest(1, tenant.request(permission), tenant.state,
          context.body as never, privacy), 201);
      }}),
    route({method: 'GET', path: organizationPath + '/privacy-requests/{privacyRequestId}/export',
      operationId: 'getPrivacyExport', tag: 'Privacy', auth: 'tenant', permission: 'privacy:manage',
      summary: 'Build the portable export for an export request', rejectionCode: DATA_PRIVACY_REJECTED,
      success: {status: 200, description: 'Export', schema: s.ref('PrivacyExport')},
      handler: async context => {
        const tenant = tenantOf(context);
        const request = await privacy.store.getRequest(tenant.organizationId, context.params.privacyRequestId!);
        if (request?.kind !== 'export') return {status: 422, body: {code: DATA_PRIVACY_REJECTED}};
        const records = await subjectRecords(services.documents, tenant.organizationId, request.subjectId);
        return {status: 200, body: buildPrivacyExport(request.subjectId, records, services.now())};
      }}),
    route({method: 'POST', path: organizationPath + '/privacy-requests/{privacyRequestId}/completion',
      operationId: 'completePrivacyRequest', tag: 'Privacy', auth: 'tenant', permission: 'privacy:manage',
      rejectionCode: DATA_PRIVACY_REJECTED,
      summary: 'Fulfil (export digest, or execute the deletion plan) or deny a privacy request',
      requestBody: s.object({outcome: s.enum('completed', 'denied'), expectedRevision: s.integer({minimum: 1})}),
      success: {status: 200, description: 'Request closed', schema: s.ref('PrivacyRequest')},
      handler: async context => {
        const tenant = tenantOf(context);
        const body = context.body as {outcome: 'completed' | 'denied'; expectedRevision: number};
        const request = await privacy.store.getRequest(tenant.organizationId, context.params.privacyRequestId!);
        if (!request || request.status !== 'received') return {status: 422, body: {code: DATA_PRIVACY_REJECTED}};
        let resultDigest: string | null = null;
        if (body.outcome === 'completed') {
          const records = await subjectRecords(services.documents, tenant.organizationId, request.subjectId);
          if (request.kind === 'export') {
            const exported = buildPrivacyExport(request.subjectId, records, request.receivedAt);
            resultDigest = sha256Digest(JSON.stringify(exported));
          } else {
            const plan = planSubjectDeletion(request.subjectId, records, RETENTION_POLICIES);
            for (const action of plan) {
              const record = records.find(candidate => candidate.kind === action.kind &&
                candidate.recordId === action.recordId);
              if (!record || action.action === 'retain') continue;
              if (action.action === 'delete') {
                await services.documents.remove(tenant.organizationId, action.kind, action.recordId);
              } else if (ANONYMIZED_FIELDS.some(field => field in record.data)) {
                const anonymized = Object.fromEntries(Object.entries(record.data).map(([key, value]) =>
                  [key, ANONYMIZED_FIELDS.includes(key) ? (key === 'fields' ? {} : null) : value]));
                await services.documents.put(tenant.organizationId, {kind: action.kind, id: action.recordId,
                  expected: record.data, next: {...anonymized, anonymized: true}});
              }
            }
            resultDigest = sha256Digest(JSON.stringify(plan));
          }
        }
        return respond(await completePrivacyRequest(1, tenant.request('privacy:manage'), tenant.state,
          {privacyRequestId: request.privacyRequestId, outcome: body.outcome, resultDigest,
            expectedRevision: body.expectedRevision}, privacy));
      }}),
    route({method: 'POST', path: organizationPath + '/incidents', operationId: 'openIncident', tag: 'Operations',
      auth: 'tenant', permission: 'operations:incidents:write', rejectionCode: MONITORING_REJECTED,
      summary: 'Open (or join the open incident with the same dedupe key)',
      requestBody: s.object({requestKey: s.id(), dedupeKey: s.id(), title: s.string({minLength: 1, maxLength: 200}),
        severity: s.enum('sev1', 'sev2', 'sev3')}),
      success: {status: 201, description: 'Incident opened', schema: s.ref('Incident')},
      handler: async context => respond(await openIncident(1, tenantOf(context).request('operations:incidents:write'),
        tenantOf(context).state, context.body as never, incidents), 201)}),
    route({method: 'POST', path: organizationPath + '/incidents/{incidentId}/transitions',
      operationId: 'transitionIncident', tag: 'Operations', auth: 'tenant', permission: 'operations:incidents:write',
      rejectionCode: MONITORING_REJECTED, summary: 'Acknowledge, mitigate or resolve an incident',
      requestBody: s.object({status: s.enum('acknowledged', 'mitigated', 'resolved'),
        note: s.string({minLength: 1, maxLength: 2_000}), postmortemUrl: s.nullable(s.string({maxLength: 2_000})),
        expectedRevision: s.integer({minimum: 1})}),
      success: {status: 200, description: 'Incident updated', schema: s.ref('Incident')},
      handler: async context => respond(await transitionIncident(1,
        tenantOf(context).request('operations:incidents:write'), tenantOf(context).state,
        {...(context.body as object), incidentId: context.params.incidentId!} as never, incidents))}),
    route({method: 'GET', path: organizationPath + '/incidents/{incidentId}', operationId: 'getIncident',
      tag: 'Operations', auth: 'tenant', permission: 'operations:incidents:read', summary: 'Read an incident',
      success: {status: 200, description: 'Incident', schema: s.ref('Incident')},
      handler: async context => {
        const incident = await incidents.store.getIncident(tenantOf(context).organizationId, context.params.incidentId!);
        return incident ? {status: 200, body: incident} : {status: 404, body: {code: 'not_found'}};
      }}),
  ];
}
