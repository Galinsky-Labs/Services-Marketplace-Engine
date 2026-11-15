import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError} from '../packages/sdk/dist/index.js';
import {startApi} from './support/http-app.mjs';

const expectApiError = async (promise, status, code) => {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ApiError, String(error));
    assert.deepEqual({status: error.status, code: error.code}, {status, code});
    return true;
  });
};

test('health, readiness and status page need no credentials', async t => {
  const api = await startApi();
  t.after(api.close);
  const health = await api.raw('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  const ready = await api.raw('GET', '/ready');
  assert.deepEqual(ready.json, {status: 'ready', persistence: 'memory', database: true});
  const page = await api.raw('GET', '/');
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /<html lang="en">/);
  const spec = await api.raw('GET', '/openapi.json');
  assert.equal(spec.json.openapi, '3.1.0');
});

test('platform admin provisions an organization whose owner can manage members and keys', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision('Acme Services');
  const member = await api.addMember(owner, 'support', ['customer-profile:read']);
  const listed = await owner.client.listAuditEvents(owner.organizationId, {limit: 5});
  assert.ok(Array.isArray(listed.items));
  // The new member is limited to their role.
  await expectApiError(member.client.createProviderOrganization(owner.organizationId,
    {legalName: 'Nope LLC', publicName: 'Nope'}), 403, 'authorization_denied');
  await owner.client.revokeApiKey(owner.organizationId, member.keyId);
  await expectApiError(member.client.listAuditEvents(owner.organizationId), 401, 'unauthenticated');
});

test('marketplace flow: customers, providers and locations through the SDK', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const org = owner.organizationId;
  const profile = await owner.client.createCustomerProfile(org, {customerSubjectId: owner.ownerSubjectId,
    displayName: 'Pat Doe', email: 'pat@example.org', phone: null});
  assert.equal((await owner.client.getCustomerProfile(org, profile.customerProfileId)).displayName, 'Pat Doe');
  const updated = await owner.client.updateCustomerProfile(org, profile.customerProfileId,
    {expectedVersion: 1, profile: {customerSubjectId: owner.ownerSubjectId, displayName: 'Pat D.', email: null, phone: null}});
  assert.equal(updated.version, 2);
  await expectApiError(owner.client.updateCustomerProfile(org, profile.customerProfileId,
    {expectedVersion: 1, profile: {customerSubjectId: owner.ownerSubjectId, displayName: 'Stale', email: null, phone: null}}),
  422, 'customer_rejected');
  const provider = await owner.client.createProviderOrganization(org, {legalName: 'Reliable Repairs LLC', publicName: 'Reliable Repairs'});
  const location = await owner.client.createProviderLocation(org, provider.providerOrganizationId, {
    name: 'Main shop', addressLines: ['1 Main St'], locality: 'Springfield', administrativeArea: 'IL',
    postalCode: '62701', countryCode: 'US', timeZone: 'America/Chicago', serviceModes: ['on_site', 'mobile']});
  const locations = await owner.client.listProviderLocations(org, provider.providerOrganizationId);
  assert.deepEqual(locations.items.map(item => item.providerLocationId), [location.providerLocationId]);
});

test('configuration: feature flags, assistants and knowledge articles', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const org = owner.organizationId;
  assert.deepEqual(await owner.client.evaluateFeatureFlag(org, 'ai.turn-director', {environment: 'production'}),
    {flagKey: 'ai.turn-director', environment: 'production', enabled: false, variantKey: null, revision: 0});
  const flag = await owner.client.configureFeatureFlag(org, 'ai.turn-director', {requestKey: 'flag-1',
    environment: 'production', enabled: true, variantKey: 'on', expectedRevision: 0});
  assert.equal(flag.revision, 1);
  assert.equal((await owner.client.configureFeatureFlag(org, 'ai.turn-director', {requestKey: 'flag-1',
    environment: 'production', enabled: true, variantKey: 'on', expectedRevision: 0})).configurationId, flag.configurationId);
  assert.equal((await owner.client.evaluateFeatureFlag(org, 'ai.turn-director', {environment: 'production'})).enabled, true);
  const assistant = await owner.client.configureAssistant(org, 'support.concierge', {requestKey: 'a-1',
    status: 'active', modelKey: 'default', toolKeys: [], instructionTemplateKey: 'support.v1',
    knowledgeSourceKeys: ['kb.billing'], expectedRevision: 0});
  assert.equal((await owner.client.getActiveAssistant(org, 'support.concierge')).configurationId, assistant.configurationId);
  const articleInput = {locale: 'en', title: 'Deposit policy', contentReference: 'doc-1', contentDigest: 'a'.repeat(64)};
  await owner.client.reviseKnowledgeArticle(org, 'deposit-policy', {...articleInput, requestKey: 'kb-1', status: 'draft', expectedRevision: 0});
  const article = await owner.client.reviseKnowledgeArticle(org, 'deposit-policy', {...articleInput, requestKey: 'kb-2', status: 'published', expectedRevision: 1});
  assert.equal((await owner.client.getPublishedKnowledgeArticle(org, 'deposit-policy', {locale: 'en'})).revisionId, article.revisionId);
});

