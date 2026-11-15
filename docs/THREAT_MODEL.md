# Threat model and security tests (SME-065)

The machine-readable model is `THREAT_MODEL` in `packages/contracts/src/threat-model.ts`. `tests/threat-model.test.mjs` fails if any STRIDE category lacks an entry, an entry has no mitigation, or a referenced test file is missing. This document must mention every threat id.

## System

One Node.js web service (`apps/api`) in front of Postgres (Neon). Tenants authenticate with organization-bound API keys; platform operators use one admin token. External processors (Stripe, e-sign, background checks, email/SMS/push, S3-compatible storage, Anthropic) are reached only through adapters that are disabled without configuration.

## Threats

| Id | STRIDE | Asset | Mitigations | Tests |
| --- | --- | --- | --- | --- |
| T-01 | Spoofing | API credentials | 256-bit secrets, SHA-256 at rest, constant-time compare, revocation, uniform 401 | `http-security`, `identity` |
| T-02 | Elevation of privilege | Tenant data | path-organization RBAC gate, contract tenant checks, Postgres RLS on `documents` | `http-security`, `rbac`, `postgres-repositories` |
| T-03 | Tampering | Consent ledger | hash chain, compare-and-append, fail-closed evaluation | `consent-ledger` |
| T-04 | Repudiation | Privileged actions | audit event before every contract action; audit failure denies | `audit`, `http-api` |
| T-05 | Information disclosure | Error responses | generic codes, no stack traces, `no-store` and security headers | `http-security`, `openapi-sdk` |
| T-06 | Denial of service | Availability | 256 KiB body cap, 15 s request timeout, URL length cap, token-bucket rate limit | `http-security`, `load` |
| T-07 | Information disclosure | Internal network | HTTPS public-hostname allow rules for research URLs | `research-sourcing` |
| T-08 | Tampering | AI outputs | verbatim citation verification, customer-approved drafts, disabled turn director, labelled fallback, model output parsed as data | `retrieval-grounding`, `conversational-draft`, `turn-director` |
| T-09 | Spoofing | Provider webhooks | HMAC verification with timestamp tolerance; adapters disabled without secrets | `adapters`, `esign` |
| T-10 | Information disclosure | Personal data | redacted exports, identifier-free research excerpts, policy-only retention | `data-privacy`, `research-sourcing` |

## Residual risks and open items

- No inbound Stripe webhook route yet (the verifier exists and is tested); payment status changes after intent creation are not ingested.
- Rate limiting is per process; a multi-instance deployment needs a shared limiter.
- The platform admin token is a single shared secret; rotate it by changing the Render env var.
- No independent penetration test or external security review has been performed.
