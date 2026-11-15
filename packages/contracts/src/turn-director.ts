export const TURN_DIRECTOR_CONTRACT_VERSION = 1 as const;

/**
 * Multi-agent turn director. It ships disabled: `TURN_DIRECTOR_DEFAULTS.enabled` is false
 * and a deployment must both enable it in configuration and pass an enabled feature flag
 * evaluation before any agent is directed to speak. The director only chooses which
 * registered assistant may take the next turn; it never executes models or tools.
 */
export interface TurnDirectorAgent {
  readonly agentKey: string;
  readonly status: 'active' | 'disabled';
  readonly topics: readonly string[];
  readonly maximumTurns: number;
}

export interface TurnDirectorConfig {
  readonly enabled: boolean;
  readonly maximumTotalTurns: number;
  readonly handoffPhrases: readonly string[];
  readonly agents: readonly TurnDirectorAgent[];
}

export interface DirectedTurn {
  readonly speaker: 'customer' | 'human' | string;
  readonly text: string;
}

export type TurnDirection =
  | {readonly directed: true; readonly agentKey: string; readonly reason: 'topic_match' | 'rotation'}
  | {readonly directed: false; readonly reason: 'disabled' | 'flag_off' | 'invalid_config' |
      'turn_limit' | 'handoff_required' | 'awaiting_customer' | 'no_eligible_agent'};

export const TURN_DIRECTOR_DEFAULTS: TurnDirectorConfig = Object.freeze({
  enabled: false,
  maximumTotalTurns: 12,
  handoffPhrases: Object.freeze(['human', 'agent please', 'representative', 'speak to someone']),
  agents: Object.freeze([]),
});

const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,15}$/;
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export function validTurnDirectorConfig(config: TurnDirectorConfig): boolean {
  return typeof config?.enabled === 'boolean' && integer(config.maximumTotalTurns, 1, 100) &&
    Array.isArray(config.handoffPhrases) && config.handoffPhrases.length <= 32 &&
    config.handoffPhrases.every(phrase => typeof phrase === 'string' &&
      phrase.trim().length > 0 && phrase.length <= 64) &&
    Array.isArray(config.agents) && config.agents.length <= 16 &&
    new Set(config.agents.map(agent => agent.agentKey)).size === config.agents.length &&
    config.agents.every(agent => KEY.test(agent.agentKey) &&
      (agent.status === 'active' || agent.status === 'disabled') &&
      Array.isArray(agent.topics) && agent.topics.length <= 32 &&
      agent.topics.every((topic: string) => KEY.test(topic)) && integer(agent.maximumTurns, 1, 50));
}

/**
 * Chooses the next agent. Rules, in order: fail closed unless enabled and flagged on;
 * stop at the total turn limit; hand off to a human when the latest customer turn asks
 * for one; wait for the customer after any agent turn; never let one agent exceed its
 * own turn budget; prefer the agent whose topics best match the latest customer turn,
 * otherwise rotate to the least-used eligible agent (ties by key).
 */
export function directNextTurn(config: TurnDirectorConfig, featureFlagEnabled: boolean,
  transcript: readonly DirectedTurn[]): TurnDirection {
  if (!validTurnDirectorConfig(config)) return {directed: false, reason: 'invalid_config'};
  if (!config.enabled) return {directed: false, reason: 'disabled'};
  if (featureFlagEnabled !== true) return {directed: false, reason: 'flag_off'};
  if (!Array.isArray(transcript) || transcript.length === 0)
    return {directed: false, reason: 'awaiting_customer'};
  const agentKeys = new Set(config.agents.map(agent => agent.agentKey));
  const agentTurns = transcript.filter(turn => agentKeys.has(turn.speaker));
  if (agentTurns.length >= config.maximumTotalTurns) return {directed: false, reason: 'turn_limit'};
  const last = transcript[transcript.length - 1]!;
  if (last.speaker === 'human') return {directed: false, reason: 'handoff_required'};
  if (last.speaker !== 'customer') return {directed: false, reason: 'awaiting_customer'};
  const lastText = typeof last.text === 'string' ? last.text.toLowerCase() : '';
  if (config.handoffPhrases.some(phrase => lastText.includes(phrase.toLowerCase())))
    return {directed: false, reason: 'handoff_required'};
  const usage = new Map<string, number>();
  for (const turn of agentTurns) usage.set(turn.speaker, (usage.get(turn.speaker) ?? 0) + 1);
  const eligible = config.agents.filter(agent => agent.status === 'active' &&
    (usage.get(agent.agentKey) ?? 0) < agent.maximumTurns);
  if (eligible.length === 0) return {directed: false, reason: 'no_eligible_agent'};
  const words = new Set(lastText.split(/[^a-z0-9]+/).filter(Boolean));
  const scored = eligible.map(agent => ({agent,
    score: agent.topics.filter(topic => topic.split(/[.-]/).some(part => words.has(part))).length}))
    .sort((left, right) => right.score - left.score ||
      (usage.get(left.agent.agentKey) ?? 0) - (usage.get(right.agent.agentKey) ?? 0) ||
      (left.agent.agentKey < right.agent.agentKey ? -1 : 1));
  const chosen = scored[0]!;
  return {directed: true, agentKey: chosen.agent.agentKey,
    reason: chosen.score > 0 ? 'topic_match' : 'rotation'};
}
