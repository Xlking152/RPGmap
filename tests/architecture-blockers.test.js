import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRuleset } from '../src/ruleset/contract.js';
import { RulesetRegistry } from '../src/ruleset/registry.js';
import { getActiveRuleset, rulesetRegistry, setActiveRuleset } from '../src/ruleset/index.js';
import { hasWorldOperationRevisionGap, isWorldOperationChannelBusy } from '../src/multiplayer/controller.js';
import { actorUiCapabilities } from '../src/entities/ui.js';
import { renderActorHealthPanel } from '../src/health/sheet-extension.js';
import { synchronizeWorldV2FromRuntimeState } from '../src/world/model.js';
import { synchronizeWorldV2Mirror } from '../deployment/local-server/world-v2.mjs';
import { assertPersistedWorldV2, assertWorldRuleset } from '../src/world/validation.js';

function rawWorld() {
  return {
    schemaVersion: 2,
    id: 'world-test',
    name: 'World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    activeSceneId: 'scene-a',
    actors: [{ id: 'actor-a' }],
    statusDefinitions: [],
    scenes: [{
      id: 'scene-a',
      name: 'Scene',
      mapPackage: { id: 'test-map', version: '1.0.0' },
      tokens: [{ id: 'token-a', actorId: 'actor-a' }],
      markers: [], attackAreas: [], sceneEvents: [], settings: {},
    }],
  };
}

test('authoritative World operations start only while every network write channel is idle', () => {
  assert.equal(isWorldOperationChannelBusy({}), false);
  for (const state of [
    { applyingRemote: true },
    { remoteApplyPending: 1 },
    { inFlight: true },
    { pendingPush: true },
    { activeAtomicWorldOperation: {} },
    { atomicWorldOperationQueueLength: 1 },
    { activeStatusOperation: {} },
    { statusOperationQueueLength: 1 },
    { activeOperation: {} },
    { operationQueueLength: 1 },
  ]) assert.equal(isWorldOperationChannelBusy(state), true);
});

test('operation commits require the next contiguous World revision', () => {
  assert.equal(hasWorldOperationRevisionGap({ baseRevision: 4, revision: 5 }, 4), false);
  assert.equal(hasWorldOperationRevisionGap({ baseRevision: 3, revision: 4 }, 4), true);
  assert.equal(hasWorldOperationRevisionGap({ baseRevision: 4, revision: 6 }, 4), true);
  assert.equal(hasWorldOperationRevisionGap({ baseRevision: '4', revision: 5 }, 4), true);
  assert.equal(hasWorldOperationRevisionGap({ baseRevision: 4, revision: null }, 4), true);
});

test('Ruleset references reject missing, unknown, and incompatible versions explicitly', () => {
  const registry = new RulesetRegistry([{
    apiVersion: 1, id: 'test-ruleset', title: 'Test', version: '1.2.3',
  }]);
  assert.equal(registry.resolveReference({ id: 'test-ruleset', version: '1.2.3' }).id, 'test-ruleset');
  assert.throws(() => registry.resolveReference({}), error => error.code === 'world_ruleset_missing');
  assert.throws(() => registry.resolveReference({ id: 'missing', version: '1.0.0' }), error => error.code === 'unknown_ruleset');
  assert.throws(
    () => registry.resolveReference({ id: 'test-ruleset', version: '2.0.0' }),
    error => error.code === 'ruleset_version_incompatible',
  );
});

test('persisted World validation runs before normalization can repair invalid graphs', () => {
  assert.equal(assertPersistedWorldV2(rawWorld()).id, 'world-test');
  const wrongSchema = rawWorld();
  wrongSchema.schemaVersion = 99;
  assert.throws(() => assertPersistedWorldV2(wrongSchema), error => error.code === 'world_schema_incompatible');

  const duplicateActor = rawWorld();
  duplicateActor.actors.push({ id: 'actor-a' });
  assert.throws(() => assertPersistedWorldV2(duplicateActor), error => error.code === 'duplicate_id');

  const duplicateScene = rawWorld();
  duplicateScene.scenes.push(structuredClone(duplicateScene.scenes[0]));
  assert.throws(() => assertPersistedWorldV2(duplicateScene), error => error.code === 'duplicate_id');

  const duplicateToken = rawWorld();
  duplicateToken.scenes[0].tokens.push({ id: 'token-a', actorId: 'actor-a' });
  assert.throws(() => assertPersistedWorldV2(duplicateToken), error => error.code === 'duplicate_id');

  const brokenReference = rawWorld();
  brokenReference.scenes[0].tokens[0].actorId = 'missing';
  assert.throws(() => assertPersistedWorldV2(brokenReference), error => error.code === 'invalid_reference');
});

test('World normalization refuses to use a different or incompatible active Ruleset', () => {
  const world = rawWorld();
  assert.equal(assertWorldRuleset(world, { id: 'infinite-horror', version: '1.0.0' }).id, 'infinite-horror');
  assert.throws(
    () => assertWorldRuleset(world, { id: 'other', version: '1.0.0' }),
    error => error.code === 'world_ruleset_reload_required',
  );
  assert.throws(
    () => assertWorldRuleset(world, { id: 'infinite-horror', version: '2.0.0' }),
    error => error.code === 'ruleset_version_incompatible',
  );
});

test('explicitly empty custom status definitions remain empty in browser and server mirrors', () => {
  const existingWorld = rawWorld();
  existingWorld.statusDefinitions = [{ id: 'custom-status' }];
  const state = {
    markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      entitySystem: { actors: [{ id: 'actor-a' }], tokens: [], statusDefinitions: [] },
      worldV2: structuredClone(existingWorld),
    },
  };
  const browser = synchronizeWorldV2FromRuntimeState(state, {
    mapPackage: { id: 'test-map', version: '1.0.0' },
    existingWorld,
  });
  assert.deepEqual(browser.statusDefinitions, []);

  const serverState = structuredClone(state);
  synchronizeWorldV2Mirror(serverState);
  assert.deepEqual(serverState.preferences.worldV2.statusDefinitions, []);
});

test('minimal Ruleset without Health, variants, or XLSX importer hides optional UI', () => {
  const originalId = getActiveRuleset().id;
  const id = 'no-optional-ui-test';
  if (!rulesetRegistry.has(id)) {
    rulesetRegistry.register(prepareRuleset({ apiVersion: 1, id, title: 'No Optional UI', version: '1.0.0' }));
  }
  setActiveRuleset(id);
  try {
    const capabilities = actorUiCapabilities(getActiveRuleset(), { variants: [] });
    assert.deepEqual(capabilities, { canImportXlsx: false, hasVariants: false, canCycleVariants: false });
    assert.equal(renderActorHealthPanel({}, { id: 'actor-a', name: 'Actor', system: {}, effects: [] }), '');
  } finally {
    setActiveRuleset(originalId);
  }
});
