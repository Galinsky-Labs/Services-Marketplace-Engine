import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsPersonalIdentifiers, isPublicHostname, recordResearchFinding, registerResearchSource,
  selectActiveResearchFindings, sourceAllowsUrl,
} from '../packages/contracts/dist/research-sourcing.js';

const REJECTED = {accepted: false, code: 'research_sourcing_rejected'};
const state = {organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'analyst-1', organizationId: 'org-1', status: 'active', roleIds: ['analyst']}],
  roles: [{roleId: 'analyst', organizationId: 'org-1',
    permissions: ['research:sources:write', 'research:findings:write']}]};
const sourceRequest = {subjectId: 'analyst-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission: 'research:sources:write'};
const findingRequest = {...sourceRequest, requiredPermission: 'research:findings:write'};
const sourceInput = {requestKey: 'src-req-1', sourceKey: 'state.licensing-board',
  publisherName: 'State Licensing Board', baseUrl: 'https://licenses.state-board.gov/',
  allowedPathPrefixes: ['/lookup/'], license: 'public-record', retentionDays: 90,
  status: 'active', expectedRevision: 0};
const digest = 'sha256:' + 'a'.repeat(64);
const findingInput = {requestKey: 'finding-req-1', sourceKey: 'state.licensing-board',
  providerOrganizationId: 'provider-1', sourceUrl: 'https://licenses.state-board.gov/lookup/123',
  retrievedAt: 1_000, contentDigest: digest, excerpt: 'License 123 status: active through 2027.',
  claimType: 'license', claimValue: 'active'};

function fixture() {
  const data = {sources: new Map(), byRequest: new Map(), findings: new Map(), audits: []};
  let id = 0;
  const options = {now: () => 2_000, createOpaqueId: () => `id-${++id}`,
    audit: {now: () => 1, createOpaqueId: () => `audit-${++id}`,
      sink: {append: async event => data.audits.push(event)}},
    store: {
      getOperator: async (organizationId, subjectId) => ({organizationId, subjectId, status: 'active',
        permissions: ['research:sources:write', 'research:findings:write']}),
      getSource: async (_o, key) => data.sources.get(key) ?? null,
      getSourceByRequestKey: async (_o, key) => data.byRequest.get(key) ?? null,
      commitSource: async (current, next) => {
        if ((data.sources.get(next.sourceKey) ?? null) !== current) return false;
        data.sources.set(next.sourceKey, next); data.byRequest.set(next.requestKey, next); return true;
      },
      providerExists: async (_o, providerId) => providerId === 'provider-1',
      getFindingByRequestKey: async (_o, key) => data.findings.get(key) ?? null,
      createFinding: async finding => { data.findings.set(finding.requestKey, finding); return true; },
    }};
  return {data, options};
}

test('registers a public source and records cited, unverified findings with replay', async () => {
  const {data, options} = fixture();
  const source = await registerResearchSource(1, sourceRequest, state, sourceInput, options);
  assert.equal(source.accepted, true);
  assert.equal(source.value.origin, 'https://licenses.state-board.gov');
  assert.deepEqual(await registerResearchSource(1, sourceRequest, state, sourceInput, options),
    {accepted: true, value: source.value, replayed: true});
  const finding = await recordResearchFinding(1, findingRequest, state, findingInput, options);
  assert.equal(finding.accepted, true);
  assert.equal(finding.value.verification, 'unverified');
  assert.equal(finding.value.expiresAt, 2_000 + 90 * 86_400_000);
  assert.equal((await recordResearchFinding(1, findingRequest, state, findingInput, options)).replayed, true);
  assert.equal(data.audits.every(event => event.outcome === 'authorized'), true);
  const active = selectActiveResearchFindings([...data.findings.values()], 'org-1', 'provider-1', 3_000);
  assert.equal(active.length, 1);
  assert.equal(selectActiveResearchFindings([...data.findings.values()], 'org-2', 'provider-1', 3_000).length, 0);
});

test('rejects authorization-negative cases', async t => {
  const cases = [
    ['missing tenant', {...sourceRequest, organizationId: undefined}, state],
    ['cross-tenant', {...sourceRequest, resourceOrganizationId: 'org-2'}, state],
    ['wrong permission', {...sourceRequest, requiredPermission: 'research:findings:write'}, state],
    ['inactive membership', sourceRequest, {...state, memberships: [{...state.memberships[0], status: 'suspended'}]}],
  ];
  for (const [name, request, authState] of cases) await t.test(name, async () => {
    const {options} = fixture();
    assert.deepEqual(await registerResearchSource(1, request, authState, sourceInput, options), REJECTED);
  });
  await t.test('inactive operator grant', async () => {
    const {options} = fixture();
    options.store.getOperator = async (organizationId, subjectId) =>
      ({organizationId, subjectId, status: 'inactive', permissions: ['research:sources:write']});
    assert.deepEqual(await registerResearchSource(1, sourceRequest, state, sourceInput, options), REJECTED);
  });
  await t.test('audit failure', async () => {
    const {options} = fixture();
    options.audit.sink.append = async () => { throw new Error('down'); };
    assert.deepEqual(await registerResearchSource(1, sourceRequest, state, sourceInput, options), REJECTED);
  });
});

test('refuses non-public, credentialed and private-network source URLs', async () => {
  for (const baseUrl of ['http://licenses.state-board.gov/', 'https://127.0.0.1/',
    'https://localhost/', 'https://user:pw@licenses.state-board.gov/', 'https://intranet/',
    'https://licenses.corp/', 'https://[::1]/', 'https://licenses.state-board.gov:8443/']) {
    const {options} = fixture();
    assert.deepEqual(await registerResearchSource(1, sourceRequest, state, {...sourceInput, baseUrl}, options),
      REJECTED, baseUrl);
  }
  assert.equal(isPublicHostname('169.254.169.254'), false);
  assert.equal(isPublicHostname('board.example'), false);
  assert.equal(isPublicHostname('licenses.state-board.gov'), true);
});

test('findings must cite an allowed path and contain no personal identifiers', async () => {
  const {data, options} = fixture();
  assert.equal((await registerResearchSource(1, sourceRequest, state, sourceInput, options)).accepted, true);
  const source = data.sources.get('state.licensing-board');
  assert.equal(sourceAllowsUrl(source, 'https://licenses.state-board.gov/admin/1'), false);
  assert.equal(sourceAllowsUrl(source, 'https://licenses.state-board.gov/lookup/%2e%2e/admin'), false);
  assert.equal(sourceAllowsUrl(source, 'https://evil.example.org/lookup/1'), false);
  for (const patch of [{sourceUrl: 'https://licenses.state-board.gov/admin/1'},
    {excerpt: 'Contact owner@provider.org for details'}, {excerpt: 'Call +1 (555) 010-2000 now'},
    {excerpt: 'SSN 123-45-6789'}, {retrievedAt: 3_000}, {contentDigest: 'md5:abc'},
    {providerOrganizationId: 'provider-2'}, {claimType: 'rumor'}]) {
    assert.deepEqual(await recordResearchFinding(1, findingRequest, state, {...findingInput, ...patch}, options),
      REJECTED, JSON.stringify(patch));
  }
  assert.equal(containsPersonalIdentifiers('License active'), false);
});

test('stale revisions, retired sources and non-exact replays fail closed', async () => {
  const {data, options} = fixture();
  assert.deepEqual(await registerResearchSource(1, sourceRequest, state, {...sourceInput, expectedRevision: 1}, options), REJECTED);
  const created = await registerResearchSource(1, sourceRequest, state, sourceInput, options);
  assert.deepEqual(await registerResearchSource(1, sourceRequest, state, {...sourceInput, retentionDays: 30}, options), REJECTED);
  const retired = await registerResearchSource(1, sourceRequest, state,
    {...sourceInput, requestKey: 'src-req-2', status: 'retired', expectedRevision: created.value.revision}, options);
  assert.equal(retired.accepted, true);
  assert.equal(data.sources.get('state.licensing-board').status, 'retired');
  assert.deepEqual(await recordResearchFinding(1, findingRequest, state, findingInput, options), REJECTED);
  assert.deepEqual(await registerResearchSource(2, sourceRequest, state, sourceInput, options), REJECTED);
});
