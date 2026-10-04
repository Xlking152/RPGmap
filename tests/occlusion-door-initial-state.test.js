import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFeatureOpen } from '../src/world/feature-states.js';
import { getFeatureState } from '../src/interaction/feature-state.js';
import { featureControlAction } from '../src/interaction/control-model.js';
import { validateDoorInteraction } from '../src/interaction/door-authority.js';
import { deriveVisionOccluders, inspectLineOfSight } from '../src/spatial/kernel.js';
import { applyWorldOperations } from '../src/world/operations.js';
import { exportOcclusionConfiguration, featureForOcclusionDoor } from '../src/world/occlusion-config.js';

const rectangle = (left, top, right, bottom) => [[left, top], [right, top], [right, bottom], [left, bottom]];
function fixture(featureDefaults, sceneOverride) {
  const gate = { id: 'gate', category: 'door', geometry: { type: 'polygon', points: rectangle(39, 48, 61, 52) },
    capabilities: { openable: true, vision: { occluder: true, passableWhenOpen: true } }, ...featureDefaults };
  const map = { id: 'door-map', version: '1', width: 100, height: 100, metersPerUnit: 1, features: [gate] };
  const scene = { id: 'scene', mapPackage: { id: map.id, version: map.version }, tokens: [], markers: [], attackAreas: [],
    sceneEvents: [], settings: {}, fog: {}, featureStates: { gate: { custom: { keep: true }, ...sceneOverride } },
    occlusionShapes: [
      { id: 'host', kind: 'wall', points: rectangle(40, 10, 60, 90) },
      { id: 'outline', kind: 'door', featureId: 'gate', hostShapeId: 'host', points: gate.geometry.points },
    ] };
  const state = { preferences: { worldV2: { id: 'world', schemaVersion: 4, name: 'World', ruleset: { id: 'test', version: '1' },
    activeSceneId: scene.id, scenes: [scene], actors: [], statusDefinitions: [] } } };
  return { gate, map, scene, state };
}

test('door initial state has one Scene-first precedence across controls, LOS and authority', () => {
  const cases = [
    [{}, undefined, false],
    [{ interaction: { initialState: { open: true } } }, undefined, true],
    [{ interaction: { initialOpen: true } }, undefined, true],
    [{ initialOpen: true }, undefined, true],
    [{ interaction: { initialState: { open: false }, initialOpen: true }, initialOpen: true }, undefined, false],
    [{ interaction: { initialState: { open: null }, initialOpen: true } }, undefined, true],
    [{ interaction: { initialOpen: false }, initialOpen: true }, undefined, false],
    [{ interaction: { initialState: { open: true } } }, { open: false }, false],
    [{ interaction: { initialState: { open: false } } }, { open: true }, true],
    [{ initialOpen: true }, { open: null }, true],
  ];
  for (const [defaults, override, expectedOpen] of cases) {
    const { gate, map, scene, state } = fixture(defaults, override);
    const drawnDoor = featureForOcclusionDoor(map, scene, gate.id);
    assert.equal(effectiveFeatureOpen(scene.featureStates.gate, drawnDoor), expectedOpen);
    assert.equal(getFeatureState(state, drawnDoor).open, expectedOpen);
    const action = featureControlAction(getFeatureState(state, drawnDoor));
    assert.equal(action, expectedOpen ? 'close' : 'open');
    const occluders = deriveVisionOccluders(map, scene);
    assert.equal(inspectLineOfSight({ from: { x: 0, y: 50 }, to: { x: 80, y: 50 }, occluders }).clear, expectedOpen);
    assert.equal(validateDoorInteraction({ scene, feature: drawnDoor, mapPackage: map, action, source: { role: 'gm' } }).valid, true);
    assert.equal(validateDoorInteraction({ scene, feature: drawnDoor, mapPackage: map,
      action: expectedOpen ? 'open' : 'close', source: { role: 'gm' } }).code, 'door_state_conflict');
    const before = structuredClone(state), config = exportOcclusionConfiguration(map, scene);
    const applied = applyWorldOperations(state, [{ type: 'scene.door.use', payload: {
      sceneId: scene.id, featureId: gate.id, action,
    } }], { mapPackage: map, source: { role: 'gm' } });
    const nextScene = applied.state.preferences.worldV2.scenes[0];
    assert.equal(nextScene.featureStates.gate.open, !expectedOpen);
    assert.equal(nextScene.featureStates.gate.custom.keep, true);
    assert.equal(getFeatureState(applied.state, drawnDoor).open, !expectedOpen);
    assert.deepEqual(exportOcclusionConfiguration(map, nextScene), config);
    assert.deepEqual(state, before);
  }
});

test('door open resolution leaves transparent tags and independent host geometry unchanged', () => {
  const { map, scene } = fixture({ interaction: { initialState: { open: true } } },
    { open: false, vision: { occluder: false } });
  const occluders = deriveVisionOccluders(map, scene);
  assert.equal(effectiveFeatureOpen(scene.featureStates.gate, map.features[0]), false);
  assert.equal(occluders.some(item => item.id === 'gate'), false);
  assert.equal(inspectLineOfSight({ from: { x: 0, y: 50 }, to: { x: 80, y: 50 }, occluders }).clear, true);
  assert.equal(inspectLineOfSight({ from: { x: 0, y: 30 }, to: { x: 80, y: 30 }, occluders }).clear, false);
});
