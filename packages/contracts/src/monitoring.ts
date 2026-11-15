import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const MONITORING_CONTRACT_VERSION = 1 as const;
export const MONITORING_REJECTED = 'monitoring_rejected' as const;

export interface MetricSample {
  readonly metric: string;
  readonly at: number;
  readonly value: number;
}

export interface AlertRule {
  readonly ruleKey: string;
  readonly metric: string;
  readonly aggregation: 'avg' | 'max' | 'sum' | 'p95' | 'count';
  readonly comparator: '>' | '>=' | '<' | '<=';
  readonly threshold: number;
  readonly windowMs: number;
  readonly minimumSamples: number;
  readonly severity: 'sev1' | 'sev2' | 'sev3';
}

export interface FiringAlert {
  readonly ruleKey: string;
  readonly severity: AlertRule['severity'];
  readonly observed: number;
  readonly threshold: number;
  readonly sampleCount: number;
  readonly dedupeKey: string;
}

export type IncidentStatus = 'open' | 'acknowledged' | 'mitigated' | 'resolved';

export interface Incident {
  readonly incidentId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly dedupeKey: string;
  readonly title: string;
  readonly severity: AlertRule['severity'];
  readonly status: IncidentStatus;
  readonly openedAt: number;
  readonly updatedAt: number;
  readonly commanderSubjectId: string | null;
  readonly postmortemUrl: string | null;
  readonly timeline: readonly {readonly at: number; readonly subjectId: string;
    readonly status: IncidentStatus; readonly note: string}[];
  readonly revision: number;
}

export interface IncidentStore {
  getIncident(organizationId: string, incidentId: string): Promise<Incident | null>;
  getOpenByDedupeKey(organizationId: string, dedupeKey: string): Promise<Incident | null>;
  getByRequestKey(organizationId: string, requestKey: string): Promise<Incident | null>;
  commitIncident(current: Incident | null, next: Incident): Promise<boolean>;
}

