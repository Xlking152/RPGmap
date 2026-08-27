import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULESET_API_VERSION,
  activeRulesetIdValue,
  getActiveRuleset,
  listRulesets,
  setActiveRuleset,
} from '../src/ruleset/index.js';

test('infinite horror is registered as the default built-in ruleset', () => {
  assert.equal(RULESET_API_VERSION, 1);
  assert.equal(activeRulesetIdValue(), 'infinite-horror');

  const ruleset = getActiveRuleset();
  assert.equal(ruleset.id, 'infinite-horror');
  assert.equal(ruleset.title, '无限跑团');
  assert.deepEqual(ruleset.actor.resourceDefinitions.map(item => item.id), ['hp', 'stamina', 'willpower']);
  assert.equal(ruleset.actor.badStatusDefinitions.length, 21);
  assert.equal(ruleset.health.defaultModeForSource('xlsx'), 'wound-track');
  assert.equal(ruleset.health.defaultModeForSource('legacy-character'), 'simple');
  assert.equal(typeof ruleset.health.normalizeRuntime, 'function');
  assert.equal(typeof ruleset.health.resolve, 'function');
  assert.equal(typeof ruleset.health.applyRuntimeOperation, 'function');
  assert.equal(typeof ruleset.health.applyDamage, 'function');
  assert.equal(typeof ruleset.health.applyHealing, 'function');
  assert.equal(typeof ruleset.health.presentation.describe, 'function');
  assert.deepEqual(ruleset.statuses.definitions.map(item => item.id), [
    'status-spirit', 'status-rooted', 'status-incapacitated',
  ]);
  assert.equal(typeof ruleset.statuses.derive, 'function');
  assert.equal(typeof ruleset.importers.xlsx.importFile, 'function');
});

test('infinite horror health operations preserve simple and wound-track semantics', () => {
  const health = getActiveRuleset().health;
  const simple = health.createRuntime({ mode: 'simple', max: 10, simpleCurrent: 10 });
  const simpleDamage = health.applyDamage({ runtime: simple, current: 10, max: 10, amount: 3, type: 'L' });
  assert.equal(simpleDamage.current, 7);
  assert.equal(simpleDamage.applied, 3);

  const wound = health.createRuntime({ mode: 'wound-track', max: 10, simpleCurrent: 10 });
  const woundDamage = health.applyDamage({ runtime: wound, current: 10, max: 10, amount: 2, type: 'L' });
  assert.equal(woundDamage.current, 8);
  assert.equal(woundDamage.state.lethal, 2);
});

test('ruleset registry exposes built-ins and rejects unknown active rulesets', () => {
  assert.ok(listRulesets().some(item => item.id === 'infinite-horror'));
  assert.equal(setActiveRuleset('infinite-horror').id, 'infinite-horror');
  assert.throws(() => setActiveRuleset('missing-ruleset'), /Unknown ruleset/);
});
