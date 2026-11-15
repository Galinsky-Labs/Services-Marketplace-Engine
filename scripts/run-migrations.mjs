import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const migrationPattern = /^(\d{4}_[a-z0-9_]+)\.(up|down)\.sql$/;
const MIGRATION_LOCK_ID = 7_316_045_821;

export function discoverMigrations(root = process.cwd()) {
  const directory = path.join(root, 'database', 'migrations');
  const discovered = new Map();
  for (const file of fs.readdirSync(directory).sort()) {
    const match = migrationPattern.exec(file);
    if (!match) throw Error('Invalid migration filename: ' + file);
    const [, id, direction] = match;
    const migration = discovered.get(id) ?? {id};
    if (migration[direction]) throw Error('Duplicate ' + direction + ' migration: ' + id);
    migration[direction] = path.join(directory, file);
    discovered.set(id, migration);
  }

  const migrations = [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (migrations.length === 0) throw Error('No migrations found');
  for (const migration of migrations) {
    if (!migration.up || !migration.down) throw Error('Migration pair is incomplete: ' + migration.id);
  }
  return migrations;
}

// Uses the node Postgres driver (no psql). Each migration runs in its own transaction under
// an advisory lock and already-applied migrations are skipped; `down` reverts applied ones.
export async function runMigrations(direction, options = {}) {
  if (direction !== 'up' && direction !== 'down') throw Error('Direction must be up or down');
  const databaseUrl = options.databaseUrl ?? process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw Error('DATABASE_URL is required');
  const migrations = discoverMigrations(options.root ?? process.cwd());
  const {default: pg} = await import('pg');
  const client = new pg.Client({connectionString: databaseUrl, application_name: 'services-marketplace-migrations'});
  await client.connect();
  const changed = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    const present = await client.query("SELECT to_regclass('marketplace.schema_migrations') IS NOT NULL AS present");
    const applied = new Set(present.rows[0].present
      ? (await client.query('SELECT id FROM marketplace.schema_migrations')).rows.map(row => row.id) : []);
    const ordered = direction === 'up'
      ? migrations.filter(migration => !applied.has(migration.id))
      : migrations.toReversed().filter(migration => applied.has(migration.id));
    for (const migration of ordered) {
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(migration[direction], 'utf8'));
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw Error(direction + ' migration failed: ' + migration.id + ': ' + error.message);
      }
      changed.push(migration.id);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    await client.end();
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const direction = process.argv[2];
  const applied = await runMigrations(direction);
  console.log(direction + ' migrations completed: ' + (applied.join(', ') || 'none pending'));
}
