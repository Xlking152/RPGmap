import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveActorDocument,
  explainActorCalculation,
  normalizeActorDocument,
} from '../src/actor/index.js';
import { getActiveRuleset, prepareRuleset } from '../src/ruleset/index.js';

function actorFixture() {
  return normalizeActorDocument({
    id: 'actor-calculation',
    name: 'Calculation Actor',
    type: 'pc',
    partyId: 'party',
    system: {
      schemaVersion: 3,
      currentFormId: 'form',
      forms: [{
        id: 'form', name: 'Form', source: { type: 'manual' },
        healthBase: { baseMax: 10 }, resourceBases: {},
        attributes: [{ id: 'perception', name: 'Perception', base: 10 }],
        checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
      }],
      runtime: {
        resources: {}, customResources: [], attributeAdjustments: { perception: 1 },
        badStatuses: {}, health: { mode: 'simple', maxOverride: null, simpleCurrent: 10 },
      },
    },
    effects: [],
  }, { ruleset: getActiveRuleset() });
}

test('Ruleset calculation explanation is the value used by derivation and is stable by priority and Effect id', () => {
  const actor = actorFixture();
  const effects = [
    { id: 'effect-b', label: 'B', priority: 10, enabled: true, changes: [{ target: 'system.attributes.perception', mode: 'multiply', value: 2 }] },
    { id: 'effect-disabled', label: 'Disabled', priority: 5, enabled: false, changes: [{ target: 'system.attributes.perception', mode: 'add', value: 100 }] },
    { id: 'effect-a', label: 'A', priority: 10, enabled: true, changes: [{ target: 'system.attributes.perception', mode: 'add', value: 3 }] },
  ];
  const context = { ruleset: getActiveRuleset(), effects };
  const explanation = explainActorCalculation(actor, 'system.attributes.perception', context);
  const derived = deriveActorDocument(actor, context);

  assert.equal(explanation.baseValue, 10);
  assert.deepEqual(explanation.sources.map(source => source.sourceId), [
    'runtime:perception', 'effect-disabled', 'effect-a', 'effect-b',
  ]);
  assert.equal(explanation.sources[1].applied, false);
  assert.equal(explanation.sources[1].reason, 'disabled');
  assert.equal(explanation.result, 28);
  assert.equal(derived.attributes[0].value, explanation.result);
  assert.deepEqual(derived.attributes[0].calculation, explanation);
});

test('minimal Rulesets expose a deterministic calculation explanation fallback', () => {
  const ruleset = prepareRuleset({ id: 'minimal', title: 'Minimal', version: '1' });
  const fallback = ruleset.calculations.explain(null, { target: 'value', baseValue: 4 });
  assert.equal(typeof ruleset.calculations.explain, 'function');
  assert.equal(fallback.target, 'value');
  assert.equal(fallback.result, 4);
});
