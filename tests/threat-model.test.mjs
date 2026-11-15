import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {THREAT_MODEL} from '../packages/contracts/dist/threat-model.js';

const categories = ['spoofing', 'tampering', 'repudiation', 'information-disclosure',
  'denial-of-service', 'elevation-of-privilege'];

test('threat model covers every STRIDE category with mitigations and existing tests', () => {
  assert.deepEqual([...new Set(THREAT_MODEL.map(entry => entry.category))].sort(), [...categories].sort());
  const ids = new Set();
  for (const entry of THREAT_MODEL) {
    assert.match(entry.threatId, /^T-\d{2}$/);
    assert.equal(ids.has(entry.threatId), false, 'duplicate ' + entry.threatId);
    ids.add(entry.threatId);
    assert.ok(entry.mitigations.length > 0, entry.threatId);
    assert.ok(entry.tests.length > 0, entry.threatId);
    for (const file of entry.tests) assert.equal(fs.existsSync(file), true, entry.threatId + ' references missing ' + file);
    assert.ok(['low', 'medium', 'high'].includes(entry.residualRisk));
  }
  assert.equal(Object.isFrozen(THREAT_MODEL), true);
});

test('THREAT_MODEL.md documents every machine-readable threat', () => {
  const document = fs.readFileSync('docs/THREAT_MODEL.md', 'utf8');
  for (const entry of THREAT_MODEL) assert.match(document, new RegExp('\\b' + entry.threatId + '\\b'));
});
