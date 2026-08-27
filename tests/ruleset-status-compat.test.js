import test from 'node:test';
import assert from 'node:assert/strict';
import { getActiveRuleset } from '../src/ruleset/index.js';
import { BUILTIN_STATUS_DEFINITIONS } from '../src/status/model.js';

test('active ruleset owns the same compatibility status IDs as the current status core', () => {
  const rulesetDefinitions = getActiveRuleset().statuses.definitions;
  assert.deepEqual(
    rulesetDefinitions.map(definition => definition.id),
    BUILTIN_STATUS_DEFINITIONS.map(definition => definition.id),
  );
  for (const definition of rulesetDefinitions) {
    const legacy = BUILTIN_STATUS_DEFINITIONS.find(item => item.id === definition.id);
    assert.ok(legacy, `missing legacy status ${definition.id}`);
    assert.equal(legacy.name, definition.name);
    assert.deepEqual(legacy.scopes, definition.scopes);
    assert.deepEqual(legacy.changes, definition.changes);
    assert.deepEqual(legacy.capabilities, definition.capabilities);
  }
});
