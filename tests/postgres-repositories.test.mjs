import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  PostgresDocumentStore, PostgresIdentityRepository, createApp, createHttpServer, createServicesWith, runMigrations,
} from '../apps/api/dist/index.js';
import {createClient} from '../packages/sdk/dist/index.js';

// Runs only when DATABASE_URL points at a disposable Postgres (CI `database` job, or local).
const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL not set';
const APP_ROLE = 'sme_app_test';

async function setup() {
  await runMigrations(databaseUrl, 'up', 'database/migrations');
  const admin = new pg.Client({connectionString: databaseUrl});
  await admin.connect();
  const password = crypto.randomBytes(16).toString('hex');
  await admin.query(`DO $$ BEGIN CREATE ROLE ${APP_ROLE} LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await admin.query(`ALTER ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  await admin.query(`GRANT USAGE ON SCHEMA marketplace TO ${APP_ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA marketplace TO ${APP_ROLE}`);
  await admin.end();
  const url = new URL(databaseUrl);
  url.username = APP_ROLE;
  url.password = password;
  return new pg.Pool({connectionString: url.toString(), max: 4});
}

test('Postgres repositories: CAS documents, unique keys, identity and row-level security', {skip}, async t => {
  const pool = await setup();
  t.after(() => pool.end());
  const identity = new PostgresIdentityRepository(pool);
  const documents = new PostgresDocumentStore(pool);
  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  await identity.createOrganization(orgA, 'Org A');
  await identity.createOrganization(orgB, 'Org B');
  const subject = crypto.randomUUID();
  await identity.putRole({organizationId: orgA, roleId: 'owner', permissions: ['provider:read']});
  await identity.putMembership({organizationId: orgA, subjectId: subject, status: 'active', roleIds: ['owner']});
  const state = await identity.loadAuthorizationState(orgA, subject);
  assert.deepEqual(state.memberships, [{subjectId: subject, organizationId: orgA, status: 'active', roleIds: ['owner']}]);
  assert.deepEqual(state.roles, [{roleId: 'owner', organizationId: orgA, permissions: ['provider:read']}]);
  assert.deepEqual((await identity.loadAuthorizationState(orgB, subject)).memberships, []);
  await identity.putMembership({organizationId: orgA, subjectId: subject, status: 'suspended', roleIds: ['owner']});
  assert.equal((await identity.loadAuthorizationState(orgA, subject)).memberships[0].status, 'suspended');

  const keyId = crypto.randomBytes(12).toString('hex');
  const keyHash = crypto.createHash('sha256').update('secret').digest('hex');
  await identity.createApiKey({keyId: keyId, organizationId: orgA, subjectId: subject, secretHash: keyHash,
    label: 'test', status: 'active'});
  assert.equal((await identity.getApiKey(keyId)).organizationId, orgA);
  assert.equal(await identity.revokeApiKey(orgB, keyId), false);
  assert.equal(await identity.revokeApiKey(orgA, keyId), true);
  await identity.append({eventId: crypto.randomUUID(), occurredAt: 5, action: 'x', subjectId: subject,
    organizationId: orgA, resourceOrganizationId: orgA, outcome: 'denied'});
  assert.equal((await identity.listAuditEvents(orgA, 10))[0].outcome, 'denied');

  const first = {id: 'p-1', requestKey: 'rk-1', status: 'draft', revision: 1};
  assert.equal(await documents.put(orgA, {kind: 'provider', id: 'p-1', expected: null, next: first, uniqueKeys: ['requestKey']}), true);
  assert.equal(await documents.put(orgA, {kind: 'provider', id: 'p-1', expected: null, next: first}), false);
  assert.equal(await documents.put(orgA, {kind: 'provider', id: 'p-2', expected: null,
    next: {...first, id: 'p-2'}, uniqueKeys: ['requestKey']}), false, 'unique key conflict');
  assert.equal(await documents.get(orgA, 'provider', 'p-2'), null, 'failed insert rolled back');
  const second = {...first, status: 'active', revision: 2};
  assert.equal(await documents.put(orgA, {kind: 'provider', id: 'p-1', expected: {...first, revision: 9}, next: second}), false);
  assert.equal(await documents.put(orgA, {kind: 'provider', id: 'p-1', expected: first, next: second}), true);
  assert.deepEqual(await documents.get(orgA, 'provider', 'p-1'), second);
  assert.deepEqual(await documents.list(orgA, 'provider', {status: 'active'}), [second]);
  assert.equal(await documents.get(orgB, 'provider', 'p-1'), null);
  assert.equal(await documents.putAll(orgA, [
    {kind: 'provider', id: 'p-3', expected: null, next: {id: 'p-3'}},
    {kind: 'provider', id: 'p-1', expected: first, next: second},
  ]), false);
  assert.equal(await documents.get(orgA, 'provider', 'p-3'), null, 'batch is atomic');

  // Row-level security: the application role sees nothing without the tenant setting,
  // and only its tenant's rows with it, even for a query with no organization filter.
  const client = await pool.connect();
  try {
    assert.equal((await client.query('SELECT count(*)::int AS n FROM marketplace.documents')).rows[0].n, 0);
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organization_id', $1, true)", [orgB]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM marketplace.documents')).rows[0].n, 0);
    await assert.rejects(client.query(
      "INSERT INTO marketplace.documents (organization_id, kind, id, data) VALUES ($1, 'provider', 'x', '{}')", [orgA]),
    /row-level security/);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('HTTP API end to end on Postgres', {skip}, async t => {
  const pool = await setup();
  t.after(() => pool.end());
  const adminToken = 'smeadmin_' + 'c'.repeat(64);
  const services = createServicesWith(new PostgresIdentityRepository(pool), new PostgresDocumentStore(pool),
    {PLATFORM_ADMIN_TOKEN: adminToken}, 'postgres', () => {});
  const server = createHttpServer(createApp(services).handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const ready = await (await fetch(baseUrl + '/ready')).json();
  assert.deepEqual(ready, {status: 'ready', persistence: 'postgres', database: true});
  const provisioned = await (await fetch(baseUrl + '/v1/admin/organizations', {method: 'POST',
    headers: {authorization: 'Bearer ' + adminToken, 'content-type': 'application/json', 'x-contract-version': '1'},
    body: JSON.stringify({name: 'Postgres Org'})})).json();
  const client = createClient({baseUrl, bearerToken: provisioned.apiKey.token, fetch: (input, init) => fetch(input, init)});
  const org = provisioned.organizationId;
  const provider = await client.createProviderOrganization(org, {legalName: 'PG LLC', publicName: 'PG'});
  assert.equal((await client.getProviderOrganization(org, provider.providerOrganizationId)).legalName, 'PG LLC');
  for (const [index, decision] of ['granted', 'withdrawn', 'granted'].entries()) {
    await client.recordConsent(org, {requestKey: 'c-' + index, subjectId: provisioned.ownerSubjectId,
      purpose: 'data-sharing', decision, noticeVersion: 'v1', channel: 'api'});
  }
  const consent = await client.getConsentStatus(org, provisioned.ownerSubjectId, 'data-sharing');
  assert.deepEqual({granted: consent.granted, chainValid: consent.chainValid}, {granted: true, chainValid: true});
  const flag = await client.configureFeatureFlag(org, 'beta.search', {requestKey: 'f-1', environment: 'production',
    enabled: true, variantKey: 'on', expectedRevision: 0});
  assert.equal((await client.configureFeatureFlag(org, 'beta.search', {requestKey: 'f-1', environment: 'production',
    enabled: true, variantKey: 'on', expectedRevision: 0})).configurationId, flag.configurationId);
  const audit = await client.listAuditEvents(org, {limit: 5});
  assert.ok(audit.items.length > 0);
});
