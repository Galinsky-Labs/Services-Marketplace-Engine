import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const MIGRATION_PATTERN = /^(\d{4}_[a-z0-9_]+)\.(up|down)\.sql$/;
/** Arbitrary constant shared by every process that runs migrations. */
const MIGRATION_LOCK_ID = 7_316_045_821;

export interface Migration {
  readonly id: string;
  readonly up: string;
  readonly down: string;
}

export function discoverMigrations(directory: string): readonly Migration[] {
  const found = new Map<string, {id: string; up?: string; down?: string}>();
  for (const file of fs.readdirSync(directory).sort()) {
    const match = MIGRATION_PATTERN.exec(file);
    if (!match) throw new Error('Invalid migration filename: ' + file);
    const [, id, direction] = match as unknown as [string, string, 'up' | 'down'];
    const entry = found.get(id) ?? {id};
    if (entry[direction]) throw new Error('Duplicate ' + direction + ' migration: ' + id);
    entry[direction] = path.join(directory, file);
    found.set(id, entry);
  }
  const migrations = [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (migrations.length === 0) throw new Error('No migrations found');
  return migrations.map(entry => {
    if (!entry.up || !entry.down) throw new Error('Migration pair is incomplete: ' + entry.id);
    return {id: entry.id, up: entry.up, down: entry.down};
  });
}

async function appliedIds(client: pg.ClientBase): Promise<Set<string>> {
  const exists = await client.query<{present: boolean}>(
    "SELECT to_regclass('marketplace.schema_migrations') IS NOT NULL AS present");
  if (!exists.rows[0]?.present) return new Set();
  const rows = await client.query<{id: string}>('SELECT id FROM marketplace.schema_migrations');
  return new Set(rows.rows.map(row => row.id));
}

/**
 * Applies (or rolls back) paired SQL migrations with the node Postgres driver, so the
 * runtime image does not need psql. Each file runs in its own transaction under a
 * session advisory lock; already-applied migrations are skipped.
 */
export async function runMigrations(connectionString: string, direction: 'up' | 'down',
  directory: string, log: (message: string) => void = () => {}): Promise<readonly string[]> {
  const migrations = discoverMigrations(directory);
  const client = new pg.Client({connectionString, application_name: 'sme-migrations'});
  await client.connect();
  const changed: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    const applied = await appliedIds(client);
    const ordered = direction === 'up'
      ? migrations.filter(migration => !applied.has(migration.id))
      : [...migrations].reverse().filter(migration => applied.has(migration.id));
    for (const migration of ordered) {
      const sql = fs.readFileSync(migration[direction], 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(direction + ' migration failed: ' + migration.id + ': ' +
          (error instanceof Error ? error.message : 'unknown error'));
      }
      changed.push(migration.id);
      log(direction + ' ' + migration.id);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    await client.end();
  }
  return changed;
}
