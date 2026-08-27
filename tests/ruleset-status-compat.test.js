import test from 'node:test';
import assert from 'node:assert/strict';
import { getActiveRuleset } from '../src/ruleset/index.js';
import { getStatusDefinitions } from '../src/status/model.js';
import { normalizeWorldV2 } from '../src/world/model.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: 'Test Map' };

test('World normalization refreshes ruleset built-ins and preserves custom status definitions', () => {
  const ruleset = getActiveRuleset();
  const custom = {
    id: 'status-custom', name: 'Custom', description: '', icon: 'star', color: '#225588',
    category: 'buff', scopes: ['actor'], maxStacks: 1, changes: [], capabilities: {}, builtIn: false,
  };
  const staleBuiltIn = { ...structuredClone(ruleset.statuses.definitions[0]), name: 'Stale Name' };
  const world = normalizeWorldV2({
    id: 'world-test', ruleset: { id: ruleset.id, version: ruleset.version }, actors: [], scenes: [],
    statusDefinitions: [staleBuiltIn, custom],
  }, { mapPackage, ruleset });

  assert.deepEqual(
    world.statusDefinitions.slice(0, ruleset.statuses.definitions.length).map(definition => definition.id),
    ruleset.statuses.definitions.map(definition => definition.id),
  );
  assert.equal(world.statusDefinitions[0].name, ruleset.statuses.definitions[0].name);
  assert.deepEqual(world.statusDefinitions.find(definition => definition.id === custom.id), custom);
});

test('Core status resolution reads only definitions persisted in the World projection', () => {
  assert.deepEqual(getStatusDefinitions({ statusDefinitions: [] }), []);
  const persisted = structuredClone(getActiveRuleset().statuses.definitions);
  assert.deepEqual(getStatusDefinitions({ statusDefinitions: persisted }).map(definition => definition.id), persisted.map(definition => definition.id));
});
