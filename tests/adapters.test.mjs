import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  AnthropicAIProvider, DeterministicAIProvider, ExpoPushAdapter, HttpCredentialCheckAdapter, HttpEsignAdapter,
  ResendEmailAdapter, S3QuarantineObjectStore, StripeConnectAdapter, TwilioSmsAdapter, answerFromChunks,
  createAdapters, esignEventPayload, extractDraftFields, presignS3Url, verifyStripeSignature,
} from '../apps/api/dist/index.js';
import {MemoryDocumentStore} from '../apps/api/dist/index.js';

const response = (body, status = 200) => ({ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body)});

test('every adapter is disabled without configuration and reports no secrets', () => {
  const adapters = createAdapters({}, new MemoryDocumentStore(), () => 0);
  for (const adapter of Object.values(adapters)) assert.equal(adapter.status.mode, 'disabled', adapter.status.name);
  const configured = createAdapters({STRIPE_SECRET_KEY: 'sk_test_ZZQQXX', RESEND_API_KEY: 're_live_ZZQQXX', EMAIL_FROM: 'a@b.org',
    ANTHROPIC_API_KEY: 'sk-ant-ZZQQXX-0123456789', BACKGROUND_CHECK_MODE: 'sandbox'}, new MemoryDocumentStore(), () => 0);
  assert.equal(configured.stripe.status.mode, 'sandbox');
  assert.equal(configured.email.status.mode, 'live');
  assert.equal(configured.ai.status.mode, 'live');
  assert.equal(configured.credentialCheck.status.mode, 'sandbox');
  assert.equal(JSON.stringify(Object.values(configured).map(adapter => adapter.status)).includes('ZZQQXX'), false);
});

test('Stripe Connect adapter sends an idempotent destination charge and validates the echo', async () => {
  let call;
  const stripe = new StripeConnectAdapter('sk_test_x', async (url, init) => {
    call = {url, init};
    return response({id: 'pi_1', status: 'requires_capture', amount: 2500, currency: 'usd', transfer_data: {destination: 'acct_9'}});
  });
  const request = {idempotencyKey: 'key-1', destinationAccountReference: 'acct_9', amountMinor: 2500, currency: 'USD',
    metadata: {organizationId: 'org', jobRoomId: 'room', paymentIntentId: 'key-1'}};
  assert.deepEqual(await stripe.createPaymentIntent(request), {processor: 'stripe_connect', processorIntentReference: 'pi_1',
    destinationAccountReference: 'acct_9', amountMinor: 2500, currency: 'USD', status: 'authorized'});
  assert.equal(call.url, 'https://api.stripe.com/v1/payment_intents');
  assert.equal(call.init.headers['idempotency-key'], 'key-1');
  assert.equal(new URLSearchParams(call.init.body).get('transfer_data[destination]'), 'acct_9');
  const tampered = new StripeConnectAdapter('sk_test_x', async () =>
    response({id: 'pi_1', status: 'succeeded', amount: 1, currency: 'usd', transfer_data: {destination: 'acct_9'}}));
  await assert.rejects(tampered.createPaymentIntent(request));
  await assert.rejects(new StripeConnectAdapter(undefined).createPaymentIntent(request), /disabled/);
});

test('Stripe webhook signatures are verified with tolerance', () => {
  const secret = 'whsec_test';
  const payload = '{"id":"evt_1"}';
  const signature = crypto.createHmac('sha256', secret).update('1000.' + payload).digest('hex');
  assert.equal(verifyStripeSignature(payload, `t=1000,v1=${signature}`, secret, 1100), true);
  assert.equal(verifyStripeSignature(payload, `t=1000,v1=${signature}`, secret, 2000), false);
  assert.equal(verifyStripeSignature(payload + ' ', `t=1000,v1=${signature}`, secret, 1100), false);
  assert.equal(verifyStripeSignature(payload, undefined, secret, 1100), false);
});