export interface IncidentOptions {
  readonly store: IncidentStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type IncidentResult =
  | {readonly accepted: true; readonly value: Incident; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof MONITORING_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,15}$/;
const DATE = 8_640_000_000_000_000;
const SEVERITIES: readonly string[] = ['sev1', 'sev2', 'sev3'];
const TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  open: ['acknowledged', 'mitigated', 'resolved'],
  acknowledged: ['mitigated', 'resolved'],
  mitigated: ['resolved', 'acknowledged'],
  resolved: [],
};
const rejected = (): IncidentResult => ({accepted: false, code: MONITORING_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const text = (value: string, maximum: number): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

export function validAlertRule(rule: AlertRule): boolean {
  return KEY.test(rule?.ruleKey) && KEY.test(rule.metric) &&
    ['avg', 'max', 'sum', 'p95', 'count'].includes(rule.aggregation) &&
    ['>', '>=', '<', '<='].includes(rule.comparator) && Number.isFinite(rule.threshold) &&
    integer(rule.windowMs, 1_000, 86_400_000) && integer(rule.minimumSamples, 1, 100_000) &&
    SEVERITIES.includes(rule.severity);
}

function aggregate(values: readonly number[], aggregation: AlertRule['aggregation']): number {
  switch (aggregation) {
  case 'count': return values.length;
  case 'sum': return values.reduce((sum, value) => sum + value, 0);
  case 'avg': return values.reduce((sum, value) => sum + value, 0) / values.length;
  case 'max': return Math.max(...values);
  case 'p95': {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
  }
  }
}

/**
 * Evaluates threshold rules over the trailing window. Invalid rules are skipped and
 * reported as firing `sev3` configuration alerts so a broken rule is never silent.
 */
export function evaluateAlertRules(rules: readonly AlertRule[], samples: readonly MetricSample[],
  now: number): readonly FiringAlert[] {
  if (!Array.isArray(rules) || !Array.isArray(samples) || !integer(now, 0, DATE))
    return Object.freeze([]);
  const firing: FiringAlert[] = [];
  for (const rule of rules) {
    if (!validAlertRule(rule)) {
      firing.push(Object.freeze({ruleKey: 'monitoring.invalid-rule', severity: 'sev3',
        observed: 1, threshold: 0, sampleCount: 0,
        dedupeKey: 'monitoring.invalid-rule:' + String(rule?.ruleKey ?? 'unknown').slice(0, 64)}));
      continue;
    }
    const values = samples.filter(sample => sample.metric === rule.metric &&
      sample.at > now - rule.windowMs && sample.at <= now && Number.isFinite(sample.value))
      .map(sample => sample.value);
    if (values.length < rule.minimumSamples) continue;
    const observed = Math.round(aggregate(values, rule.aggregation) * 1_000_000) / 1_000_000;
    const breached = rule.comparator === '>' ? observed > rule.threshold
      : rule.comparator === '>=' ? observed >= rule.threshold
        : rule.comparator === '<' ? observed < rule.threshold : observed <= rule.threshold;
    if (breached) firing.push(Object.freeze({ruleKey: rule.ruleKey, severity: rule.severity,
      observed, threshold: rule.threshold, sampleCount: values.length,
      dedupeKey: rule.ruleKey}));
  }
  return Object.freeze(firing.sort((left, right) => left.severity < right.severity ? -1
    : left.severity > right.severity ? 1 : left.ruleKey < right.ruleKey ? -1 : 1));
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, action: string, options: IncidentOptions) {
  const authorization = await authorizeAndAuditOrganizationAction(request, state, action,
    options.audit);
  return authorization.authorized &&
    request.requiredPermission === 'operations:incidents:write' ? authorization : null;
}

/** Opens an incident, deduplicating against an unresolved incident with the same key. */
export async function openIncident(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly requestKey: string; readonly dedupeKey: string; readonly title: string;
    readonly severity: AlertRule['severity']},
  options: IncidentOptions): Promise<IncidentResult> {
  try {
    const authorization = await authorize(request, state, 'operations.incident.open', options);
    const now = options.now();
    if (authorization === null || contractVersion !== MONITORING_CONTRACT_VERSION ||
      !integer(now, 0, DATE) || !ID.test(input.requestKey) || !ID.test(input.dedupeKey) ||
      !text(input.title, 200) || !SEVERITIES.includes(input.severity)) return rejected();
    const organizationId = authorization.organizationId;
    const [replay, existing] = await Promise.all([
      options.store.getByRequestKey(organizationId, input.requestKey),
      options.store.getOpenByDedupeKey(organizationId, input.dedupeKey),
    ]);
    if (replay !== null) return replay.organizationId === organizationId &&
      replay.dedupeKey === input.dedupeKey ? {accepted: true, value: replay, replayed: true}
      : rejected();
    if (existing !== null) return existing.organizationId === organizationId &&
      existing.status !== 'resolved' ? {accepted: true, value: existing, replayed: true}
      : rejected();
    const incidentId = options.createOpaqueId();
    if (!ID.test(incidentId)) return rejected();
    const value: Incident = Object.freeze({incidentId, organizationId,
      requestKey: input.requestKey, dedupeKey: input.dedupeKey, title: input.title.trim(),
      severity: input.severity, status: 'open', openedAt: now, updatedAt: now,
      commanderSubjectId: null, postmortemUrl: null,
      timeline: Object.freeze([Object.freeze({at: now, subjectId: authorization.subjectId,
        status: 'open' as const, note: 'opened'})]), revision: 1});
    return await options.store.commitIncident(null, value)
      ? {accepted: true, value, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

/**
 * Moves an incident forward. Acknowledging assigns the actor as commander. Resolving a
 * sev1 or sev2 incident requires an HTTPS postmortem link.
 */
export async function transitionIncident(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {readonly incidentId: string; readonly status: IncidentStatus; readonly note: string;
    readonly postmortemUrl: string | null; readonly expectedRevision: number},
  options: IncidentOptions): Promise<IncidentResult> {
  try {
    const authorization = await authorize(request, state, 'operations.incident.transition',
      options);
    const now = options.now();
    if (authorization === null || contractVersion !== MONITORING_CONTRACT_VERSION ||
      !integer(now, 0, DATE) || !ID.test(input.incidentId) || !text(input.note, 2_000) ||
      !integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
      (input.postmortemUrl !== null && (typeof input.postmortemUrl !== 'string' ||
        !/^https:\/\/[^\s]{3,2000}$/.test(input.postmortemUrl)))) return rejected();
    const current = await options.store.getIncident(authorization.organizationId,
      input.incidentId);
    if (current?.organizationId !== authorization.organizationId ||
      current.incidentId !== input.incidentId || current.revision !== input.expectedRevision ||
      !TRANSITIONS[current.status]?.includes(input.status) || current.updatedAt > now)
      return rejected();
    const postmortemUrl = input.postmortemUrl ?? current.postmortemUrl;
    if (input.status === 'resolved' && current.severity !== 'sev3' && postmortemUrl === null)
      return rejected();
    const next: Incident = Object.freeze({...current, status: input.status, updatedAt: now,
      postmortemUrl,
      commanderSubjectId: input.status === 'acknowledged' && current.commanderSubjectId === null
        ? authorization.subjectId : current.commanderSubjectId,
      timeline: Object.freeze([...current.timeline, Object.freeze({at: now,
        subjectId: authorization.subjectId, status: input.status, note: input.note.trim()})]),
      revision: current.revision + 1});
    return await options.store.commitIncident(current, next)
      ? {accepted: true, value: next, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
