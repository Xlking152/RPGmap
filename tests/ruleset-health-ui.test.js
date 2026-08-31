import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const healthIndex = await readFile(new URL('../src/health/index.js', import.meta.url), 'utf8');
const instanceUi = await readFile(new URL('../src/health/instance-ui.js', import.meta.url), 'utf8');

test('map HUD keeps the Token portrait summary instead of registering the large selection editor', () => {
  assert.match(healthIndex, /createHealthInstanceUi/);
  assert.doesNotMatch(healthIndex, /selectionHud\.register/);
  assert.match(instanceUi, /\.selected-token-summary/);
  assert.match(instanceUi, /describeHealth\(state, \{ ruleset: api\.ruleset \}\)/);
});

test('instance drawer health fields and batch operations come from the active Ruleset presentation', () => {
  assert.match(instanceUi, /view\?\.compactFields/);
  assert.match(instanceUi, /view\?\.fields/);
  assert.match(instanceUi, /field\.operation\(value\)/);
  assert.match(instanceUi, /healthOperationPresentation\(operation, \{ ruleset \}\)/);
  assert.match(instanceUi, /applyDamageToTokenIds/);
  assert.match(instanceUi, /applyHealingToTokenIds/);
  assert.doesNotMatch(instanceUi, /bashing|lethal|aggravated|wound-track|B\/L\/A/);
});
