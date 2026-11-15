# Retrieval grounding and corrections (SME-059)

`packages/contracts/src/retrieval-grounding.ts` provides deterministic retrieval, citation verification and a reviewed correction loop for AI answers.

- `retrieveChunks` is BM25 over **published, tenant-bound** knowledge chunks with stop-word removal and deterministic tie-breaking. Chunks suppressed by accepted corrections are never returned.
- `verifyGrounding` checks that each citation quote occurs verbatim (case and whitespace normalised) in a published, unsuppressed chunk of the same tenant. It reports `grounded`, `partially_grounded` or `ungrounded`, the coverage of answer sentences, and why each rejected citation failed (`unknown_chunk`, `suppressed_chunk`, `quote_not_found`, `malformed`). Cross-tenant and retired chunks count as unknown.
- `submitGroundingCorrection` (`ai-grounding:correct`) records `incorrect`, `outdated`, `missing-citation` or `unsafe` reports with exact replay.
- `reviewGroundingCorrection` (`ai-grounding:review`) accepts or rejects a submitted correction with an optimistic revision. The submitter can never review their own correction (separation of duties).
- Accepted `incorrect`, `outdated` and `unsafe` corrections suppress the chunk from retrieval and grounding until the content is replaced.

## HTTP

`POST /v1/organizations/{organizationId}/ai/answers` reserves AI quota through the SME-056 gateway, retrieves chunks, asks the configured AI provider for a JSON answer with verbatim quotes, and always returns the grounding report. Without `ANTHROPIC_API_KEY` the answer is extractive (first sentences of the top chunks) and labelled `provider: deterministic-fallback` with a `fallbackNotice`. Corrections are `POST .../ai/grounding-corrections` and `POST .../ai/grounding-corrections/{correctionId}/review`; chunks are managed with `PUT .../knowledge-chunks/{chunkId}`.
