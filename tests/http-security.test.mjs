import test from 'node:test';
import assert from 'node:assert/strict';
import {SECURITY_HEADERS, createRateLimiter} from '../packages/contracts/dist/index.js';
import {ADMIN_TOKEN, startApi} from './support/http-app.mjs';

test('every response carries the security headers, including errors', async t => {
  const api = await startApi();
  t.after(api.close);
  for (const path of ['/health', '/does-not-exist', '/v1/organizations/x/customers/y']) {
    const response = await api.raw('GET', path);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(response.headers.get(name), value, path + ' ' + name);
    }
    assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  }
});

test('authentication failures are uniform and never reveal which part was wrong', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const path = `/v1/organizations/${owner.organizationId}/audit-events`;
  const [, keyId, secret] = /^sme_([a-z0-9]{24})_([0-9a-f]{64})$/.exec(owner.token);
  const tampered = 'sme_' + keyId + '_' + (secret[0] === 'a' ? 'b' : 'a') + secret.slice(1);
  for (const token of [undefined, 'garbage', tampered, 'sme_' + 'z'.repeat(24) + '_' + secret,
    'smeadmin_' + 'b'.repeat(64)]) {
    const response = await api.raw('GET', path, {token});
    assert.equal(response.status, 401, String(token));
    assert.deepEqual(response.json, {code: 'unauthenticated'});
  }
  assert.equal((await api.raw('GET', path, {token: owner.token})).status, 200);
});

test('tenant isolation: keys only work for their own organization', async t => {
  const api = await startApi();
  t.after(api.close);
  const first = await api.provision('First');
  const second = await api.provision('Second');
  const profile = await first.client.createCustomerProfile(first.organizationId,
    {customerSubjectId: first.ownerSubjectId, displayName: 'Private Person', email: null, phone: null});
  const crossRead = await api.raw('GET',
    `/v1/organizations/${first.organizationId}/customers/${profile.customerProfileId}`, {token: second.token});
  assert.equal(crossRead.status, 403);
  assert.deepEqual(crossRead.json, {code: 'authorization_denied'});
  assert.equal(crossRead.text.includes('Private Person'), false);
  // Second org cannot see the profile through its own path either (tenant-scoped storage).
  const ownPath = await api.raw('GET',
    `/v1/organizations/${second.organizationId}/customers/${profile.customerProfileId}`, {token: second.token});
  assert.deepEqual({status: ownPath.status, json: ownPath.json}, {status: 422, json: {code: 'customer_rejected'}});
  const denied = (await api.app.identity.listAuditEvents(first.organizationId, 50))
    .filter(event => event.outcome === 'denied');
  assert.ok(denied.some(event => event.subjectId === second.ownerSubjectId));
});

test('tenant keys cannot use platform-admin routes and vice versa', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  assert.equal((await api.raw('POST', '/v1/admin/organizations', {token: owner.token, body: {name: 'x'}})).status, 403);
  assert.equal((await api.raw('GET', `/v1/organizations/${owner.organizationId}/audit-events`, {token: ADMIN_TOKEN})).status, 403);
  const noAdmin = await startApi({env: {PLATFORM_ADMIN_TOKEN: 'too-short'}});
  t.after(noAdmin.close);
  assert.equal((await noAdmin.raw('POST', '/v1/admin/organizations', {token: 'too-short', body: {name: 'x'}})).status, 401);
});

test('suspended members and missing permissions are denied before domain code runs', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const member = await api.addMember(owner, 'reader', ['customer-profile:read']);
  const path = `/v1/organizations/${owner.organizationId}/customers`;
  const body = {customerSubjectId: member.subjectId, displayName: 'X', email: null, phone: null};
  assert.equal((await api.raw('POST', path, {token: member.token, body})).status, 403);
  await owner.client.putMembership(owner.organizationId, member.subjectId, {status: 'suspended', roleIds: ['reader']});
  assert.equal((await api.raw('GET', `/v1/organizations/${owner.organizationId}/customers/c`, {token: member.token})).status, 403);
});

test('input hardening: version header, media type, JSON, schema, body size and method', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const path = `/v1/organizations/${owner.organizationId}/providers`;
  const valid = {legalName: 'Valid LLC', publicName: 'Valid'};
  assert.deepEqual((await api.raw('POST', path, {token: owner.token, body: valid,
    headers: {'x-contract-version': '2'}})).json, {code: 'unsupported_contract_version'});
  assert.equal((await api.raw('POST', path, {token: owner.token, rawBody: JSON.stringify(valid),
    headers: {'content-type': 'text/plain'}})).status, 415);
  assert.equal((await api.raw('POST', path, {token: owner.token, rawBody: '{"legalName":'})).json.code, 'invalid_request');
  const extra = await api.raw('POST', path, {token: owner.token, body: {...valid, isAdmin: true}});
  assert.deepEqual(extra.json, {code: 'invalid_request', message: '$.isAdmin: unexpected property'});
  const proto = await api.raw('POST', path, {token: owner.token, rawBody: '{"legalName":"A","publicName":"B","__proto__":{"x":1}}'});
  assert.equal(proto.status, 400);
  const huge = await api.raw('POST', path, {token: owner.token, rawBody: JSON.stringify({legalName: 'x'.repeat(300_000), publicName: 'y'})});
  assert.deepEqual({status: huge.status, json: huge.json}, {status: 413, json: {code: 'payload_too_large'}});
  assert.equal((await api.raw('DELETE', path, {token: owner.token})).status, 405);
  assert.equal((await api.raw('GET', '/' + 'a'.repeat(3_000))).status, 414);
});

test('errors never leak stack traces or internal messages', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  api.app.documents.get = async () => { throw new Error('connection to db-internal-host:5432 refused'); };
  const response = await api.raw('GET', `/v1/organizations/${owner.organizationId}/incidents/i-1`, {token: owner.token});
  assert.deepEqual({status: response.status, json: response.json}, {status: 500, json: {code: 'internal_error'}});
  assert.equal(response.text.includes('db-internal-host'), false);
});

test('rate limiting returns 429 per credential', async t => {
  const api = await startApi({env: {RATE_LIMIT_PER_MINUTE: '10'}});
  t.after(api.close);
  const statuses = [];
  for (let index = 0; index < 14; index += 1) statuses.push((await api.raw('GET', '/health')).status);
  assert.equal(statuses.slice(0, 10).every(status => status === 200), true);
  assert.equal(statuses.at(-1), 429);
  let now = 0;
  const limiter = createRateLimiter({capacity: 2, refillPerSecond: 1, maximumKeys: 1, now: () => now});
  assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('a')], [true, true, false]);
  now = 1_000;
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('b'), true);
  assert.throws(() => createRateLimiter({capacity: 0, refillPerSecond: 1, maximumKeys: 1, now: () => 0}));
});

test('CORS is allow-list only', async t => {
  const api = await startApi({env: {CORS_ORIGINS: 'https://app.example.org, http://insecure.example.org'}});
  t.after(api.close);
  const allowed = await api.raw('GET', '/health', {headers: {origin: 'https://app.example.org'}});
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.org');
  const insecure = await api.raw('GET', '/health', {headers: {origin: 'http://insecure.example.org'}});
  assert.equal(insecure.headers.get('access-control-allow-origin'), null);
  const other = await api.raw('GET', '/health', {headers: {origin: 'https://evil.example.org'}});
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});