test('AI: grounded answers use the labelled deterministic fallback and quotas; corrections suppress chunks', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const org = owner.organizationId;
  await owner.client.putKnowledgeChunk(org, 'deposit-1', {sourceKey: 'kb.billing', status: 'published',
    text: 'Deposits are refundable within 14 days when the job has not been scheduled. Contact support to start.'});
  await owner.client.putAIQuota(org, 'default', {periodStartsAt: 0, periodEndsAt: Date.now() + 86_400_000,
    maximumRequests: 2, maximumInputTokens: 100_000, maximumOutputTokens: 100_000,
    maximumInputTokensPerRequest: 10_000, maximumOutputTokensPerRequest: 4_096,
    allowedModelKeys: ['default'], allowedToolKeys: []});
  const question = {quotaKey: 'default', modelKey: 'default', question: 'Are deposits refundable?', maximumOutputTokens: 512};
  const answer = await owner.client.createGroundedAnswer(org, {...question, requestKey: 'q-1'});
  assert.equal(answer.provider, 'deterministic-fallback');
  assert.match(answer.fallbackNotice, /deterministic fallback/);
  assert.equal(answer.grounding.verdict, 'grounded');
  assert.equal((await owner.client.createGroundedAnswer(org, {...question, requestKey: 'q-1'})).answerId, answer.answerId);
  await expectApiError(owner.client.createGroundedAnswer(org, {...question, modelKey: 'other'.replace('other', 'unlisted'), requestKey: 'q-x'}),
    422, 'ai_gateway_rejected');
  const reviewer = await api.addMember(owner, 'kb-lead', ['ai-grounding:review']);
  const correction = await owner.client.submitGroundingCorrection(org, {requestKey: 'corr-1', answerId: answer.answerId,
    chunkId: 'deposit-1', correctionType: 'outdated', note: 'Window is now 7 days.'});
  await expectApiError(owner.client.reviewGroundingCorrection(org, correction.correctionId,
    {decision: 'accepted', expectedRevision: 1}), 422, 'retrieval_grounding_rejected');
  await reviewer.client.reviewGroundingCorrection(org, correction.correctionId, {decision: 'accepted', expectedRevision: 1});
  const after = await owner.client.createGroundedAnswer(org, {...question, requestKey: 'q-2'});
  assert.equal(after.grounding.verdict, 'ungrounded');
  assert.deepEqual(after.citations, []);
  await expectApiError(owner.client.createGroundedAnswer(org, {...question, requestKey: 'q-3'}), 422, 'ai_gateway_rejected');
});

