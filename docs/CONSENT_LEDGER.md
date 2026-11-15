# Rights and consent ledger (SME-062)

`packages/contracts/src/consent-ledger.ts` keeps an append-only, hash-chained consent ledger per subject and tenant.

- Purposes: `terms-of-service`, `privacy-notice`, `marketing-email`, `marketing-sms`, `push-notifications`, `ai-processing`, `data-sharing`, `call-recording`. Decisions are `granted` or `withdrawn`, tied to a notice version and channel.
- Each entry commits to `[entryId, organizationId, subjectId, sequence, requestKey, purpose, decision, noticeVersion, channel, recordedBySubjectId, recordedAt, previousHash]` with SHA-256; the first entry links to a zero genesis hash. Appends are compare-and-append on the subject's head, so concurrent writers cannot fork the chain.
- Subjects record their own decisions with `consent:record`. Staff recording for someone else need `consent:manage` and must use the `support` channel.
- `verifyConsentChain` checks sequence, links, ownership, ordering and every hash. `evaluateConsent` returns the latest decision for a purpose at a time and is **not granted** whenever the chain is broken, the purpose is unknown, no decision exists, or a required notice version does not match.

HTTP: `POST /v1/organizations/{organizationId}/consents` and `GET .../consents/{subjectId}/{purpose}`. In Postgres the chain head and entries are documents written in one transaction.
