import type pg from 'pg';

export type JsonValue = string | number | boolean | null | JsonValue[] |
  {[key: string]: JsonValue};
export type Filter = Readonly<Record<string, string | number | boolean>>;

export interface PutOperation {
  readonly kind: string;
  readonly id: string;
  /** null inserts; otherwise the stored value must deep-equal this value. */
  readonly expected: unknown;
  readonly next: unknown;
  /** Field names whose values must be unique within (organization, kind). */
  readonly uniqueKeys?: readonly string[];
}

/**
 * Tenant-scoped document storage. Every call names the organization; implementations
 * never return a document from another organization. Writes are atomic compare-and-swap.
 */
export interface DocumentStore {
  get<T>(organizationId: string, kind: string, id: string): Promise<T | null>;
  /** Exactly one match or null (ambiguous matches return null: fail closed). */
  findOne<T>(organizationId: string, kind: string, filter: Filter): Promise<T | null>;
  list<T>(organizationId: string, kind: string, filter?: Filter, limit?: number): Promise<T[]>;
  put(organizationId: string, operation: PutOperation): Promise<boolean>;
  putAll(organizationId: string, operations: readonly PutOperation[]): Promise<boolean>;
  remove(organizationId: string, kind: string, id: string): Promise<boolean>;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value as object).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

const matches = (value: Record<string, unknown>, filter: Filter): boolean =>
  Object.entries(filter).every(([key, expected]) => value[key] === expected);

const KIND = /^[a-z][a-z0-9-]{0,63}$/;
function checkKind(kind: string): void {
  if (!KIND.test(kind)) throw new Error('invalid document kind');
}

export class MemoryDocumentStore implements DocumentStore {
  readonly #documents = new Map<string, string>();
  readonly #keys = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();

  #id(organizationId: string, kind: string, id: string): string {
    return JSON.stringify([organizationId, kind, id]);
  }

  async get<T>(organizationId: string, kind: string, id: string): Promise<T | null> {
    checkKind(kind);
    const raw = this.#documents.get(this.#id(organizationId, kind, id));
    return raw === undefined ? null : JSON.parse(raw) as T;
  }

  async findOne<T>(organizationId: string, kind: string, filter: Filter): Promise<T | null> {
    const found = await this.list<T>(organizationId, kind, filter, 2);
    return found.length === 1 ? found[0]! : null;
  }

  async list<T>(organizationId: string, kind: string, filter: Filter = {},
    limit = 500): Promise<T[]> {
    checkKind(kind);
    const prefix = JSON.stringify([organizationId, kind]).slice(0, -1) + ',';
    const results: T[] = [];
    for (const [key, raw] of [...this.#documents.entries()].sort(([left], [right]) =>
      left < right ? -1 : 1)) {
      if (!key.startsWith(prefix)) continue;
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (matches(value, filter)) results.push(value as T);
      if (results.length >= limit) break;
    }
    return results;
  }

  put(organizationId: string, operation: PutOperation): Promise<boolean> {
    return this.putAll(organizationId, [operation]);
  }

  putAll(organizationId: string, operations: readonly PutOperation[]): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const documents = new Map(this.#documents);
      const keys = new Map(this.#keys);
      for (const operation of operations) {
        checkKind(operation.kind);
        const id = this.#id(organizationId, operation.kind, operation.id);
        const current = documents.get(id);
        if (operation.expected === null) {
          if (current !== undefined) return false;
        } else if (current === undefined ||
          canonicalJson(JSON.parse(current)) !== canonicalJson(operation.expected)) return false;
        const next = operation.next as Record<string, unknown>;
        for (const field of operation.uniqueKeys ?? []) {
          const keyValue = next[field];
          if (keyValue === undefined || keyValue === null) continue;
          const keyId = JSON.stringify([organizationId, operation.kind, field, String(keyValue)]);
          const owner = keys.get(keyId);
          if (owner !== undefined && owner !== operation.id) return false;
          keys.set(keyId, operation.id);
        }
        documents.set(id, JSON.stringify(next));
      }
      this.#documents.clear();
      for (const [key, value] of documents) this.#documents.set(key, value);
      this.#keys.clear();
      for (const [key, value] of keys) this.#keys.set(key, value);
      return true;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => false);
    return result;
  }

  async remove(organizationId: string, kind: string, id: string): Promise<boolean> {
    checkKind(kind);
    const removed = this.#documents.delete(this.#id(organizationId, kind, id));
    for (const [key, owner] of this.#keys) {
      const [org, keyKind] = JSON.parse(key) as string[];
      if (org === organizationId && keyKind === kind && owner === id) this.#keys.delete(key);
    }
    return removed;
  }
}

