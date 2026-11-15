import test from 'node:test';
import assert from 'node:assert/strict';
import {startApi} from './support/http-app.mjs';

// Smoke-level load contract for the in-memory adapter on CI hardware. It guards against
// regressions (serialization bugs, leaks, unbounded work per request); it is not a
// capacity test of the production deployment.
test('600 concurrent mixed requests complete without errors within budget', async t => {
  const api = await startApi({env: {RATE_LIMIT_PER_MINUTE: '10000'}});
  t.after(api.close);
  const owner = await api.provision();
  const org = owner.organizationId;
  const provider = await owner.client.createProviderOrganization(org, {legalName: 'Load LLC', publicName: 'Load'});
  const requests = [];
  for (let index = 0; index < 600; index += 1) {
    const kind = index % 4;
    if (kind === 0) requests.push(['GET', '/health', undefined]);
    else if (kind === 1) requests.push(['GET', `/v1/organizations/${org}/providers/${provider.providerOrganizationId}`, undefined]);
    else if (kind === 2) requests.push(['POST', `/v1/organizations/${org}/customers`, {customerSubjectId: 'subject-' + index,
      displayName: 'Customer ' + index, email: null, phone: null}]);
    else requests.push(['POST', `/v1/organizations/${org}/consents`, {requestKey: 'consent-' + index,
      subjectId: owner.ownerSubjectId, purpose: 'marketing-email', decision: index % 8 === 3 ? 'granted' : 'withdrawn',
      noticeVersion: 'v1', channel: 'web'}]);
  }
  const started = performance.now();
  const latencies = [];
  const results = await Promise.all(requests.map(async ([method, path, body]) => {
    const begin = performance.now();
    const response = await api.raw(method, path, {token: owner.token, body});
    latencies.push(performance.now() - begin);
    return response.status;
  }));
  const elapsed = performance.now() - started;
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  assert.equal(results.filter(status => status >= 500).length, 0);
  assert.equal(results.filter((status, index) => index % 4 === 2 && status !== 201).length, 0);
  // Concurrent consent appends race on the chain head: each either appends or is
  // rejected by compare-and-append, and the stored chain must stay valid.
  const status = await owner.client.getConsentStatus(org, owner.ownerSubjectId, 'marketing-email');
  assert.equal(status.chainValid, true);
  assert.ok(elapsed < 20_000, 'elapsed ' + elapsed);
  assert.ok(p95 < 5_000, 'p95 ' + p95);
});
