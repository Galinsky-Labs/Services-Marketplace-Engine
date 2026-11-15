# OpenAPI contract and generated SDK

`contracts/openapi.json` is the canonical public HTTP contract. It is **generated from the API route table** (`apps/api/src/routes/*.ts` plus `apps/api/src/openapi.ts`), so the document cannot drift from what the server validates and serves.

- `npm run build && npm run generate:openapi` rewrites the document; `npm run generate:openapi:check` (and `tests/contract-conformance.test.mjs`) fail when it is stale.
- `npm run generate:sdk` regenerates `packages/sdk/src/index.ts` from the document; CI runs `npm run generate:sdk:check`.

Every authenticated operation requires bearer authentication, `X-Contract-Version: 1`, and documents `400`, `401`, `403`, `404`, `409`, `413`, `429` and `503` error bodies plus a `422` body carrying its domain rejection code. `x-required-permission` names the RBAC permission checked against the path organization.

## Generated SDK

`createClient({baseUrl, bearerToken, fetch})` exposes one typed method per operation (path parameters positional, then the JSON body, then optional query parameters). The client requires an HTTPS base URL (plain HTTP is accepted only for `localhost`/`127.0.0.1`), a nonempty token and an injected fetch-compatible transport. It encodes path segments and rejects empty identifiers before network access, validates every success body against the published schema, and reduces any undocumented status or malformed body to `unexpected_response`. Error responses expose only their documented `code`; no other field of an error body reaches the caller. Component types are exported for consumers such as Get Docked.
