import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULESET_BOOTSTRAP_STORAGE_KEY,
  readRulesetBootstrap,
  writeRulesetBootstrap,
} from '../src/ruleset/setup.js';
import { activeRulesetIdValue } from '../src/ruleset/index.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get(key) { return values.get(String(key)) ?? null; },
    set(key, value) { values.set(String(key), String(value)); },
    remove(key) { values.delete(String(key)); },
    value(key) { return values.get(String(key)) ?? null; },
  };
}

test('ruleset bootstrap persists a valid pre-map selection', () => {
  const storage = memoryStorage();
  const ruleset = writeRulesetBootstrap(storage, 'infinite-horror');
  assert.equal(ruleset.id, 'infinite-horror');
  assert.equal(activeRulesetIdValue(), 'infinite-horror');
  assert.deepEqual(readRulesetBootstrap(storage), { rulesetId: 'infinite-horror' });

  const raw = JSON.parse(storage.value(RULESET_BOOTSTRAP_STORAGE_KEY));
  assert.equal(raw.rulesetId, 'infinite-horror');
  assert.equal(raw.version, ruleset.version);
});

test('ruleset bootstrap ignores malformed or unknown stored selections', () => {
  assert.equal(readRulesetBootstrap(memoryStorage({
    [RULESET_BOOTSTRAP_STORAGE_KEY]: '{broken',
  })), null);
  assert.equal(readRulesetBootstrap(memoryStorage({
    [RULESET_BOOTSTRAP_STORAGE_KEY]: JSON.stringify({ rulesetId: 'missing-ruleset' }),
  })), null);
});

test('ruleset bootstrap refuses to persist an unknown ruleset', () => {
  const storage = memoryStorage();
  assert.throws(() => writeRulesetBootstrap(storage, 'missing-ruleset'), /Unknown ruleset/);
  assert.equal(storage.value(RULESET_BOOTSTRAP_STORAGE_KEY), null);
});