test('credential check sandbox never verifies; live mode validates vendor output', async () => {
  const request = {credentialCheckId: 'cc-1', organizationId: 'o', providerOrganizationId: 'p', subjectReference: 's',
    credentialType: 'license', attachmentSha256: 'a'.repeat(64), purposeCode: 'onboarding', consentedAt: 0};
  const sandbox = new HttpCredentialCheckAdapter({mode: 'sandbox'}, () => 5);
  assert.equal((await sandbox.check(request)).outcome, 'review');
  const live = new HttpCredentialCheckAdapter({url: 'https://vendor.example.org', apiKey: 'k'}, () => 5,
    async () => response({reference: 'v-1', outcome: 'verified', validUntil: '2027-01-01T00:00:00Z'}));
  const result = await live.check(request);
  assert.equal(result.outcome, 'verified');
  assert.equal(result.validUntil, Date.parse('2027-01-01T00:00:00Z'));
  const bad = new HttpCredentialCheckAdapter({url: 'https://vendor.example.org', apiKey: 'k'}, () => 5,
    async () => response({reference: 'v-1', outcome: 'approved'}));
  await assert.rejects(bad.check(request));
  await assert.rejects(new HttpCredentialCheckAdapter({}, () => 0).check(request), /disabled/);
});

test('e-sign adapter creates envelopes and verifies HMAC-signed events', async () => {
  const adapter = new HttpEsignAdapter({url: 'https://esign.example.org', apiKey: 'k', webhookSecret: 'shh'},
    async () => response({id: 'env-1', signingUrl: 'https://esign.example.org/sign/1'}));
  assert.deepEqual(await adapter.createEnvelope({envelopeId: 'e', documentDigest: 'sha256:' + 'a'.repeat(64),
    customerSubjectId: 'c'}), {providerEnvelopeId: 'env-1', signingUrl: 'https://esign.example.org/sign/1'});
  const event = {contractVersion: 1, providerEnvelopeId: 'env-1', documentDigest: 'sha256:' + 'a'.repeat(64),
    status: 'signed', occurredAt: 10};
  const signature = crypto.createHmac('sha256', 'shh').update(esignEventPayload(event)).digest('hex');
  assert.equal(await adapter.verifyEvent({...event, evidence: {signature}}), true);
  assert.equal(await adapter.verifyEvent({...event, occurredAt: 11, evidence: {signature}}), false);
  assert.equal(await new HttpEsignAdapter({}).verifyEvent({...event, evidence: {signature}}), false);
});

test('email, SMS and push adapters resolve references and call their providers', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({url, init});
    if (url.includes('resend')) return response({id: 'em_1'});
    if (url.includes('twilio')) return response({sid: 'SM1'});
    return response({data: {status: 'ok', id: 'push-1'}});
  };
  const resolve = async (_org, reference, channel) => reference === 'ref-1'
    ? {email: 'a@example.org', sms: '+15550100', push: 'ExponentPushToken[x]'}[channel] : null;
  const command = {organizationId: 'o', requestKey: 'r', intentId: 'i', recipientReference: 'ref-1',
    templateKey: 'generic.update', payloadReference: 'p-1'};
  const email = new ResendEmailAdapter({apiKey: 're_x', from: 'n@example.org'}, resolve, 'https://app.example.org', fake);
  const sms = new TwilioSmsAdapter({accountSid: 'AC1', authToken: 't', from: '+15550000'}, resolve, 'https://app.example.org', fake);
  const push = new ExpoPushAdapter({provider: 'expo'}, resolve, 'https://app.example.org', fake);
  assert.equal((await email.send(command)).providerMessageId, 'em_1');
  assert.equal((await sms.send(command)).providerMessageId, 'SM1');
  assert.equal((await push.send(command)).providerMessageId, 'push-1');
  assert.match(calls[1].init.headers.authorization, /^Basic /);
  assert.equal(new URLSearchParams(calls[1].init.body).get('To'), '+15550100');
  await assert.rejects(email.send({...command, recipientReference: 'unknown'}));
  await assert.rejects(email.send({...command, templateKey: 'not.a.template'}));
  await assert.rejects(new ExpoPushAdapter({}, resolve, 'https://x.org', fake).send(command), /disabled/);
});

