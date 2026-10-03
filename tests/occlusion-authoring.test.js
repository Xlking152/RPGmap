import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorldOperations, createWorldOperationPatch, applyWorldOperationPatch, deriveWorldOperations } from '../src/world/operations.js';
import { normalizeWorldV2 } from '../src/world/model.js';
import { assertPersistedWorldV2 } from '../src/world/validation.js';
import { createDocumentChanges, applyDocumentChanges, documentChangeSet } from '../src/documents/changes.js';
import { worldOperationsToDocumentWrites, documentWritesToWorldOperations } from '../src/documents/protocol.js';
import { assertFeatureStatePatch } from '../src/world/feature-states.js';
import { createOcclusionDraft } from '../src/interaction/occlusion-draft.js';
import { availableOcclusionHostIds, exportOcclusionConfiguration, normalizeOcclusionConfiguration } from '../src/world/occlusion-config.js';
import { deriveVisionOccluders } from '../src/spatial/kernel.js';
import { validateSceneOcclusion } from '../src/server/authority.js';

const map = { id: 'map', version: '1', width: 200, height: 200, metersPerUnit: 1,
  features: [{ id: 'house', geometry: { type: 'polygon', points: [[40, 40], [60, 40], [60, 60], [40, 60]] } }] };
const building = { id: 'drawn-house', kind: 'building', points: [[40, 40], [60, 40], [60, 60], [40, 60]],
  featureId: 'house', hostShapeId: null, blockingHeightMeters: null, enabled: true };
const door = { id: 'drawn-door', kind: 'door', points: [[48, 39], [52, 39], [52, 41], [48, 41]],
  featureId: null, hostShapeId: 'drawn-house', blockingHeightMeters: null, enabled: true };
const context = { mapPackage: map, source: { role: 'gm' }, now: '2026-09-30T00:00:00Z' };
const state = () => ({ preferences: { worldV2: { id: 'w', schemaVersion: 2, name: 'World',
  ruleset: { id: 'test', version: '1' }, activeSceneId: 's', actors: [], statusDefinitions: [],
  scenes: [{ id: 's', name: 'Scene', mapPackage: { id: 'map', version: '1' }, tokens: [], markers: [], attackAreas: [],
    sceneEvents: [], featureStates: { house: { open: false, custom: { untouched: true } } }, settings: {}, fog: {} }] } } });
const sceneOf = value => value.preferences.worldV2.scenes[0];
const upsert = shape => ({ type: 'scene.occlusionShape.upsert', payload: { sceneId: 's', shape } });

test('Scene validation checks inherited map doors and respects disabled door overrides', () => {
  const current = sceneOf(state());
  assert.doesNotThrow(() => validateSceneOcclusion(current, { ...map, occlusionShapes: [building, door] }));
  const decorativeHost = { ...map, occlusionShapes: [{ ...door, hostShapeId: 'house' }] };
  assert.throws(() => validateSceneOcclusion(current, decorativeHost), { code: 'invalid_reference' });
  assert.doesNotThrow(() => validateSceneOcclusion({ ...current, occlusionShapes: [
    { ...decorativeHost.occlusionShapes[0], enabled: false },
  ] }, decorativeHost));
});

test('old Worlds gain an empty authored shape collection and malformed shapes fail closed', () => {
  const value = state().preferences.worldV2;
  assert.deepEqual(normalizeWorldV2(value, { mapPackage: map }).scenes[0].occlusionShapes, []);
  const bad = structuredClone(value); bad.scenes[0].occlusionShapes = [{ ...building, points: [[0, 0], [20, 20], [0, 20], [20, 0]] }];
  assert.throws(() => normalizeWorldV2(bad, { mapPackage: map }), /intersect|area/);
  assert.throws(() => assertPersistedWorldV2(bad), /intersect|area/);
});