test('AI: request drafts require the customer\'s approval; the turn director stays disabled', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const org = owner.organizationId;
  const draft = await owner.client.createRequestDraft(org, {requestKey: 'draft-1', serviceKey: 'plumbing.repair',
    fieldSpecs: [{key: 'description', type: 'text', required: true}, {key: 'postalCode', type: 'postal-code', required: true}],
    turns: [{role: 'customer', text: 'Description: kitchen tap leaks\nMy zip is 30301'}]});
  assert.equal(draft.extractionSource, 'deterministic-fallback');
  assert.deepEqual(draft.fields, {description: 'kitchen tap leaks', postalCode: '30301'});
  const approved = await owner.client.decideRequestDraft(org, draft.draftId, {decision: 'approve', expectedRevision: 1});
  assert.equal(approved.status, 'approved');
  await owner.client.configureFeatureFlag(org, 'ai.turn-director', {requestKey: 'f', environment: 'development',
    enabled: true, variantKey: 'on', expectedRevision: 0});
  const direction = await owner.client.directNextTurn(org, {maximumTotalTurns: 4, agents: [
    {agentKey: 'billing.agent', status: 'active', topics: ['billing'], maximumTurns: 2}],
  transcript: [{speaker: 'customer', text: 'billing question'}]});
  assert.deepEqual(direction, {directed: false, reason: 'disabled'});
  const enabled = await startApi({env: {TURN_DIRECTOR_ENABLED: 'true'}});
  t.after(enabled.close);
  const other = await enabled.provision();
  const flagOff = await other.client.directNextTurn(other.organizationId, {maximumTotalTurns: 4, agents: [
    {agentKey: 'billing.agent', status: 'active', topics: ['billing'], maximumTurns: 2}],
  transcript: [{speaker: 'customer', text: 'billing question'}]});
  assert.deepEqual(flagOff, {directed: false, reason: 'flag_off'});
});

test('trust: research, consent ledger, privacy export/deletion and incidents', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const org = owner.organizationId;
  const subject = owner.ownerSubjectId;
  const provider = await owner.client.createProviderOrganization(org, {legalName: 'Licensed LLC', publicName: 'Licensed'});
  await owner.client.registerResearchSource(org, 'state.board', {requestKey: 's-1', publisherName: 'State Board',
    baseUrl: 'https://licenses.state-board.gov/', allowedPathPrefixes: ['/lookup/'], license: 'public-record',
    retentionDays: 30, status: 'active', expectedRevision: 0});
  await owner.client.recordResearchFinding(org, {requestKey: 'f-1', sourceKey: 'state.board',
    providerOrganizationId: provider.providerOrganizationId, sourceUrl: 'https://licenses.state-board.gov/lookup/9',
    retrievedAt: Date.now() - 1000, contentDigest: 'sha256:' + 'c'.repeat(64), excerpt: 'License 9 active.',
    claimType: 'license', claimValue: 'active'});
  assert.equal((await owner.client.listResearchFindings(org, provider.providerOrganizationId)).items.length, 1);

  await owner.client.createCustomerProfile(org, {customerSubjectId: subject, displayName: 'Pat', email: 'pat@example.org', phone: null});
  await owner.client.recordConsent(org, {requestKey: 'c-1', subjectId: subject, purpose: 'ai-processing',
    decision: 'granted', noticeVersion: '2026-11', channel: 'web'});
  assert.equal((await owner.client.getConsentStatus(org, subject, 'ai-processing')).granted, true);
  await owner.client.recordConsent(org, {requestKey: 'c-2', subjectId: subject, purpose: 'ai-processing',
    decision: 'withdrawn', noticeVersion: '2026-11', channel: 'web'});
  const status = await owner.client.getConsentStatus(org, subject, 'ai-processing');
  assert.deepEqual({granted: status.granted, chainValid: status.chainValid}, {granted: false, chainValid: true});

  const exportRequest = await owner.client.openPrivacyRequest(org, {requestKey: 'p-1', subjectId: subject, kind: 'export'});
  const exported = await owner.client.getPrivacyExport(org, exportRequest.privacyRequestId);
  assert.deepEqual(exported.collections.map(collection => collection.kind).sort(),
    ['consent-entry', 'customer-profile', 'privacy-request']);
  const completed = await owner.client.completePrivacyRequest(org, exportRequest.privacyRequestId,
    {outcome: 'completed', expectedRevision: 1});
  assert.match(completed.resultDigest, /^sha256:[0-9a-f]{64}$/);
  const deletion = await owner.client.openPrivacyRequest(org, {requestKey: 'p-2', subjectId: subject, kind: 'deletion'});
  await owner.client.completePrivacyRequest(org, deletion.privacyRequestId, {outcome: 'completed', expectedRevision: 1});
  const profiles = await api.app.documents.list(org, 'customer-profile', {customerSubjectId: subject});
  assert.equal(profiles.length, 0);

  const incident = await owner.client.openIncident(org, {requestKey: 'i-1', dedupeKey: 'api.errors', title: 'Errors', severity: 'sev2'});
  await owner.client.transitionIncident(org, incident.incidentId, {status: 'acknowledged', note: 'Looking', postmortemUrl: null, expectedRevision: 1});
  await expectApiError(owner.client.transitionIncident(org, incident.incidentId,
    {status: 'resolved', note: 'Fixed', postmortemUrl: null, expectedRevision: 2}), 422, 'monitoring_rejected');
  const resolved = await owner.client.transitionIncident(org, incident.incidentId,
    {status: 'resolved', note: 'Fixed', postmortemUrl: 'https://docs.example.org/pm-1', expectedRevision: 2});
  assert.equal(resolved.status, 'resolved');
  assert.equal((await owner.client.getIncident(org, incident.incidentId)).revision, 3);
});

