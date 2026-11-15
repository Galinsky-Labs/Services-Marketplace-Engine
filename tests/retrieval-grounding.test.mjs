import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retrieveChunks, reviewGroundingCorrection, submitGroundingCorrection, suppressedChunkIds,
  verifyGrounding,
} from '../packages/contracts/dist/retrieval-grounding.js';

const REJECTED = {accepted: false, code: 'retrieval_grounding_rejected'};
const chunks = [
  {organizationId: 'org-1', chunkId: 'c-1', sourceKey: 'kb.billing', status: 'published', revision: 1,
    text: 'Deposits are refundable within 14 days when the job has not been scheduled.'},
  {organizationId: 'org-1', chunkId: 'c-2', sourceKey: 'kb.scheduling', status: 'published', revision: 1,
    text: 'Providers confirm appointments within one business day of a scheduling hold.'},
  {organizationId: 'org-1', chunkId: 'c-3', sourceKey: 'kb.old', status: 'retired', revision: 2,
    text: 'Deposits are never refundable.'},
  {organizationId: 'org-2', chunkId: 'c-4', sourceKey: 'kb.other', status: 'published', revision: 1,
    text: 'Deposits are refundable within 90 days for another tenant.'},
];
const state = {organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [
    {subjectId: 'agent-1', organizationId: 'org-1', status: 'active', roleIds: ['support']},
    {subjectId: 'lead-1', organizationId: 'org-1', status: 'active', roleIds: ['lead']}],
  roles: [{roleId: 'support', organizationId: 'org-1', permissions: ['ai-grounding:correct']},
    {roleId: 'lead', organizationId: 'org-1', permissions: ['ai-grounding:correct', 'ai-grounding:review']}]};
const submitRequest = {subjectId: 'agent-1', organizationId: 'org-1', resourceOrganizationId: 'org-1',
  requiredPermission: 'ai-grounding:correct'};
const reviewRequest = {subjectId: 'lead-1', organizationId: 'org-1', resourceOrganizationId: 'org-1',
  requiredPermission: 'ai-grounding:review'};

function fixture() {
  const data = {corrections: new Map(), byRequest: new Map()}; let id = 0;
  const options = {now: () => 100, createOpaqueId: () => `id-${++id}`,
    audit: {now: () => 1, createOpaqueId: () => `audit-${++id}`, sink: {append: async () => {}}},
    store: {
      getChunk: async (o, chunkId) => chunks.find(c => c.organizationId === o && c.chunkId === chunkId) ?? null,
      getCorrection: async (_o, cid) => data.corrections.get(cid) ?? null,
      getCorrectionByRequestKey: async (_o, key) => data.byRequest.get(key) ?? null,
      commitCorrection: async (current, next) => {
        if ((data.corrections.get(next.correctionId) ?? null) !== current) return false;
        data.corrections.set(next.correctionId, next); data.byRequest.set(next.requestKey, next); return true;
      },
    }};
  return {data, options};
}

test('retrieval is tenant-bound, published-only, deterministic and ranked', () => {
  const results = retrieveChunks('org-1', 'Are deposits refundable?', chunks, 5);
  assert.deepEqual(results.map(r => r.chunkId), ['c-1']);
  assert.deepEqual(retrieveChunks('org-1', 'Are deposits refundable?', chunks, 5), results);
  assert.deepEqual(retrieveChunks('org-1', 'the and of', chunks, 5), []);
  assert.deepEqual(retrieveChunks('org-1', 'deposits', chunks, 0), []);
  assert.deepEqual(retrieveChunks('org-1', 'deposits', chunks, 5, new Set(['c-1'])), []);
});