test('shape writes are immutable and generate addressed public deltas and targeted WAL patches', () => {
  const before = state(), preserved = structuredClone(before);
  const result = applyWorldOperations(before, [upsert(building), upsert(door)], context);
  assert.deepEqual(before, preserved);
  const changes = createDocumentChanges(before, result.state);
  assert.equal(changes.filter(change => change.document.type === 'OcclusionShape').length, 2);
  assert.ok(changes.every(change => !['Token', 'Actor', 'Fog'].includes(change.document.type)));
  assert.ok(documentChangeSet(changes).sceneContent[0].types.includes('OcclusionShape'));
  assert.deepEqual(applyDocumentChanges(before, changes, { updatedAt: context.now }).preferences.worldV2, result.state.preferences.worldV2);
  const patch = createWorldOperationPatch(before, result.state);
  assert.equal(patch.world.scenes.upsert.length, 0);
  assert.equal(patch.world.scenes.occlusionShapes[0].upsert.length, 2);
  assert.deepEqual(applyWorldOperationPatch(before, patch).preferences.worldV2, result.state.preferences.worldV2);
  assert.equal(deriveWorldOperations(before, result.state).operations.filter(operation => operation.type === 'scene.occlusionShape.upsert').length, 2);
});

test('shape authority rejects Player, unknown Feature, duplicate bindings and out-of-map coordinates', () => {
  assert.throws(() => applyWorldOperations(state(), [upsert(building)], { ...context, source: { role: 'player' } }), { code: 'permission_denied' });
  assert.throws(() => applyWorldOperations(state(), [upsert({ ...building, featureId: 'missing' })], context), { code: 'invalid_reference' });
  assert.throws(() => applyWorldOperations(state(), [upsert(building), upsert({ ...building, id: 'duplicate' })], context), /Multiple/);
  assert.throws(() => applyWorldOperations(state(), [upsert({ ...building, points: [[-1, 0], [2, 0], [2, 2]] })], context), { code: 'occlusion_shape_out_of_bounds' });
  assert.throws(() => applyWorldOperations(state(), [upsert({ ...door, hostShapeId: null })], context), { code: 'invalid_reference' });
  const draft = createOcclusionDraft(map, sceneOf(state()));
  assert.throws(() => draft.upsertShape({ ...door, hostShapeId: null }), { code: 'invalid_reference' });
  assert.equal(draft.dirty, false);
});

test('authored doors require a real building or wall blocker, including for Map Feature hosts', () => {
  const hostMap = { ...map, features: [
    { id: 'wall-feature', category: 'building', geometry: { points: [[40, 40], [60, 40], [60, 60], [40, 60]] },
      capabilities: { vision: { occluder: true } } },
    { id: 'decoration', category: 'generic', geometry: { points: [[70, 40], [80, 40], [80, 60], [70, 60]] }, capabilities: {} },
    { id: 'gate-feature', category: 'door', geometry: { points: [[85, 40], [95, 40], [95, 60], [85, 60]] },
      capabilities: { openable: true, vision: { occluder: true } } },
  ] };
  const base = state(), current = sceneOf(base);
  const withHost = { ...door, hostShapeId: 'wall-feature' };
  const authored = { ...context, mapPackage: hostMap };
  assert.ok(availableOcclusionHostIds(hostMap, current).has('wall-feature'));
  assert.equal(availableOcclusionHostIds(hostMap, current).has('decoration'), false);
  assert.equal(availableOcclusionHostIds(hostMap, current).has('gate-feature'), false);
  assert.equal(sceneOf(applyWorldOperations(base, [upsert(withHost)], authored).state).occlusionShapes.length, 1);
  for (const hostShapeId of ['decoration', 'gate-feature']) {
    assert.throws(() => applyWorldOperations(base, [upsert({ ...door, hostShapeId })], authored),
      { code: 'invalid_reference' });
    const configuration = exportOcclusionConfiguration(hostMap, current);
    configuration.occlusionShapes = [{ ...door, hostShapeId }];
    assert.throws(() => normalizeOcclusionConfiguration(configuration, hostMap, current),
      { code: 'invalid_reference' });
  }
  const taggedScene = { ...current, featureStates: { decoration: { vision: { occluder: true } } },
    occlusionShapes: [{ ...door, hostShapeId: 'decoration' }] };
  assert.doesNotThrow(() => validateSceneOcclusion(taggedScene, hostMap));
  const taggedConfig = exportOcclusionConfiguration(hostMap, taggedScene);
  assert.doesNotThrow(() => normalizeOcclusionConfiguration(taggedConfig, hostMap, taggedScene));
  const disabled = { ...building, featureId: null, enabled: false };
  const disabledHost = { ...door, hostShapeId: disabled.id };
  const configuration = exportOcclusionConfiguration(hostMap, current);
  configuration.occlusionShapes = [disabled, disabledHost];
  assert.throws(() => normalizeOcclusionConfiguration(configuration, hostMap, current), { code: 'invalid_reference' });
  const boundDoor = { ...door, id: 'bound-door', featureId: 'wall-feature', hostShapeId: disabled.id };
  assert.equal(availableOcclusionHostIds(hostMap, current, { occlusionShapes: [
    { ...disabled, enabled: true }, boundDoor,
  ] }).has('wall-feature'), false, 'a door binding must replace the Feature blocker');
});

