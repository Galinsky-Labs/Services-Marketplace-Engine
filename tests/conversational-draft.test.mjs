import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversationalDraft, decideConversationalDraft, extractDraftFieldsDeterministic,
} from '../packages/contracts/dist/conversational-draft.js';

const REJECTED = {accepted: false, code: 'conversational_draft_rejected'};
const state = {organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'customer-1', organizationId: 'org-1', status: 'active', roleIds: ['customer']},
    {subjectId: 'customer-2', organizationId: 'org-1', status: 'active', roleIds: ['customer']}],
  roles: [{roleId: 'customer', organizationId: 'org-1', permissions: ['request-drafts:create']}]};
const request = {subjectId: 'customer-1', organizationId: 'org-1', resourceOrganizationId: 'org-1',
  requiredPermission: 'request-drafts:create'};
const fieldSpecs = [{key: 'description', type: 'text', required: true},
  {key: 'postalCode', type: 'postal-code', required: true},
  {key: 'preferredDate', type: 'date', required: false},
  {key: 'budget', type: 'number', required: false}];
const turns = [
  {role: 'assistant', text: 'What do you need help with?'},
  {role: 'customer', text: 'Description: replace a leaking kitchen faucet\nBudget: $250'},
  {role: 'assistant', text: 'Where and when?'},
  {role: 'customer', text: 'I am at 30301 and could do 2026-12-01'},
];

function fixture() {
  const data = {drafts: new Map(), byRequest: new Map()}; let id = 0; let now = 1_000;
  const options = {now: () => now, createOpaqueId: () => `draft-${++id}`,
    audit: {now: () => 1, createOpaqueId: () => `audit-${++id}`, sink: {append: async () => {}}},
    store: {
      getDraft: async (_o, draftId) => data.drafts.get(draftId) ?? null,
      getDraftByRequestKey: async (_o, key) => data.byRequest.get(key) ?? null,
      commitDraft: async (current, next) => {
        if ((data.drafts.get(next.draftId) ?? null) !== current) return false;
        data.drafts.set(next.draftId, next); data.byRequest.set(next.requestKey, next); return true;
      },
    }};
  return {data, options, advance: ms => { now += ms; }};
}

test('deterministic fallback extracts only explicit customer statements', () => {
  const fields = extractDraftFieldsDeterministic(turns, fieldSpecs);
  assert.deepEqual(fields, {description: 'replace a leaking kitchen faucet', postalCode: '30301',
    preferredDate: '2026-12-01', budget: 250});
  assert.deepEqual(extractDraftFieldsDeterministic([{role: 'assistant', text: 'Description: invented'},
    {role: 'customer', text: 'hello'}], fieldSpecs), {});
});

test('customer approves a complete draft; approval is single-use', async () => {
  const {options} = fixture();
  const proposedFields = extractDraftFieldsDeterministic(turns, fieldSpecs);
  const input = {requestKey: 'req-1', serviceKey: 'plumbing.repair', fieldSpecs, turns, proposedFields,
    extractionSource: 'deterministic-fallback'};
  const created = await createConversationalDraft(1, request, state, input, options);
  assert.equal(created.accepted, true);
  assert.equal(created.value.status, 'pending_approval');
  assert.deepEqual(created.value.missingFieldKeys, []);
  assert.equal((await createConversationalDraft(1, request, state, input, options)).replayed, true);
  const otherCustomer = await decideConversationalDraft(1, {...request, subjectId: 'customer-2'}, state,
    {draftId: created.value.draftId, decision: 'approve', expectedRevision: 1}, options);
  assert.deepEqual(otherCustomer, REJECTED);
  const approved = await decideConversationalDraft(1, request, state,
    {draftId: created.value.draftId, decision: 'approve', expectedRevision: 1}, options);
  assert.equal(approved.value.status, 'approved');
  assert.deepEqual(await decideConversationalDraft(1, request, state,
    {draftId: created.value.draftId, decision: 'approve', expectedRevision: 2}, options), REJECTED);
});

test('incomplete or expired drafts cannot be approved', async () => {
  const {options, advance} = fixture();
  const partial = await createConversationalDraft(1, request, state, {requestKey: 'req-2',
    serviceKey: 'plumbing.repair', fieldSpecs, turns, proposedFields: {description: 'Fix sink'},
    extractionSource: 'ai-provider'}, options);
  assert.deepEqual(partial.value.missingFieldKeys, ['postalCode']);
  assert.deepEqual(await decideConversationalDraft(1, request, state,
    {draftId: partial.value.draftId, decision: 'approve', expectedRevision: 1}, options), REJECTED);
  advance(8 * 86_400_000);
  assert.deepEqual(await decideConversationalDraft(1, request, state,
    {draftId: partial.value.draftId, decision: 'reject', expectedRevision: 1}, options), REJECTED);
});

test('rejects contaminated extraction and authorization-negative cases', async t => {
  const base = {requestKey: 'req-3', serviceKey: 'plumbing.repair', fieldSpecs, turns,
    proposedFields: {description: 'Fix sink', postalCode: '30301'}, extractionSource: 'ai-provider'};
  const cases = [
    ['unknown field', request, state, {...base, proposedFields: {...base.proposedFields, ssn: '1'}}],
    ['invalid value', request, state, {...base, proposedFields: {...base.proposedFields, budget: 'lots'}}],
    ['unlabelled source', request, state, {...base, extractionSource: 'guess'}],
    ['no customer turn', request, state, {...base, turns: [{role: 'assistant', text: 'hi'}]}],
    ['missing tenant', {...request, organizationId: undefined}, state, base],
    ['cross-tenant', {...request, resourceOrganizationId: 'org-2'}, state, base],
    ['missing permission', {...request, requiredPermission: 'leads:create'}, state, base],
    ['inactive membership', request, {...state, memberships: state.memberships.map(m => ({...m, status: 'suspended'}))}, base],
  ];
  for (const [name, candidateRequest, authState, input] of cases) await t.test(name, async () => {
    const {options} = fixture();
    assert.deepEqual(await createConversationalDraft(1, candidateRequest, authState, input, options), REJECTED);
  });
});
