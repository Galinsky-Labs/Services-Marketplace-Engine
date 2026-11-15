# Multi-agent turn director, disabled by default (SME-061)

`packages/contracts/src/turn-director.ts` decides which registered assistant may speak next in a multi-agent conversation. It never runs models or tools.

It is **off by default** and needs two independent switches:

1. deployment configuration `TURN_DIRECTOR_ENABLED=true` (`TURN_DIRECTOR_DEFAULTS.enabled` is `false` and frozen), and
2. the tenant feature flag `ai.turn-director` enabled for the running environment (SME-053).

When either is off the director returns `{directed: false, reason: 'disabled' | 'flag_off'}`.

When enabled it fails closed on invalid configuration, stops at the total turn limit, hands off to a human on configured phrases or when a human has spoken, waits for the customer after every agent turn, enforces per-agent turn budgets, prefers topic matches and otherwise rotates to the least-used active agent with deterministic tie-breaking.

HTTP: `POST /v1/organizations/{organizationId}/ai/turn-director` (`turn-director:invoke`). The production deployment leaves `TURN_DIRECTOR_ENABLED` unset.
