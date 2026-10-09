import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHealthInstanceUi } from '../src/health/instance-ui.js';

const healthIndex = await readFile(new URL('../src/health/index.js', import.meta.url), 'utf8');
const instanceUi = await readFile(new URL('../src/health/instance-ui.js', import.meta.url), 'utf8');

test('health summary ignores map destruction mutations while observing its own DOM and health events', () => {
  const callbacks = [], frames = [], handlers = new Map();
  let disconnected = 0;
  const host = { querySelector: () => null };
  const documentNode = { defaultView: {
    requestAnimationFrame: callback => frames.push(callback),
    MutationObserver: class {
      constructor(callback) { callbacks.push(callback); }
      observe() {}
      disconnect() { disconnected++; }
    },
  } };
  const api = { health: {}, selection: { subscribe() {} },
    map: { getContainer: () => ({ ownerDocument: documentNode, parentElement: host }) },
    on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); } };
  createHealthInstanceUi().register(api);
  frames.shift()();
  const mutate = (target, addedNodes = [], removedNodes = []) => callbacks[0]([{ target, addedNodes, removedNodes }]);
  const unrelated = { closest: () => null, matches: () => false, querySelector: () => null };
  for (let index = 0; index < 24; index++) mutate(unrelated, [unrelated], [unrelated]);
  assert.equal(frames.length, 0, 'ruins and map layer changes do not rederive health');
  const summary = { closest: () => summary, matches: () => true };
  mutate(summary);
  mutate({ nodeType: 3, parentElement: summary });
  assert.equal(frames.length, 1, 'summary changes still coalesce into a frame');
  frames.shift()();
  mutate(unrelated, [{ querySelector: () => summary }]);
  assert.equal(frames.length, 1, 'inserting a subtree containing the HUD refreshes it');
  frames.shift()();
  mutate(unrelated, [], [summary]);
  assert.equal(frames.length, 1, 'removing or replacing the HUD is observed');
  frames.shift()();
  handlers.get('health:change')();
  assert.equal(frames.length, 1, 'a health event does not depend on DOM mutation');
  frames.shift()();
  handlers.get('app:destroy')();
  mutate(summary);
  assert.equal(frames.length, 0);
  assert.equal(disconnected, 1);
});

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
