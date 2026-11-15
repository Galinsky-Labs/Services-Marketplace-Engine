import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverMigrations} from '../scripts/run-migrations.mjs';

test('migration discovery returns ordered reversible pairs', () => {
  const migrations = discoverMigrations();
  assert.deepEqual(migrations.map(migration => migration.id), ['0001_core', '0002_platform']);
  assert.match(migrations[0].up, /0001_core\.up\.sql$/);
  assert.match(migrations[0].down, /0001_core\.down\.sql$/);
});

test('migration discovery rejects an incomplete pair', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-migrations-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'database', 'migrations');
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, '0001_core.up.sql'), 'SELECT 1;\n');
  assert.throws(() => discoverMigrations(root), /pair is incomplete/);
});

test('core migration enforces tenant authorization before resource visibility', () => {
  const sql = fs.readFileSync('database/migrations/0001_core.up.sql', 'utf8');
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /current_setting\('app\.organization_id', true\)/);
  assert.match(sql, /current_setting\('app\.subject_id', true\)/);
  assert.match(sql, /membership\.status = 'active'/);
  assert.match(sql, /'resource:read' = ANY/);
});

test('rollback removes every object introduced by the core migration', () => {
  const sql = fs.readFileSync('database/migrations/0001_core.down.sql', 'utf8');
  for (const object of ['tenant_resource_read', 'resources', 'memberships', 'organizations', 'schema_migrations']) {
    assert.match(sql, new RegExp('DROP (?:POLICY|TABLE).*' + object));
  }
  assert.match(sql, /DROP SCHEMA marketplace/);
});

test('platform migration enforces tenant row-level security on documents and reverses cleanly', () => {
  const up = fs.readFileSync('database/migrations/0002_platform.up.sql', 'utf8');
  const down = fs.readFileSync('database/migrations/0002_platform.down.sql', 'utf8');
  for (const table of ['documents', 'document_keys']) {
    assert.match(up, new RegExp('ALTER TABLE marketplace\\.' + table + ' FORCE ROW LEVEL SECURITY'));
    assert.match(down, new RegExp('DROP TABLE marketplace\\.' + table));
  }
  for (const table of ['roles', 'api_keys', 'audit_events']) assert.match(down, new RegExp('DROP TABLE marketplace\\.' + table));
  assert.match(up, /secret_hash text NOT NULL CHECK \(secret_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(down, /DELETE FROM marketplace\.schema_migrations WHERE id = '0002_platform'/);
});