test('grounding verifies verbatim quotes and reports partial and ungrounded answers', () => {
  const grounded = verifyGrounding('org-1', 'Deposits are refundable within 14 days when the job has not been scheduled.',
    [{chunkId: 'c-1', quote: 'refundable within 14 days when the job has not been scheduled'}], chunks);
  assert.equal(grounded.verdict, 'grounded'); assert.equal(grounded.coverage, 1);
  const partial = verifyGrounding('org-1', 'Deposits are refundable within 14 days. Refunds take one hour.',
    [{chunkId: 'c-1', quote: 'Deposits are refundable within 14 days'}], chunks);
  assert.equal(partial.verdict, 'partially_grounded');
  const fabricated = verifyGrounding('org-1', 'Deposits are refundable within 90 days.',
    [{chunkId: 'c-4', quote: 'refundable within 90 days'}, {chunkId: 'c-3', quote: 'Deposits are never refundable'},
      {chunkId: 'c-1', quote: 'within 90 days always'}, {chunkId: 'c-1', quote: 'x'}], chunks);
  assert.equal(fabricated.verdict, 'ungrounded');
  assert.deepEqual(fabricated.rejectedCitations.map(r => r.reason),
    ['unknown_chunk', 'unknown_chunk', 'quote_not_found', 'malformed']);
});

test('accepted corrections suppress chunks; reviewers cannot approve their own submission', async () => {
  const {data, options} = fixture();
  const submitted = await submitGroundingCorrection(1, submitRequest, state,
    {requestKey: 'r-1', answerId: 'answer-1', chunkId: 'c-1', correctionType: 'outdated', note: 'Policy changed to 7 days.'}, options);
  assert.equal(submitted.accepted, true);
  assert.equal((await submitGroundingCorrection(1, submitRequest, state,
    {requestKey: 'r-1', answerId: 'answer-1', chunkId: 'c-1', correctionType: 'outdated', note: 'Policy changed to 7 days.'}, options)).replayed, true);
  const selfReview = await reviewGroundingCorrection(1, {...reviewRequest, subjectId: 'agent-1'},
    {...state, roles: state.roles.map(r => ({...r, permissions: ['ai-grounding:correct', 'ai-grounding:review']}))},
    {correctionId: submitted.value.correctionId, decision: 'accepted', expectedRevision: 1}, options);
  assert.deepEqual(selfReview, REJECTED);
  const reviewed = await reviewGroundingCorrection(1, reviewRequest, state,
    {correctionId: submitted.value.correctionId, decision: 'accepted', expectedRevision: 1}, options);
  assert.equal(reviewed.accepted, true);
  assert.deepEqual(await reviewGroundingCorrection(1, reviewRequest, state,
    {correctionId: submitted.value.correctionId, decision: 'rejected', expectedRevision: 1}, options), REJECTED);
  const suppressed = suppressedChunkIds('org-1', [...data.corrections.values()]);
  assert.deepEqual([...suppressed], ['c-1']);
  assert.equal(verifyGrounding('org-1', 'Deposits are refundable within 14 days.',
    [{chunkId: 'c-1', quote: 'Deposits are refundable within 14 days'}], chunks, suppressed).verdict, 'ungrounded');
});

test('rejects authorization-negative and malformed corrections', async t => {
  const input = {requestKey: 'r-1', answerId: 'answer-1', chunkId: 'c-1', correctionType: 'incorrect', note: 'Wrong.'};
  const cases = [
    ['missing tenant', {...submitRequest, organizationId: undefined}, state, input],
    ['cross-tenant', {...submitRequest, resourceOrganizationId: 'org-2'}, state, input],
    ['missing permission', {...submitRequest, requiredPermission: 'ai-grounding:review'}, state, input],
    ['inactive membership', submitRequest, {...state, memberships: state.memberships.map(m => ({...m, status: 'revoked'}))}, input],
    ['cross-tenant chunk', submitRequest, state, {...input, chunkId: 'c-4'}],
    ['bad type', submitRequest, state, {...input, correctionType: 'other'}],
    ['empty note', submitRequest, state, {...input, note: '  '}],
  ];
  for (const [name, request, authState, candidate] of cases) await t.test(name, async () => {
    const {options} = fixture();
    assert.deepEqual(await submitGroundingCorrection(1, request, authState, candidate, options), REJECTED);
  });
  await t.test('persistence failure', async () => {
    const {options} = fixture();
    options.store.commitCorrection = async () => { throw new Error('db'); };
    assert.deepEqual(await submitGroundingCorrection(1, submitRequest, state, input, options), REJECTED);
  });
});
