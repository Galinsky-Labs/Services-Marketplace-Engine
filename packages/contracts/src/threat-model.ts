export type StrideCategory =
  | 'spoofing' | 'tampering' | 'repudiation' | 'information-disclosure'
  | 'denial-of-service' | 'elevation-of-privilege';

export interface ThreatEntry {
  readonly threatId: string;
  readonly category: StrideCategory;
  readonly asset: string;
  readonly threat: string;
  readonly mitigations: readonly string[];
  /** Repository-relative test files that exercise the mitigation. */
  readonly tests: readonly string[];
  readonly residualRisk: 'low' | 'medium' | 'high';
}

/**
 * Machine-readable threat model. `tests/threat-model.test.mjs` fails if any entry lacks a
 * mitigation, references a missing test file, or a STRIDE category has no entry.
 */
export const THREAT_MODEL: readonly ThreatEntry[] = Object.freeze([
  {threatId: 'T-01', category: 'spoofing', asset: 'API credentials',
    threat: 'Forged or guessed bearer tokens impersonate a tenant member.',
    mitigations: ['256-bit random API key secrets stored only as SHA-256 hashes',
      'constant-time hash comparison', 'revoked keys and inactive memberships fail closed'],
    tests: ['tests/http-security.test.mjs', 'tests/identity.test.mjs'], residualRisk: 'low'},
  {threatId: 'T-02', category: 'elevation-of-privilege', asset: 'Tenant data',
    threat: 'A member of one organization reads or writes another organization\'s records.',
    mitigations: ['route-level RBAC on the path organization', 'contract-level tenant checks',
      'Postgres row-level security keyed by app.organization_id'],
    tests: ['tests/http-security.test.mjs', 'tests/rbac.test.mjs', 'tests/postgres-repositories.test.mjs'],
    residualRisk: 'low'},
  {threatId: 'T-03', category: 'tampering', asset: 'Consent ledger',
    threat: 'Consent history is edited to fabricate a grant.',
    mitigations: ['append-only hash chain with compare-and-append', 'evaluation fails closed on broken chains'],
    tests: ['tests/consent-ledger.test.mjs'], residualRisk: 'low'},
  {threatId: 'T-04', category: 'repudiation', asset: 'Privileged actions',
    threat: 'An actor denies performing an authorization-sensitive action.',
    mitigations: ['every contract action appends a tenant audit event before acting',
      'audit sink failure denies the action'],
    tests: ['tests/audit.test.mjs', 'tests/http-api.test.mjs'], residualRisk: 'low'},
  {threatId: 'T-05', category: 'information-disclosure', asset: 'Error responses',
    threat: 'Stack traces, SQL errors or resource existence leak through error bodies.',
    mitigations: ['generic error codes only', 'domain rejections never echo stored fields',
      'security headers including no-store'],
    tests: ['tests/http-security.test.mjs', 'tests/openapi-sdk.test.mjs'], residualRisk: 'low'},
  {threatId: 'T-06', category: 'denial-of-service', asset: 'API availability',
    threat: 'Oversized bodies, slow requests or bursts exhaust the free-tier instance.',
    mitigations: ['256 KiB body cap', 'request timeout', 'per-credential token-bucket rate limit'],
    tests: ['tests/http-security.test.mjs'], residualRisk: 'medium'},
  {threatId: 'T-07', category: 'information-disclosure', asset: 'Internal network',
    threat: 'Server-side request forgery through research source or webhook URLs.',
    mitigations: ['HTTPS-only public hostnames', 'literal IPs, localhost and internal suffixes refused'],
    tests: ['tests/research-sourcing.test.mjs'], residualRisk: 'low'},
  {threatId: 'T-08', category: 'tampering', asset: 'AI outputs',
    threat: 'Prompt injection or hallucination produces ungrounded answers or unapproved actions.',
    mitigations: ['citations verified verbatim against published tenant chunks',
      'drafts require explicit customer approval', 'turn director disabled by default',
      'deterministic fallback is labelled'],
    tests: ['tests/retrieval-grounding.test.mjs', 'tests/conversational-draft.test.mjs',
      'tests/turn-director.test.mjs'], residualRisk: 'medium'},
  {threatId: 'T-09', category: 'spoofing', asset: 'Provider webhooks',
    threat: 'Forged payment or e-sign webhooks mark work as paid or signed.',
    mitigations: ['HMAC signature verification with timestamp tolerance', 'adapters disabled without secrets'],
    tests: ['tests/adapters.test.mjs', 'tests/esign.test.mjs'], residualRisk: 'medium'},
  {threatId: 'T-10', category: 'information-disclosure', asset: 'Personal data',
    threat: 'Exports or research findings expose other people\'s personal data.',
    mitigations: ['exports redact other subjects', 'research excerpts reject contact identifiers',
      'retention plans never delete without an explicit policy'],
    tests: ['tests/data-privacy.test.mjs', 'tests/research-sourcing.test.mjs'], residualRisk: 'medium'},
].map(entry => Object.freeze({...entry, mitigations: Object.freeze(entry.mitigations),
  tests: Object.freeze(entry.tests)})) as ThreatEntry[]);