test('World operations resolve each addressed Scene Map, including after activation in one batch', () => {
  const small = { ...map, id: 'small-map', width: 100, height: 100, metersPerUnit: 1 };
  const large = { ...map, id: 'large-map', width: 300, height: 300, metersPerUnit: 2 };
  const before = state(), world = before.preferences.worldV2;
  const smallScene = sceneOf(before);
  smallScene.mapPackage = { id: small.id, version: small.version };
  const largeScene = { ...structuredClone(smallScene), id: 'large-scene',
    mapPackage: { id: large.id, version: large.version },
    tokens: [{ id: 'large-token', actorId: 'actor', placement: 'map', x: 50, y: 50, elevationMeters: 0 }] };
  world.scenes.push(largeScene);
  world.actors.push({ id: 'actor', name: 'Scout', type: 'pc', partyId: 'party', effects: [] });
  const perScene = { ...context, mapMetrics: small, mapPackage: small,
    mapForScene: scene => scene?.id === smallScene.id ? small : scene?.id === largeScene.id ? large : null,
    validateTokenMovePath: () => ({ valid: true }) };
  const move = { type: 'token.reposition', payload: { sceneId: largeScene.id, tokenId: 'large-token', x: 250, y: 250 } };
  const moved = applyWorldOperations(before, [move], perScene).state;
  assert.equal(moved.preferences.worldV2.scenes[1].tokens[0].x, 250);
  const configuration = exportOcclusionConfiguration(large, largeScene);
  configuration.occlusionShapes = [{ id: 'large-wall', kind: 'wall',
    points: [[240, 240], [260, 240], [260, 245], [240, 245]] }];
  const configured = applyWorldOperations(before, [{ type: 'scene.occlusion.configure', payload: {
    sceneId: largeScene.id, configuration,
  } }], perScene).state;
  assert.equal(configured.preferences.worldV2.scenes[1].occlusionShapes[0].id, 'large-wall');
  const activated = applyWorldOperations(before, [
    { type: 'scene.activate', payload: { sceneId: largeScene.id } },
    { type: 'token.reposition', payload: { tokenId: 'large-token', x: 275, y: 250 } },
  ], perScene).state;
  assert.equal(activated.preferences.worldV2.scenes[1].tokens[0].x, 275);
  assert.equal(before.preferences.worldV2.scenes[1].tokens[0].x, 50,
    'an activation followed by an unaddressed edit must not mutate the input World');
  const tooSmall = { type: 'token.reposition', payload: { sceneId: smallScene.id, tokenId: 'small-token', x: 150, y: 50 } };
  const withSmallToken = structuredClone(before);
  withSmallToken.preferences.worldV2.scenes[0].tokens.push({ id: 'small-token', actorId: 'actor', placement: 'map', x: 50, y: 50 });
  withSmallToken.preferences.worldV2.activeSceneId = largeScene.id;
  assert.throws(() => applyWorldOperations(withSmallToken, [tooSmall], perScene), { code: 'movement_out_of_bounds' });
  assert.throws(() => applyWorldOperations(before, [move], { ...perScene, mapForScene: () => null }),
    { code: 'map_package_not_found' });
});

test('an authored blocker remains a valid door host while its Scene tag or destruction temporarily disables it', () => {
  const base = applyWorldOperations(state(), [upsert(building), upsert(door)], context).state;
  const current = sceneOf(base);
  current.featureStates.house.vision = { occluder: false };
  const configuration = exportOcclusionConfiguration(map, current);
  assert.ok(availableOcclusionHostIds(map, current, configuration).has(building.id));
  assert.doesNotThrow(() => normalizeOcclusionConfiguration(configuration, map, current));
  assert.doesNotThrow(() => deriveVisionOccluders(map, current, { destroyedObjectIds: ['house'] }));
  current.featureStates.house.vision = { occluder: true };
  assert.ok(deriveVisionOccluders(map, current).some(item => item.kind === 'building'));
});

