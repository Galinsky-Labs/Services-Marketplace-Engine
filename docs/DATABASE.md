# PostgreSQL migrations and rollback

Ordered SQL pairs in `database/migrations` own the engine schema. Every `NNNN_name.up.sql` file requires a matching `NNNN_name.down.sql`. The runner uses the node `pg` driver (no `psql` required): it takes a session advisory lock, applies pending upgrades in ascending order and rollbacks of applied migrations in reverse order, each file in its own transaction, and skips migrations already recorded in `marketplace.schema_migrations`.

- `npm run migrate:up` / `npm run migrate:down` use `MIGRATION_DATABASE_URL` or `DATABASE_URL`.
- The API server (`apps/api/dist/main.js`) applies pending migrations at startup with the same logic (`apps/api/src/db/migrate.ts`), preferring the direct `MIGRATION_DATABASE_URL` over a pooled `DATABASE_URL`.

## Migrations

- `0001_core` creates the `marketplace` schema, organizations, memberships and the bootstrap `resources` table with forced row-level security: reads require matching organization context, an active membership and explicit `resource:read`.
- `0002_platform` adds organization status, membership role ids, `roles`, `api_keys` (SHA-256 secret hashes only), `audit_events`, and the tenant document store: `documents` (JSONB contract values, compare-and-swap updates, GIN index) and `document_keys` (unique secondary keys). Both document tables force row-level security keyed by `app.organization_id`, so a non-superuser application role sees and writes only the tenant set for its transaction.

## Verification

CI applies the schema to PostgreSQL 16, exercises authorized and denied resource reads as a non-superuser, runs `tests/postgres-repositories.test.mjs` (identity repository, CAS and unique-key semantics, atomic batches, RLS isolation for a `NOBYPASSRLS` role, and the HTTP API end to end on Postgres), rolls everything back, and verifies that the `marketplace` schema no longer exists. Migration files must never contain credentials or environment-specific identities.

Note: Neon's default `neondb_owner` role owns the tables; `FORCE ROW LEVEL SECURITY` applies to the owner, so the policies are enforced in production as long as the role is not a superuser and lacks `BYPASSRLS`.
