import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAlertRules, openIncident, transitionIncident} from '../packages/contracts/dist/monitoring.js';

const REJECTED = {accepted: false, code: 'monitoring_rejected'};
const state = {organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'sre-1', organizationId: 'org-1', status: 'active', roleIds: ['sre']}],
  roles: [{roleId: 'sre', organizationId: 'org-1', permissions: ['operations:incidents:write']}]};
const request = {subjectId: 'sre-1', organizationId: 'org-1', resourceOrganizationId: 'org-1',
  requiredPermission: 'operations:incidents:write'};
const rules = [
  {ruleKey: 'http.error-rate', metric: 'http.5xx', aggregation: 'sum', comparator: '>', threshold: 5,
    windowMs: 60_000, minimumSamples: 1, severity: 'sev2'},
  {ruleKey: 'http.latency-p95', metric: 'http.latency_ms', aggregation: 'p95', comparator: '>', threshold: 500,
    windowMs: 60_000, minimumSamples: 20, severity: 'sev3'},
  {ruleKey: 'db.ready', metric: 'db.ready', aggregation: 'max', comparator: '<', threshold: 1,
    windowMs: 30_000, minimumSamples: 1, severity: 'sev1'},
];

function fixture() {
  const data = new Map(); let id = 0; let now = 100_000;
  const options = {now: () => now, createOpaqueId: () => `inc-${++id}`,
    audit: {now: () => 1, createOpaqueId: () => `audit-${++id}`, sink: {append: async () => {}}},
    store: {
      getIncident: async (_o, incidentId) => data.get(incidentId) ?? null,
      getOpenByDedupeKey: async (_o, key) => [...data.values()].find(i => i.dedupeKey === key && i.status !== 'resolved') ?? null,
      getByRequestKey: async (_o, key) => [...data.values()].find(i => i.requestKey === key) ?? null,
      commitIncident: async (current, next) => {
        if ((data.get(next.incidentId) ?? null) !== current) return false; data.set(next.incidentId, next); return true;
      },
    }};
  return {data, options, tick: () => { now += 1_000; }};
}

test('alert rules respect windows, sample minimums and severities', () => {
  const now = 100_000;
  const samples = [
    ...Array.from({length: 7}, (_, i) => ({metric: 'http.5xx', at: now - i * 1_000, value: 1})),
    {metric: 'http.5xx', at: now - 120_000, value: 100},
    ...Array.from({length: 10}, (_, i) => ({metric: 'http.latency_ms', at: now - i, value: 900})),
    {metric: 'db.ready', at: now - 5_000, value: 0},
  ];
  const firing = evaluateAlertRules(rules, samples, now);
  assert.deepEqual(firing.map(a => [a.ruleKey, a.severity, a.observed]), [['db.ready', 'sev1', 0], ['http.error-rate', 'sev2', 7]]);
  const invalid = evaluateAlertRules([{...rules[0], windowMs: 1}], samples, now);
  assert.equal(invalid[0].ruleKey, 'monitoring.invalid-rule');
});

test('incident lifecycle deduplicates and requires postmortem for sev1/sev2', async () => {
  const {options, tick} = fixture();
  const opened = await openIncident(1, request, state, {requestKey: 'r-1', dedupeKey: 'http.error-rate',
    title: 'Elevated 5xx', severity: 'sev2'}, options);
  assert.equal(opened.value.status, 'open');
  const dedupe = await openIncident(1, request, state, {requestKey: 'r-2', dedupeKey: 'http.error-rate',
    title: 'Elevated 5xx again', severity: 'sev2'}, options);
  assert.deepEqual({id: dedupe.value.incidentId, replayed: dedupe.replayed}, {id: opened.value.incidentId, replayed: true});
  tick();
  const ack = await transitionIncident(1, request, state, {incidentId: opened.value.incidentId, status: 'acknowledged',
    note: 'Investigating', postmortemUrl: null, expectedRevision: 1}, options);
  assert.equal(ack.value.commanderSubjectId, 'sre-1');
  assert.deepEqual(await transitionIncident(1, request, state, {incidentId: opened.value.incidentId, status: 'resolved',
    note: 'Fixed', postmortemUrl: null, expectedRevision: 2}, options), REJECTED);
  const resolved = await transitionIncident(1, request, state, {incidentId: opened.value.incidentId, status: 'resolved',
    note: 'Fixed', postmortemUrl: 'https://docs.example.org/pm/1', expectedRevision: 2}, options);
  assert.equal(resolved.value.timeline.length, 3);
  assert.deepEqual(await transitionIncident(1, request, state, {incidentId: opened.value.incidentId, status: 'open',
    note: 'reopen', postmortemUrl: null, expectedRevision: 3}, options), REJECTED);
});

test('rejects authorization-negative and malformed incident changes', async t => {
  const input = {requestKey: 'r-1', dedupeKey: 'k', title: 'Outage', severity: 'sev1'};
  const cases = [
    ['missing tenant', {...request, organizationId: undefined}, state, input],
    ['cross-tenant', {...request, resourceOrganizationId: 'org-2'}, state, input],
    ['missing permission', {...request, requiredPermission: 'operations:read'}, state, input],
    ['inactive membership', request, {...state, memberships: [{...state.memberships[0], status: 'suspended'}]}, input],
    ['bad severity', request, state, {...input, severity: 'sev0'}],
  ];
  for (const [name, candidate, authState, body] of cases) await t.test(name, async () => {
    const {options} = fixture();
    assert.deepEqual(await openIncident(1, candidate, authState, body, options), REJECTED);
  });
});