test('Feature vision overrides retain RFC Merge Patch inheritance and explicit unbounded heights', () => {
  const operation = patch => ({ type: 'scene.featureState.patch', payload: { sceneId: 's', featureId: 'house', patch } });
  let value = applyWorldOperations(state(), [operation({ vision: { occluder: true, blockingHeightMeters: 'unbounded' } })], context).state;
  assert.deepEqual(sceneOf(value).featureStates.house.vision, { occluder: true, blockingHeightMeters: 'unbounded' });
  value = applyWorldOperations(value, [operation({ vision: { occluder: null } })], context).state;
  assert.deepEqual(sceneOf(value).featureStates.house.vision, { blockingHeightMeters: 'unbounded' });
  value = applyWorldOperations(value, [operation({ vision: null })], context).state;
  assert.deepEqual(sceneOf(value).featureStates.house, { open: false, custom: { untouched: true } });
  for (const vision of [{ occluder: 'true' }, { blockingHeightMeters: -1 }, { blockingHeightMeters: Infinity }, { unrelated: true }]) {
    assert.throws(() => assertFeatureStatePatch({ vision }));
  }
});

test('drawn door uses existing authoritative door interaction without touching author configuration', () => {
  const before = applyWorldOperations(state(), [upsert(building), upsert(door)], context).state;
  const config = exportOcclusionConfiguration(map, sceneOf(before));
  const opened = applyWorldOperations(before, [{ type: 'scene.door.use', payload: { sceneId: 's', featureId: door.id, action: 'open' } }], context).state;
  assert.equal(sceneOf(opened).featureStates[door.id].open, true);
  assert.deepEqual(exportOcclusionConfiguration(map, sceneOf(opened)), config);
});

test('a map-coordinate Player inside the host building can use its nearby door, but another wall still blocks interaction', () => {
  let before = applyWorldOperations(state(), [upsert(building), upsert(door)], context).state;
  sceneOf(before).tokens = [{ id: 'player-token', actorId: 'a', placement: 'map', x: 50, y: 42,
    elevationMeters: 0, diameterMeters: 1 }];
  const operation = { type: 'scene.door.use', payload: { sceneId: 's', featureId: door.id, tokenId: 'player-token', action: 'open' } };
  const playerContext = { ...context, source: { role: 'player' } };
  assert.equal(sceneOf(applyWorldOperations(before, [operation], playerContext).state).featureStates[door.id].open, true);
  before = applyWorldOperations(before, [upsert({ id: 'other-wall', kind: 'wall',
    points: [[49, 41.5], [51, 41.5], [51, 41.7], [49, 41.7]] })], context).state;
  assert.throws(() => applyWorldOperations(before, [operation], playerContext), { code: 'door_line_of_sight_blocked' });
});

test('configuration import is one atomic operation and preserves runtime data and unrelated Feature fields', () => {
  const before = state(); sceneOf(before).featureStates.house.vision = { occluder: false };
  sceneOf(before).featureStates[door.id] = { open: true };
  const config = exportOcclusionConfiguration(map, sceneOf(before));
  config.occlusionShapes = [building, door]; config.featureVision.house = { occluder: true, blockingHeightMeters: 15 };
  const operation = { type: 'scene.occlusion.configure', payload: { sceneId: 's', configuration: config } };
  const writes = worldOperationsToDocumentWrites([operation], { worldId: 'w', sceneId: 's' });
  assert.deepEqual(documentWritesToWorldOperations(writes), [operation]);
  const after = applyWorldOperations(before, [operation], context).state;
  assert.equal(sceneOf(after).featureStates[door.id].open, true);
  assert.deepEqual(sceneOf(after).featureStates.house.custom, { untouched: true });
  assert.deepEqual(after.preferences.featureStates, sceneOf(after).featureStates);
  assert.deepEqual(sceneOf(after).fog, sceneOf(before).fog);
  assert.deepEqual(sceneOf(after).tokens, sceneOf(before).tokens);
});