test('S3 presigning matches the AWS Signature V4 reference vector', () => {
  const url = presignS3Url({endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'examplebucket',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', pathStyle: false},
  'GET', 'test.txt', 86400, new Date('2013-05-24T00:00:00Z'));
  assert.match(url, /^https:\/\/examplebucket\.s3\.amazonaws\.com\/test\.txt\?/);
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('object store is disabled without settings and presigns uploads when configured', async () => {
  await assert.rejects(new S3QuarantineObjectStore({}, () => new Date()).createUploadUrl('k', 'text/plain', 1), /disabled/);
  const store = new S3QuarantineObjectStore({S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', S3_BUCKET: 'quarantine',
    S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret'}, () => new Date('2026-01-01T00:00:00Z'));
  const upload = await store.createUploadUrl('org/a b.pdf', 'application/pdf', 10);
  assert.match(upload, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/quarantine\/org\/a%20b\.pdf\?X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(upload, /X-Amz-Expires=900/);
});

test('AI: deterministic fallback is labelled; the live provider uses the Anthropic SDK request shape', async () => {
  const chunks = [{organizationId: 'o', chunkId: 'c1', sourceKey: 'kb', status: 'published', revision: 1,
    text: 'Deposits are refundable within 14 days. Other text.'}];
  const fallback = await answerFromChunks(new DeterministicAIProvider(), 'o', 'refundable deposits?', chunks, new Set(), 256);
  assert.equal(fallback.provider, 'deterministic-fallback');
  assert.deepEqual(fallback.citations, [{chunkId: 'c1', quote: 'Deposits are refundable within 14 days.'}]);

  let captured;
  const fakeClient = {beta: {messages: {create: async params => {
    captured = params;
    return {model: params.model, stop_reason: 'end_turn', usage: {input_tokens: 10, output_tokens: 5},
      content: [{type: 'text', text: '{"answer":"Yes, within 14 days.","citations":[{"chunkId":"c1","quote":"refundable within 14 days"}]}'}]};
  }}}};
  const live = new AnthropicAIProvider('sk-ant-test', 'claude-opus-5-5', fakeClient);
  const answer = await answerFromChunks(live, 'o', 'refundable deposits?', chunks, new Set(), 256);
  assert.equal(answer.provider, 'anthropic');
  assert.deepEqual(answer.citations, [{chunkId: 'c1', quote: 'refundable within 14 days'}]);
  assert.equal(captured.model, 'claude-opus-5-5');
  assert.deepEqual(captured.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(captured.fallbacks, 'default');
  assert.equal('temperature' in captured, false);

  const refusing = new AnthropicAIProvider('k', 'claude-opus-5-5', {beta: {messages: {create: async () =>
    ({model: 'claude-opus-5-5', stop_reason: 'refusal', usage: {input_tokens: 1, output_tokens: 0}, content: []})}}});
  const refused = await answerFromChunks(refusing, 'o', 'refundable deposits?', chunks, new Set(), 256);
  assert.equal(refused.provider, 'deterministic-fallback');

  const extraction = await extractDraftFields(new AnthropicAIProvider('k', 'm', {beta: {messages: {create: async () =>
    ({model: 'm', stop_reason: 'end_turn', usage: {input_tokens: 1, output_tokens: 1},
      content: [{type: 'text', text: '{"description":"Leak","secret":"x","budget":{"nested":true}}'}]})}}}),
  [{role: 'customer', text: 'leak'}], [{key: 'description', type: 'text', required: true}, {key: 'budget', type: 'number', required: false}]);
  assert.deepEqual(extraction, {fields: {description: 'Leak'}, source: 'ai-provider'});
});
