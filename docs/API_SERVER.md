# HTTP API server

`apps/api` is a deployable Node.js 22 service (`node apps/api/dist/main.js`) with no web framework: `node:http`, a declarative route table, and the `pg` driver.

## Startup

1. When `DATABASE_URL` is set, migrations in `database/migrations` are applied with the node driver under an advisory lock (`MIGRATION_DATABASE_URL`, a direct non-pooled connection, is preferred when set; `RUN_MIGRATIONS=false` skips this). No `psql` is needed at runtime.
2. A `pg` pool (`DATABASE_POOL_MAX`, default 5) backs the Postgres identity repository and document store.
3. Without `DATABASE_URL` the service runs on volatile in-memory storage, which is refused when `APP_ENV=production`.
4. Adapter modes are logged (never their secrets); `SIGTERM` drains and closes the pool.

## Authentication and authorization

- Tenant API keys look like `sme_<24 char key id>_<64 hex secret>`. Only the SHA-256 of the secret is stored; comparison is constant time. Each key is bound to one organization and one subject; revoked keys stop working immediately.
- `PLATFORM_ADMIN_TOKEN` (`smeadmin_` + 64 hex) enables platform routes (`POST /v1/admin/organizations`, `GET /v1/admin/system`). Without it provisioning is disabled.
- Every tenant route declares one RBAC permission. Before any handler runs, the server loads the subject's membership and roles for the key's organization and calls `authorizeOrganizationAction` against the **path** organization; mismatches, suspended memberships and missing permissions return a generic `403 authorization_denied` and are audited. Domain contracts then repeat their own tenant, operator and permission checks and audit every action.
- `POST /v1/admin/organizations` creates the organization, an `owner` role holding the full permission catalog, the owner membership and the first API key (returned once). Owners manage roles (`PUT .../roles/{roleId}`), memberships (`PUT .../members/{subjectId}`) and keys (`POST/DELETE .../api-keys`).

## Request handling

Security headers on every response, allow-listed CORS (`CORS_ORIGINS`, HTTPS only), `X-Contract-Version: 1` on authenticated `/v1` routes, JSON-only bodies up to 256 KiB validated against the published schema (unknown properties rejected), 15 s request timeout, per-credential token-bucket rate limiting (`RATE_LIMIT_PER_MINUTE`, default 600). Domain rejections map to `422 {code: <domain>_rejected}`; unconfigured adapters to `503 dependency_unavailable`; unexpected errors to `500 internal_error` without details.

## Persistence

Identity (organizations, roles, memberships, API keys, audit events) uses dedicated tables. Domain records use `marketplace.documents`: one row per contract value keyed by `(organization_id, kind, id)` with JSONB data, compare-and-swap updates on the full previous value, atomic multi-document batches, unique secondary keys in `marketplace.document_keys`, and forced row-level security on `app.organization_id`, which every repository transaction sets. Each domain store interface from `packages/contracts` is implemented as a thin adapter over this store (see `apps/api/src/routes/*.ts`).

## Routes wired today

Platform/identity, customers, providers and locations, feature flags, assistant registry, knowledge articles and chunks, AI quotas and grounded answers, grounding corrections, request drafts, turn director, research sources and findings, consent ledger, privacy requests, incidents, job rooms and Stripe Connect payment intents, notification intents and dispatch, push devices. The other domain contracts (leads, quotes, job-room chat/media/estimates, scheduling, reviews, subscriptions, invoices and others) exist as tested contracts but are **not yet exposed over HTTP**.

## Adapters

| Adapter | Enabled by | Without configuration |
| --- | --- | --- |
| AI (Anthropic Messages API via `@anthropic-ai/sdk`, default model `claude-opus-5-5`, server-side refusal fallback) | `ANTHROPIC_API_KEY`, optional `AI_MODEL` | labelled deterministic fallback (extractive answers, rule-based extraction) |
| Stripe Connect destination charges | `STRIPE_SECRET_KEY` (`sk_test_` = sandbox) | `503 dependency_unavailable` |
| Background / credential checks (generic HTTPS vendor) | `BACKGROUND_CHECK_API_URL` + `BACKGROUND_CHECK_API_KEY`, or `BACKGROUND_CHECK_MODE=sandbox` (simulator that only ever returns `review`) | disabled |
| E-signature (generic HTTPS vendor, HMAC webhooks) | `ESIGN_API_URL`, `ESIGN_API_KEY`, `ESIGN_WEBHOOK_SECRET` | disabled; events never verify |
| Email (Resend) | `RESEND_API_KEY`, `EMAIL_FROM` | disabled |
| SMS (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | disabled |
| Push (Expo) | `PUSH_PROVIDER=expo`, optional `EXPO_ACCESS_TOKEN` | disabled |
| Object storage (S3/R2, SigV4 presigned URLs) | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_REGION`, `S3_PATH_STYLE` | disabled |

The background-check and e-sign adapters target a generic vendor shape (`POST /checks`, `POST /envelopes`); a specific vendor (Checkr, Dropbox Sign, DocuSign) needs a thin mapping once one is chosen. None of the live adapters has been exercised against a real provider account yet.