test('configuration files reject different map metadata and unrelated private World data', () => {
  const config = exportOcclusionConfiguration(map, sceneOf(state()));
  for (const field of ['id', 'version', 'metersPerUnit', 'width', 'height']) {
    const bad = structuredClone(config); bad.map[field] = typeof bad.map[field] === 'number' ? 1234 : 'other';
    assert.throws(() => normalizeOcclusionConfiguration(bad, map, sceneOf(state())), { code: 'occlusion_map_mismatch' });
  }
  for (const field of ['fog', 'tokens', 'sceneEvents']) assert.throws(() => normalizeOcclusionConfiguration({ ...config, [field]: [] }, map, sceneOf(state())));
});

test('draft undo, redo, import and preview are local; stale author commits reject while door changes remain compatible', () => {
  const before = applyWorldOperations(state(), [upsert(building), upsert(door)], context).state;
  const draft = createOcclusionDraft(map, sceneOf(before));
  draft.selectFeatures(['house']); draft.setFeatureVision(draft.selectedFeatureIds, { occluder: false });
  assert.equal(draft.dirty, true); assert.equal(draft.previewScene(sceneOf(before)).featureStates.house.vision.occluder, false);
  assert.equal(sceneOf(before).featureStates.house.vision, undefined);
  draft.undo(); assert.equal(draft.dirty, false); draft.redo(); assert.equal(draft.dirty, true);
  const runtimeChanged = applyWorldOperations(before, [{ type: 'scene.door.use', payload: { sceneId: 's', featureId: door.id, action: 'open' } }], context).state;
  const committed = applyWorldOperations(runtimeChanged, draft.commitOperations(), context).state;
  assert.equal(sceneOf(committed).featureStates[door.id].open, true);
  const authorChanged = applyWorldOperations(before, [upsert({ ...building, blockingHeightMeters: 30 })], context).state;
  assert.throws(() => applyWorldOperations(authorChanged, draft.commitOperations(), context), { code: 'occlusion_configuration_conflict' });
  draft.markCommitted(sceneOf(committed)); assert.equal(draft.dirty, false);
  draft.resetDefaults(); assert.equal(draft.configuration.occlusionShapes.length, 0); draft.undo(); assert.equal(draft.configuration.occlusionShapes.length, 2);
});

test('deleting a host cascades its drawn doors and deleting map defaults creates disabled overrides', () => {
  const before = applyWorldOperations(state(), [upsert(building), upsert(door)], context).state;
  const after = applyWorldOperations(before, [{ type: 'scene.occlusionShape.delete', payload: { sceneId: 's', shapeId: building.id } }], context).state;
  assert.deepEqual(sceneOf(after).occlusionShapes, []);
  const withDefaults = { ...map, occlusionShapes: [building, door] };
  const draft = createOcclusionDraft(withDefaults, sceneOf(state()));
  draft.deleteShape(building.id);
  assert.deepEqual(draft.configuration.occlusionShapes.map(shape => shape.enabled), [false, false]);
  const applied = applyWorldOperations(state(), draft.commitOperations(), { ...context, mapPackage: withDefaults }).state;
  assert.equal(sceneOf(applied).occlusionShapes.length, 2);
});

test('configuration exports map defaults with Scene edits and restoring defaults stays clean after commit', () => {
  const withDefaults = { ...map, occlusionShapes: [building, door] };
  const current = sceneOf(state());
  current.occlusionShapes = [{ ...building, enabled: false }, { ...door, enabled: false }];
  current.featureStates = { house: { vision: { occluder: false }, open: true, destroyed: true } };
  const untouched = exportOcclusionConfiguration(withDefaults, sceneOf(state()));
  assert.deepEqual(untouched.occlusionShapes, [building, door]);
  const exported = exportOcclusionConfiguration(withDefaults, current);
  assert.deepEqual(exported.occlusionShapes.map(shape => shape.enabled), [false, false]);
  assert.deepEqual(exported.featureVision, { house: { occluder: false } });
  assert.equal(JSON.stringify(exported).includes('exploredByParty'), false);
  const draft = createOcclusionDraft(withDefaults, current);
  draft.resetDefaults();
  assert.deepEqual(draft.configuration.occlusionShapes, [building, door]);
  const before = state(); before.preferences.worldV2.scenes[0] = current;
  const applied = applyWorldOperations(before, draft.commitOperations(), { ...context, mapPackage: withDefaults }).state;
  draft.markCommitted(sceneOf(applied));
  assert.equal(draft.dirty, false);
});