/**
 * Postgres implementation. Every statement runs in a transaction that sets
 * `app.organization_id`, so the row-level security policies on `marketplace.documents`
 * enforce the tenant boundary even if a query were wrong.
 */
export class PostgresDocumentStore implements DocumentStore {
  constructor(private readonly pool: pg.Pool) {}

  async #tenant<T>(organizationId: string, work: (client: pg.PoolClient) => Promise<T>,
    rollbackValue?: T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      const result = await work(client);
      if (rollbackValue !== undefined && result === rollbackValue) {
        await client.query('ROLLBACK');
      } else {
        await client.query('COMMIT');
      }
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async get<T>(organizationId: string, kind: string, id: string): Promise<T | null> {
    checkKind(kind);
    return this.#tenant(organizationId, async client => {
      const result = await client.query<{data: T}>(
        'SELECT data FROM marketplace.documents WHERE organization_id = $1 AND kind = $2 AND id = $3',
        [organizationId, kind, id]);
      return result.rows[0]?.data ?? null;
    });
  }

  async findOne<T>(organizationId: string, kind: string, filter: Filter): Promise<T | null> {
    const found = await this.list<T>(organizationId, kind, filter, 2);
    return found.length === 1 ? found[0]! : null;
  }

  async list<T>(organizationId: string, kind: string, filter: Filter = {},
    limit = 500): Promise<T[]> {
    checkKind(kind);
    return this.#tenant(organizationId, async client => {
      const result = await client.query<{data: T}>(
        'SELECT data FROM marketplace.documents WHERE organization_id = $1 AND kind = $2 ' +
        'AND data @> $3::jsonb ORDER BY id LIMIT $4',
        [organizationId, kind, JSON.stringify(filter), Math.max(1, Math.min(limit, 1000))]);
      return result.rows.map(row => row.data);
    });
  }

  put(organizationId: string, operation: PutOperation): Promise<boolean> {
    return this.putAll(organizationId, [operation]);
  }

  async putAll(organizationId: string, operations: readonly PutOperation[]): Promise<boolean> {
    for (const operation of operations) checkKind(operation.kind);
    try {
      return await this.#tenant(organizationId, async client => {
        for (const operation of operations) {
          const next = JSON.stringify(operation.next);
          if (operation.expected === null) {
            const inserted = await client.query(
              'INSERT INTO marketplace.documents (organization_id, kind, id, data) ' +
              'VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING',
              [organizationId, operation.kind, operation.id, next]);
            if (inserted.rowCount !== 1) return false;
          } else {
            const updated = await client.query(
              'UPDATE marketplace.documents SET data = $4::jsonb, version = version + 1, ' +
              'updated_at = now() WHERE organization_id = $1 AND kind = $2 AND id = $3 ' +
              'AND data = $5::jsonb',
              [organizationId, operation.kind, operation.id, next,
                JSON.stringify(operation.expected)]);
            if (updated.rowCount !== 1) return false;
          }
          const value = operation.next as Record<string, unknown>;
          for (const field of operation.uniqueKeys ?? []) {
            const keyValue = value[field];
            if (keyValue === undefined || keyValue === null) continue;
            const key = await client.query<{document_id: string}>(
              'INSERT INTO marketplace.document_keys (organization_id, kind, key_name, key_value, document_id) ' +
              'VALUES ($1, $2, $3, $4, $5) ON CONFLICT (organization_id, kind, key_name, key_value) ' +
              'DO UPDATE SET document_id = marketplace.document_keys.document_id RETURNING document_id',
              [organizationId, operation.kind, field, String(keyValue), operation.id]);
            if (key.rows[0]?.document_id !== operation.id) return false;
          }
        }
        return true;
      }, false);
    } catch (error) {
      // Serialization conflicts and constraint violations are ordinary CAS failures.
      if (error && typeof error === 'object' && 'code' in error &&
        typeof (error as {code: unknown}).code === 'string' &&
        /^(23|40)/.test((error as {code: string}).code)) return false;
      throw error;
    }
  }

  async remove(organizationId: string, kind: string, id: string): Promise<boolean> {
    checkKind(kind);
    return this.#tenant(organizationId, async client => {
      const result = await client.query(
        'DELETE FROM marketplace.documents WHERE organization_id = $1 AND kind = $2 AND id = $3',
        [organizationId, kind, id]);
      return result.rowCount === 1;
    });
  }
}
