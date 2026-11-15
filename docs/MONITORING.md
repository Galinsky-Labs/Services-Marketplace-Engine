# Monitoring, alerts and incidents (SME-064)

`packages/contracts/src/monitoring.ts`:

- `evaluateAlertRules` evaluates threshold rules (`avg`, `max`, `sum`, `p95`, `count`; `>`, `>=`, `<`, `<=`) over a trailing window with a minimum sample count. Invalid rules are not silently ignored: each produces a `sev3` `monitoring.invalid-rule` alert.
- `openIncident` (`operations:incidents:write`) deduplicates against an unresolved incident with the same key and replays exactly by request key.
- `transitionIncident` follows `open -> acknowledged -> mitigated -> resolved` (mitigated may reopen to acknowledged), assigns the first acknowledger as commander, appends to the timeline, and requires an HTTPS postmortem link to resolve `sev1`/`sev2` incidents. Resolved incidents are final.

## Service wiring

- Every request emits one JSON log line (`requestId`, `operationId`, `status`, `durationMs`; never bodies or credentials) and records `http.requests`, `http.latency_ms` and `http.5xx` samples in a bounded in-process recorder.
- `GET /v1/admin/system` (platform admin token) returns adapter modes, counters and the alerts firing under `DEFAULT_ALERT_RULES` (5xx burst, p95 latency).
- Render health checks call `/health`; `/ready` checks the database.
- Incidents: `POST /v1/organizations/{organizationId}/incidents`, `POST .../incidents/{incidentId}/transitions`, `GET .../incidents/{incidentId}`.

Not yet in place: an external pager or uptime monitor, and metrics retained across restarts (the free Render instance sleeps after inactivity, so in-process metrics reset).
