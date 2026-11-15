import test from 'node:test';
import assert from 'node:assert/strict';
import {TURN_DIRECTOR_DEFAULTS, directNextTurn} from '../packages/contracts/dist/turn-director.js';

const config = {enabled: true, maximumTotalTurns: 4, handoffPhrases: ['human'], agents: [
  {agentKey: 'billing.agent', status: 'active', topics: ['billing', 'refund'], maximumTurns: 2},
  {agentKey: 'scheduling.agent', status: 'active', topics: ['schedule', 'appointment'], maximumTurns: 2},
  {agentKey: 'retired.agent', status: 'disabled', topics: ['refund'], maximumTurns: 5}]};

test('ships disabled and requires both configuration and feature flag', () => {
  assert.equal(TURN_DIRECTOR_DEFAULTS.enabled, false);
  assert.equal(Object.isFrozen(TURN_DIRECTOR_DEFAULTS), true);
  const transcript = [{speaker: 'customer', text: 'I need a refund'}];
  assert.deepEqual(directNextTurn(TURN_DIRECTOR_DEFAULTS, true, transcript), {directed: false, reason: 'disabled'});
  assert.deepEqual(directNextTurn({...config, enabled: false}, true, transcript), {directed: false, reason: 'disabled'});
  assert.deepEqual(directNextTurn(config, false, transcript), {directed: false, reason: 'flag_off'});
  assert.deepEqual(directNextTurn(config, 'true', transcript), {directed: false, reason: 'flag_off'});
});

test('routes by topic, rotates, enforces budgets and waits for the customer', () => {
  assert.deepEqual(directNextTurn(config, true, [{speaker: 'customer', text: 'Refund please'}]),
    {directed: true, agentKey: 'billing.agent', reason: 'topic_match'});
  assert.deepEqual(directNextTurn(config, true, [{speaker: 'customer', text: 'hello'}]),
    {directed: true, agentKey: 'billing.agent', reason: 'rotation'});
  assert.deepEqual(directNextTurn(config, true, [{speaker: 'customer', text: 'hello'},
    {speaker: 'billing.agent', text: 'hi'}]), {directed: false, reason: 'awaiting_customer'});
  const used = [{speaker: 'customer', text: 'refund'}, {speaker: 'billing.agent', text: 'a'},
    {speaker: 'customer', text: 'refund'}, {speaker: 'billing.agent', text: 'b'},
    {speaker: 'customer', text: 'refund again'}];
  assert.deepEqual(directNextTurn(config, true, used),
    {directed: true, agentKey: 'scheduling.agent', reason: 'rotation'});
});

test('stops on turn limit, handoff requests, and invalid configuration', () => {
  const many = [];
  for (let index = 0; index < 4; index += 1) many.push({speaker: 'customer', text: 'x'},
    {speaker: index % 2 ? 'billing.agent' : 'scheduling.agent', text: 'y'});
  many.push({speaker: 'customer', text: 'more'});
  assert.deepEqual(directNextTurn(config, true, many), {directed: false, reason: 'turn_limit'});
  assert.deepEqual(directNextTurn(config, true, [{speaker: 'customer', text: 'Let me talk to a HUMAN'}]),
    {directed: false, reason: 'handoff_required'});
  assert.deepEqual(directNextTurn(config, true, [{speaker: 'human', text: 'taking over'}]),
    {directed: false, reason: 'handoff_required'});
  assert.deepEqual(directNextTurn({...config, agents: [...config.agents, config.agents[0]]}, true,
    [{speaker: 'customer', text: 'x'}]), {directed: false, reason: 'invalid_config'});
  assert.deepEqual(directNextTurn({...config, agents: [config.agents[2]]}, true,
    [{speaker: 'customer', text: 'refund'}]), {directed: false, reason: 'no_eligible_agent'});
});
