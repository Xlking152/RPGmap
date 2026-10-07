import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialRuntimeState, validateRuntimeState, exportRuntimeState, stringifyTrustedRuntimeState } from '../src/engine/runtime-state.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { applyWorldOperations } from '../src/world/operations.js';
import { createDocumentChanges, applyDocumentChanges } from '../src/documents/changes.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const mapPackage = { id: 'test-map', version: '1.0.0', width: 100, height: 100, metersPerUnit: 1, features: [] };
const ruleset = infiniteHorrorRuleset;

function stateWithToken() {
  const seed = createInitialRuntimeState(mapPackage, { ruleset });
  seed.preferences.entitySystem.actors = [{ id: 'actor-1', name: '角色', currentFormId: 'form-1',
    forms: [{ id: 'form-1', tokenAppearance: { color: '#3d9b63' }, avatarDataUrl: null }], runtime: {}, effects: [] }];
  seed.preferences.entitySystem.tokens = [{ id: 'token-1', actorId: 'actor-1', placement: 'map',
    x: 1.5, y: 2.5, diameterMeters: 1, rotation: 0, elevationMeters: 0,
    hidden: false, locked: false, showName: true, effects: [] }];
  const world = createWorldV2FromRuntimeState(seed, { mapPackage, ruleset });
  return validateRuntimeState(projectWorldV2ToRuntimeState(seed, world, { mapPackage, ruleset }), { mapPackage, ruleset });
}

test('trusted World document commits save the same bytes as full validation', () => {
  let state = stateWithToken();
  const sceneId = state.preferences.worldV2.activeSceneId;
  const operations = [
    { type: 'token.create', payload: { sceneId, token: {
      ...state.preferences.worldV2.scenes[0].tokens[0], id: 'token-2', x: 4, y: 5,
    } } },
    { type: 'token.movePath', payload: { sceneId, tokenId: 'token-1', tokenIds: ['token-1'],
      waypoints: [{ x: 20, y: 30 }], method: 'drag',
      expectedOrigins: { 'token-1': { x: 1.5, y: 2.5, elevationMeters: 0 } },
    } },
    { type: 'scene.fog.explore', payload: { sceneId, partyId: 'party', x: 20, y: 30, radiusMeters: 12 } },
    { type: 'token.move', payload: { sceneId, tokenId: 'token-1', x: 22, y: 31 } },
    { type: 'token.reposition', payload: { sceneId, tokenId: 'token-1', x: 25, y: 33, elevationMeters: 3 } },
  ];
  for (const operation of operations) {
    const applied = applyWorldOperations(state, [operation], { ruleset, mapMetrics: mapPackage, source: { role: 'offline' } });
    state = applyDocumentChanges(state, createDocumentChanges(state, applied.state), {
      updatedAt: applied.state.preferences.worldV2.updatedAt,
    });
    assert.equal(stringifyTrustedRuntimeState(state, { mapPackage }),
      JSON.stringify(exportRuntimeState(state, { mapPackage, ruleset })));
  }
  assert.throws(() => stringifyTrustedRuntimeState(state, { mapPackage: { ...mapPackage, id: 'wrong-map' } }), /MapPackage/);
});

test('full save validation detaches canonical documents and runtime extensions after omitting redundant copies', () => {
  const state = stateWithToken();
  state.extension = { values: [1, 2] };
  state.preferences.extension = { values: [3, 4] };
  state.preferences.worldV2.extension = { values: [5, 6] };
  const before = JSON.stringify(state);
  const exported = exportRuntimeState(state, { mapPackage, ruleset });
  assert.equal(JSON.stringify(state), before, 'validation must not rewrite its input');
  exported.extension.values.push(7);
  exported.preferences.extension.values.push(8);
  exported.preferences.worldV2.extension.values.push(9);
  exported.preferences.worldV2.actors[0].name = 'changed';
  exported.preferences.worldV2.scenes[0].tokens[0].x = 90;
  assert.equal(JSON.stringify(state), before, 'public output must not alias private canonical or extension data');
});

test('full validation still rejects malformed destruction history and cannot defer it to trusted serialization', () => {
  const state = stateWithToken();
  const scene = state.preferences.worldV2.scenes[0];
  scene.sceneEvents = [{ id: 'invalid-damage', type: 'damage', objectIds: [], clipHits: [],
    craterPolygon: [[NaN, 5], [10, 5], [10, 10]], craterEnabled: true }];
  const original = structuredClone(state);
  assert.throws(() => exportRuntimeState(state, { mapPackage, ruleset }));
  assert.deepEqual(state, original);
});