test('commerce and notifications report unavailable adapters and work with configured fakes', async t => {
  const disabled = await startApi();
  t.after(disabled.close);
  const owner = await disabled.provision();
  await expectApiError(owner.client.createPaymentIntent(owner.organizationId, {requestKey: 'pi-1', jobRoomId: 'room-1',
    paymentAccountId: 'acct-1', amountMinor: 1000, currency: 'USD'}), 503, 'dependency_unavailable');

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({url, init});
    if (url.startsWith('https://api.stripe.com/')) {
      const form = new URLSearchParams(init.body);
      return {ok: true, status: 200, json: async () => ({id: 'pi_test123', status: 'requires_payment_method',
        amount: Number(form.get('amount')), currency: form.get('currency'),
        transfer_data: {destination: form.get('transfer_data[destination]')}}), text: async () => ''};
    }
    if (url === 'https://api.resend.com/emails') return {ok: true, status: 200, json: async () => ({id: 'email_1'}), text: async () => ''};
    throw new Error('unexpected ' + url);
  };
  const live = await startApi({fetch: fakeFetch, env: {STRIPE_SECRET_KEY: 'sk_test_fake', RESEND_API_KEY: 're_test_fake',
    EMAIL_FROM: 'noreply@example.org'}});
  t.after(live.close);
  const seller = await live.provision();
  const org = seller.organizationId;
  const provider = await seller.client.createProviderOrganization(org, {legalName: 'Payee LLC', publicName: 'Payee'});
  await seller.client.putJobRoom(org, 'room-1', {customerSubjectId: seller.ownerSubjectId,
    providerOrganizationId: provider.providerOrganizationId, status: 'active'});
  await seller.client.putPaymentAccount(org, 'acct-1', {providerOrganizationId: provider.providerOrganizationId,
    processorAccountReference: 'acct_123', status: 'active', chargesEnabled: true, payoutsEnabled: true});
  const intent = await seller.client.createPaymentIntent(org, {requestKey: 'pi-1', jobRoomId: 'room-1',
    paymentAccountId: 'acct-1', amountMinor: 1000, currency: 'USD'});
  assert.equal(intent.processorIntentReference, 'pi_test123');
  assert.equal(calls[0].init.headers['idempotency-key'], 'pi-1');

  const profile = await seller.client.createCustomerProfile(org, {customerSubjectId: seller.ownerSubjectId,
    displayName: 'Pat', email: 'pat@example.org', phone: null});
  const queued = await seller.client.createNotificationIntent(org, {channel: 'email',
    recipientReference: 'customer-profile:' + profile.customerProfileId, templateKey: 'quote.received',
    payloadReference: 'quote-1', notBefore: 0, expiresAt: Date.now() + 60_000});
  const delivery = await seller.client.dispatchNotification(org, {requestKey: 'n-1', intentId: queued.intentId});
  assert.equal(delivery.providerMessageId, 'email_1');
  const emailCall = calls.find(call => call.url === 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(emailCall.init.body).to, ['pat@example.org']);
  await expectApiError(seller.client.dispatchNotification(org, {requestKey: 'n-2', intentId: (await seller.client.createNotificationIntent(org,
    {channel: 'sms', recipientReference: 'customer-profile:' + profile.customerProfileId, templateKey: 'quote.received',
      payloadReference: 'quote-1', notBefore: 0, expiresAt: Date.now() + 60_000})).intentId}), 503, 'dependency_unavailable');
});
