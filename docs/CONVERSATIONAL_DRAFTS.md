# Conversational request drafts and approvals (SME-060)

`packages/contracts/src/conversational-draft.ts` turns a customer conversation into a structured service-request draft that **only the customer can approve**.

- Drafts are created with `request-drafts:create` against declared field specs (`text`, `number`, `boolean`, `date`, `postal-code`, required or optional). Proposed values for unknown fields or of the wrong type reject the whole extraction (contaminated output fails closed); missing required fields are listed in `missingFieldKeys`.
- Every draft records its `extractionSource`: `ai-provider` or `deterministic-fallback`. The fallback `extractDraftFieldsDeterministic` reads customer turns only and recognises explicit `field: value` statements, ISO dates and five-digit postal codes; it never invents values.
- `decideConversationalDraft` lets the owning customer approve or reject once, with an optimistic revision, before expiry (default 7 days). Incomplete drafts cannot be approved. Another member of the same tenant cannot decide someone else's draft.
- Approval does not submit a lead; the calling application creates the lead from the approved fields through the lead contracts.

## HTTP

`POST /v1/organizations/{organizationId}/request-drafts` (extraction with the AI provider when configured, otherwise the labelled fallback) and `POST .../request-drafts/{draftId}/decision`.
