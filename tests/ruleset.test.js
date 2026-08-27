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
  assert.equal(typeof ruleset.importers.xlsx.importFile, 'function');
});

test('ruleset registry exposes built-ins and rejects unknown active rulesets', () => {
  assert.ok(listRulesets().some(item => item.id === 'infinite-horror'));
  assert.equal(setActiveRuleset('infinite-horror').id, 'infinite-horror');
  assert.throws(() => setActiveRuleset('missing-ruleset'), /Unknown ruleset/);
});
