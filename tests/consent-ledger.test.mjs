import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {evaluateConsent, recordConsent, verifyConsentChain} from '../packages/contracts/dist/consent-ledger.js';

const REJECTED = {accepted: false, code: 'consent_ledger_rejected'};
const sha256 = value => 'sha256:' + crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const state = {organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'customer-1', organizationId: 'org-1', status: 'active', roleIds: ['customer']},
    {subjectId: 'support-1', organizationId: 'org-1', status: 'active', roleIds: ['support']}],
  roles: [{roleId: 'customer', organizationId: 'org-1', permissions: ['consent:record']},
    {roleId: 'support', organizationId: 'org-1', permissions: ['consent:manage']}]};
const self = {subjectId: 'customer-1', organizationId: 'org-1', resourceOrganizationId: 'org-1',
  requiredPermission: 'consent:record'};
const base = {subjectId: 'customer-1', purpose: 'marketing-email', noticeVersion: '2026-11',
  channel: 'web'};

function fixture() {
  const chain = []; let id = 0; let now = 1_000;
  const options = {sha256, now: () => now, createOpaqueId: () => `entry-${++id}`,
    audit: {now: () => 1, createOpaqueId: () => `audit-${++id}`, sink: {append: async () => {}}},
    store: {
      getHead: async () => chain.at(-1) ?? null,
      getByRequestKey: async (_o, key) => chain.find(entry => entry.requestKey === key) ?? null,
      append: async (expected, entry) => {
        if ((chain.at(-1) ?? null) !== expected) return false; chain.push(entry); return true;
      },
    }};
  return {chain, options, tick: () => { now += 10; }};
}

test('records a hash chain and evaluates the latest decision per purpose', async () => {
  const {chain, options, tick} = fixture();
  assert.equal((await recordConsent(1, self, state, {...base, requestKey: 'r-1', decision: 'granted'}, options)).accepted, true);
  tick();
  const withdrawn = await recordConsent(1, self, state, {...base, requestKey: 'r-2', decision: 'withdrawn'}, options);
  assert.equal(withdrawn.value.sequence, 2);
  assert.equal(withdrawn.value.previousHash, chain[0].entryHash);
  assert.equal((await recordConsent(1, self, state, {...base, requestKey: 'r-2', decision: 'withdrawn'}, options)).replayed, true);
  assert.equal(verifyConsentChain(chain, 'org-1', 'customer-1', sha256), true);
  assert.equal(evaluateConsent(chain, 'org-1', 'customer-1', 'marketing-email', 1_005, sha256).granted, true);
  assert.equal(evaluateConsent(chain, 'org-1', 'customer-1', 'marketing-email', 2_000, sha256).granted, false);
  assert.equal(evaluateConsent(chain, 'org-1', 'customer-1', 'ai-processing', 2_000, sha256).granted, false);
  assert.equal(evaluateConsent(chain, 'org-1', 'customer-1', 'marketing-email', 1_005, sha256, '2027-01').granted, false);
});

test('tampering anywhere in the chain fails closed', async () => {
  const {chain, options} = fixture();
  await recordConsent(1, self, state, {...base, requestKey: 'r-1', decision: 'withdrawn'}, options);
  await recordConsent(1, self, state, {...base, requestKey: 'r-2', purpose: 'ai-processing', decision: 'granted'}, options);
  const forged = [{...chain[0], decision: 'granted'}, chain[1]];
  assert.equal(verifyConsentChain(forged, 'org-1', 'customer-1', sha256), false);
  const status = evaluateConsent(forged, 'org-1', 'customer-1', 'ai-processing', 5_000, sha256);
  assert.deepEqual({granted: status.granted, chainValid: status.chainValid}, {granted: false, chainValid: false});
  assert.equal(verifyConsentChain([chain[1]], 'org-1', 'customer-1', sha256), false);
  assert.equal(verifyConsentChain(chain, 'org-2', 'customer-1', sha256), false);
});

test('on-behalf recording needs consent:manage and the support channel', async () => {
  const {options} = fixture();
  const staff = {...self, subjectId: 'support-1', requiredPermission: 'consent:manage'};
  assert.deepEqual(await recordConsent(1, staff, state, {...base, requestKey: 'r-1', decision: 'granted'}, options), REJECTED);
  const recorded = await recordConsent(1, staff, state, {...base, requestKey: 'r-1', decision: 'granted', channel: 'support'}, options);
  assert.equal(recorded.value.recordedBySubjectId, 'support-1');
  assert.deepEqual(await recordConsent(1, {...self, subjectId: 'customer-1'}, state,
    {...base, subjectId: 'customer-2', requestKey: 'r-2', decision: 'granted', channel: 'support'}, options), REJECTED);
});

test('rejects authorization-negative and malformed requests', async t => {
  const input = {...base, requestKey: 'r-1', decision: 'granted'};
  const cases = [
    ['missing tenant', {...self, organizationId: undefined}, state, input],
    ['cross-tenant', {...self, resourceOrganizationId: 'org-2'}, state, input],
    ['missing permission', {...self, requiredPermission: 'consent:manage'}, state, input],
    ['inactive membership', self, {...state, memberships: state.memberships.map(m => ({...m, status: 'revoked'}))}, input],
    ['unknown purpose', self, state, {...input, purpose: 'telepathy'}],
    ['bad notice version', self, state, {...input, noticeVersion: 'v 1'}],
  ];
  for (const [name, request, authState, candidate] of cases) await t.test(name, async () => {
    const {options} = fixture();
    assert.deepEqual(await recordConsent(1, request, authState, candidate, options), REJECTED);
  });
  await t.test('concurrent append conflict', async () => {
    const {options} = fixture();
    options.store.append = async () => false;
    assert.deepEqual(await recordConsent(1, self, state, input, options), REJECTED);
  });
});
