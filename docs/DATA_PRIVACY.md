# Data privacy: exports, retention and deletion (SME-063)

`packages/contracts/src/data-privacy.ts`:

- `openPrivacyRequest` records an `export` or `deletion` request with a 30-day due date. Subjects file their own (`privacy:request`); privacy officers may file for others (`privacy:manage`). Replays are exact.
- `completePrivacyRequest` (`privacy:manage` only) closes a request as `completed` with a `sha256:` result digest, or `denied`, once, with an optimistic revision.
- `buildPrivacyExport` returns every record owned by the subject grouped by kind, sorted, with other subjects' identifiers redacted.
- `planRetention` produces delete/anonymize/retain actions from explicit policies. Records with no policy are retained, legal holds always win, and an invalid policy set plans nothing.
- `planSubjectDeletion` deletes owned records, anonymizes kinds under statutory retention and keeps legal holds.

## Service wiring

The API knows which document kinds hold personal data (`PERSONAL_DATA_KINDS` in `apps/api/src/routes/trust.ts`: customer profiles, request drafts, consent entries, privacy requests) and the retention policy for each (`RETENTION_POLICIES`). `GET .../privacy-requests/{id}/export` builds the export; `POST .../privacy-requests/{id}/completion` hashes the export or executes the deletion plan (deleting profiles and drafts, keeping consent and privacy records as statutory evidence) before closing the request.

Not yet automated: a scheduled job that applies `planRetention` across all tenants, and coverage of every other domain's document kinds.
