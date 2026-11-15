import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrivacyExport, completePrivacyRequest, openPrivacyRequest, planRetention, planSubjectDeletion,
} from '../packages/contracts/dist/data-privacy.js';

const REJECTED = {accepted: false, code: 'data_privacy_rejected'};
const DAY = 86_400_000;
const state = {organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'customer-1', organizationId: 'org-1', status: 'active', roleIds: ['customer']},
    {subjectId: 'dpo-1', organizationId: 'org-1', status: 'active', roleIds: ['dpo']}],
  roles: [{roleId: 'customer', organizationId: 'org-1', permissions: ['privacy:request']},
    {roleId: 'dpo', organizationId: 'org-1', permissions: ['privacy:manage']}]};
const self = {subjectId: 'customer-1', organizationId: 'org-1', resourceOrganizationId: 'org-1',
  requiredPermission: 'privacy:request'};
const dpo = {...self, subjectId: 'dpo-1', requiredPermission: 'privacy:manage'};
const records = [
  {kind: 'customer-profile', recordId: 'p-1', ownerSubjectId: 'customer-1', createdAt: 0, legalHold: false,
    data: {displayName: 'Pat', subjectId: 'customer-1'}},
  {kind: 'job-room-message', recordId: 'm-1', ownerSubjectId: 'customer-1', createdAt: 10, legalHold: false,
    data: {body: 'When can you come?', recipient: {subjectId: 'provider-9'}}},
  {kind: 'invoice', recordId: 'i-1', ownerSubjectId: 'customer-1', createdAt: 5, legalHold: false, data: {total: 100}},
  {kind: 'dispute', recordId: 'd-1', ownerSubjectId: 'customer-1', createdAt: 5, legalHold: true, data: {}},
  {kind: 'customer-profile', recordId: 'p-2', ownerSubjectId: 'customer-2', createdAt: 0, legalHold: false, data: {}},
];
const policies = [
  {kind: 'customer-profile', retainDays: 365, onExpiry: 'delete', statutoryRetention: false},
  {kind: 'job-room-message', retainDays: 30, onExpiry: 'delete', statutoryRetention: false},
  {kind: 'invoice', retainDays: 2555, onExpiry: 'anonymize', statutoryRetention: true},
];

function fixture() {
  const data = {requests: new Map(), byKey: new Map()}; let id = 0;
  const options = {now: () => 1_000, createOpaqueId: () => `pr-${++id}`,
    audit: {now: () => 1, createOpaqueId: () => `audit-${++id}`, sink: {append: async () => {}}},
    store: {
      getRequest: async (_o, rid) => data.requests.get(rid) ?? null,
      getRequestByKey: async (_o, key) => data.byKey.get(key) ?? null,
      commitRequest: async (current, next) => {
        if ((data.requests.get(next.privacyRequestId) ?? null) !== current) return false;
        data.requests.set(next.privacyRequestId, next); data.byKey.set(next.requestKey, next); return true;
      },
    }};
  return {data, options};
}

test('export contains only the subject records and redacts other subjects', () => {
  const exported = buildPrivacyExport('customer-1', records, 50);
  assert.equal(exported.recordCount, 4);
  assert.deepEqual(exported.collections.map(c => c.kind), ['customer-profile', 'dispute', 'invoice', 'job-room-message']);
  const message = exported.collections.find(c => c.kind === 'job-room-message').records[0];
  assert.equal(message.data.recipient.subjectId, '[redacted]');
  assert.equal(JSON.stringify(exported).includes('p-2'), false);
});

test('retention keeps unknown kinds and legal holds and acts on expiry', () => {
  const plan = planRetention(records, policies, 40 * DAY);
  const byId = Object.fromEntries(plan.map(a => [a.recordId, `${a.action}:${a.reason}`]));
  assert.deepEqual(byId, {'p-1': 'retain:within_retention', 'm-1': 'delete:retention_expired',
    'i-1': 'retain:within_retention', 'd-1': 'retain:legal_hold', 'p-2': 'retain:within_retention'});
  assert.deepEqual(planRetention(records, [...policies, policies[0]], 40 * DAY), []);
  assert.equal(planRetention([{...records[0], kind: 'unmapped'}], policies, 10_000 * DAY)[0].reason, 'no_policy');
});

test('subject deletion deletes, anonymizes statutory records and honours legal holds', () => {
  const plan = planSubjectDeletion('customer-1', records, policies);
  assert.deepEqual(plan.map(a => `${a.recordId}:${a.action}`), ['p-1:delete', 'm-1:delete', 'i-1:anonymize', 'd-1:retain']);
});

test('privacy request lifecycle with replay and officer completion', async () => {
  const {options} = fixture();
  const opened = await openPrivacyRequest(1, self, state, {requestKey: 'k-1', subjectId: 'customer-1', kind: 'export'}, options);
  assert.equal(opened.value.dueAt, 1_000 + 30 * DAY);
  assert.equal((await openPrivacyRequest(1, self, state, {requestKey: 'k-1', subjectId: 'customer-1', kind: 'export'}, options)).replayed, true);
  assert.deepEqual(await completePrivacyRequest(1, {...self, requiredPermission: 'privacy:manage'}, state,
    {privacyRequestId: opened.value.privacyRequestId, outcome: 'completed', resultDigest: 'sha256:' + 'b'.repeat(64), expectedRevision: 1}, options), REJECTED);
  const done = await completePrivacyRequest(1, dpo, state, {privacyRequestId: opened.value.privacyRequestId,
    outcome: 'completed', resultDigest: 'sha256:' + 'b'.repeat(64), expectedRevision: 1}, options);
  assert.equal(done.value.status, 'completed');
  assert.deepEqual(await completePrivacyRequest(1, dpo, state, {privacyRequestId: opened.value.privacyRequestId,
    outcome: 'denied', resultDigest: null, expectedRevision: 2}, options), REJECTED);
});

test('rejects authorization-negative privacy requests', async t => {
  const input = {requestKey: 'k-1', subjectId: 'customer-1', kind: 'deletion'};
  const cases = [
    ['missing tenant', {...self, organizationId: undefined}, state, input],
    ['cross-tenant', {...self, resourceOrganizationId: 'org-2'}, state, input],
    ['on behalf without manage', self, state, {...input, subjectId: 'customer-2'}],
    ['inactive membership', self, {...state, memberships: state.memberships.map(m => ({...m, status: 'suspended'}))}, input],
    ['bad kind', self, state, {...input, kind: 'rectify'}],
  ];
  for (const [name, request, authState, candidate] of cases) await t.test(name, async () => {
    const {options} = fixture();
    assert.deepEqual(await openPrivacyRequest(1, request, authState, candidate, options), REJECTED);
  });
  await t.test('officer may file on behalf', async () => {
    const {options} = fixture();
    assert.equal((await openPrivacyRequest(1, dpo, state, {...input, subjectId: 'customer-2'}, options)).accepted, true);
  });
});
