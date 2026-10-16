import test from 'node:test';
import assert from 'node:assert/strict';
import { incrementalEnvironmentRestoreOperations } from '../scripts/v3-incremental-environment-audit.mjs';
import { applyWorldOperations } from '../src/world/operations.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

test('audit cleanup uses the actual reducer contract to restore full dark-scene settings and preserve all 500 Tokens', () => {
  const originalToken = { id: 'token-0', actorId: 'actor', actorLink: true, actorDelta: null,
    placement: 'map', x: 2900, y: 2500, elevationMeters: 0, diameterMeters: 1,
    rotation: 0, locked: false, showName: true, effects: [],
    vision: { enabled: true, preciseRangeOverrideMeters: 80, vagueRangeOverrideMeters: 120, overrideUserIds: [] } };
  const original = { token: originalToken, scene: { id: 'scene', sceneEvents: [],
    featureStates: { door: { open: true } }, settings: { gridVisible: true,
      lineOfSightEnabled: true, lighting: 'dark', movementBudgetMetersPerTurn: 30,
      defaultDoorInteractionRangeMeters: 2 } } };
  const tokens = Array.from({ length: 500 }, (_, index) => ({ ...structuredClone(originalToken), id: `token-${index}` }));
  Object.assign(tokens[0], { x: 3050, y: 2600,
    vision: { ...originalToken.vision, preciseRangeOverrideMeters: 1000, vagueRangeOverrideMeters: 1000 } });
  const scene = { id: 'scene', name: 'Scene', mapPackage: { id: 'map', version: '1' }, tokens,
    markers: [{ id: 'keep-marker', x: 20, y: 30 }], attackAreas: [],
    sceneEvents: [{ id: 'audit-damage', type: 'damage', objectIds: ['house'] }],
    featureStates: { door: { open: false }, 'audit-added-override': { open: true } },
    settings: { gridVisible: false, lineOfSightEnabled: true, lighting: 'normal' } };
  const state = { mapId: 'map', mapVersion: '1', markers: structuredClone(scene.markers), attackAreas: [],
    sceneEvents: structuredClone(scene.sceneEvents), preferences: { worldV2: {
      schemaVersion: 4, id: 'world', name: 'World',
      ruleset: { id: infiniteHorrorRuleset.id, version: infiniteHorrorRuleset.version },
      activeSceneId: scene.id, actors: [{ id: 'actor', name: 'Actor', type: 'pc', system: {}, effects: [] }],
      statusDefinitions: [], scenes: [scene], journals: [], templateLibrary: {},
    } } };
  const context = { source: { role: 'gm' }, ruleset: infiniteHorrorRuleset };
  assert.throws(() => applyWorldOperations(state, [{ type: 'scene.settings.patch',
    payload: { sceneId: 'scene', patch: original.scene.settings } }], context), { code: 'scene_setting_forbidden' });
  const before = structuredClone(state), originalBefore = structuredClone(original);
  const serializedRestore = (0, eval)(`(${incrementalEnvironmentRestoreOperations.toString()})`);
  const operations = serializedRestore(original, scene);
  const restored = applyWorldOperations(state, operations, context).state.preferences.worldV2.scenes[0];
  assert.deepEqual(restored.settings, original.scene.settings);
  assert.deepEqual(restored.sceneEvents, original.scene.sceneEvents);
  assert.deepEqual(restored.featureStates, original.scene.featureStates);
  assert.equal(restored.tokens.length, 500);
  assert.deepEqual(restored.tokens.slice(1), tokens.slice(1));
  assert.deepEqual([restored.tokens[0].x, restored.tokens[0].y], [originalToken.x, originalToken.y]);
  assert.deepEqual(restored.tokens[0].vision, originalToken.vision);
  assert.deepEqual(restored.markers, scene.markers);
  assert.deepEqual(state, before);
  assert.deepEqual(original, originalBefore);
});
