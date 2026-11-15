# Public professional research sourcing (SME-058)

`packages/contracts/src/research-sourcing.ts` lets a tenant register public, professionally maintained sources (licensing board registers, business registries, sanction lists) and record **cited, unverified findings** about provider organizations from them.

## Rules

- Sources are tenant-scoped, revisioned (`expectedRevision`), replayable by `requestKey`, and require organization RBAC (`research:sources:write`) plus an active operator grant.
- A source URL must be `https://` on a public hostname: literal IPs, `localhost`, single-label hosts, internal suffixes (`.local`, `.internal`, `.corp`, `.test`, `.example` ...), credentials and non-443 ports are refused, so research cannot become a server-side request forgery primitive.
- Each source declares a licence basis (`public-record`, `open-license`, `permission-granted`), allowed path prefixes and a retention period (1 to 3650 days).
- Findings (`research:findings:write`) must cite a URL under the source origin and one of its path prefixes (dot-segment traversal rejected), carry a `sha256:` content digest, be retrieved no more than 30 days ago, and name an existing provider in the same tenant.
- Excerpts and claim values are bounded and rejected when they contain email addresses, phone numbers or national identifier patterns.
- Every finding is `verification: 'unverified'` and expires with the source retention. Findings never approve onboarding or credentials; human reviewers use them as leads.
- Retired sources accept no new findings. Audit failure, stale revisions, non-exact replays and persistence failures all fail closed with `research_sourcing_rejected`.

## HTTP

`PUT /v1/organizations/{organizationId}/research-sources/{sourceKey}`, `POST .../research-findings`, `GET .../providers/{providerOrganizationId}/research-findings` (unexpired findings only).
