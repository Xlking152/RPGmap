import test from 'node:test';
import assert from 'node:assert/strict';
import clipping from 'polygon-clipping';
import { applyWorldOperations, projectWorldOperationState } from '../src/world/operations.js';
import { deriveVisionOccluders, inspectLineOfSight, occlusionGeometryCacheStats } from '../src/spatial/kernel.js';
import { deriveSceneState } from '../src/engine/state.js';
import { createFeatureOperations } from '../src/interaction/operations.js';
import { featureStatusMutations } from '../src/interaction/status-rules.js';
import { reduceStatusOperation } from '../src/status/model.js';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { worldOperationsToDocumentWrites, documentWritesToWorldOperations } from '../src/documents/protocol.js';

const ring = [[0, 0], [100, 0], [100, 100], [0, 100]];
const map = () => ({ id: 'map', version: '1', metersPerUnit: 1, features: [{ id: 'wall', category: 'wall',
  geometry: { points: ring }, capabilities: { vision: { occluder: true, polygon: ring } } }] });
const event = id => ({ id, type: 'damage', objectIds: [], clipHits: [{ featureId: 'wall', polygon: [[0, 0], [10, 0], [10, 100], [0, 100]] }] });
function initial(events = []) {
  return { markers: [], attackAreas: [], sceneEvents: structuredClone(events), preferences: {
    worldV2: { schemaVersion: 4, id: 'world', name: 'World', ruleset: { id: 'test', version: '1' },
      activeSceneId: 'scene', actors: [], statusDefinitions: [], scenes: [{ id: 'scene', name: 'Scene',
        mapPackage: { id: 'map', version: '1' }, markers: [], attackAreas: [], tokens: [], sceneEvents: structuredClone(events),
        featureStates: {}, occlusionShapes: [], settings: {} }] },
    entitySystem: { schemaVersion: 4, actors: [], tokens: [], statusDefinitions: [] },
  } };
}

test('new damage is rejected atomically even after legacy conservative geometry was cached', () => {
  const packageMap = map(), state = initial([event('old')]);
  const before = structuredClone(state);
  const original = clipping.difference;
  clipping.difference = () => { throw new Error('Unable to pop() left SweepEvent injected from queue.'); };
  try {
    assert.equal(deriveVisionOccluders(packageMap, state.preferences.worldV2.scenes[0], deriveSceneState(state.sceneEvents)).length, 1);
    assert.equal(occlusionGeometryCacheStats(packageMap).failures, 1, 'legacy warming must actually cache the failed damaged geometry');
    for (const type of ['damage', 'DAMAGE', 'Damage']) {
      assert.throws(() => applyWorldOperations(state, [{ type: 'scene.content.replace', payload: {
        sceneId: 'scene', sceneEvents: [...state.sceneEvents, { ...event('new'), type }],
      } }], { mapPackage: packageMap, source: { role: 'gm' } }), error => error.code === 'geometry_clip_failed' && error.featureId === 'wall');
    }
    assert.deepEqual(state, before);
  } finally { clipping.difference = original; }
});

const rect = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
const statusDefinitions = [
  { id: 'ruins-shock', name: 'Shock', description: '', icon: 'shield', color: '#885533', category: 'debuff',
    scopes: ['actor'], maxStacks: 3, changes: [], capabilities: {}, persisted: true },
  { id: 'ruins-dust', name: 'Dust', description: '', icon: 'cloud', color: '#665544', category: 'debuff',
    scopes: ['token'], maxStacks: 3, changes: [], capabilities: {}, persisted: true },
];
const featureRules = {
  damage: { onSuccess: { apply: [{ statusId: 'ruins-shock', scope: 'actor' }, { statusId: 'ruins-dust', scope: 'token' }] } },
  restore: { onSuccess: { remove: [{ statusId: 'ruins-shock', scope: 'actor' }, { statusId: 'ruins-dust', scope: 'token' }] } },
};

function authorityFixture({ synthetic = false, statuses = false, door = false, events = null, failStatus = false } = {}) {
  const object = (id, points, category = 'building') => ({ id, name: id, category,
    geometry: { type: 'polygon', points }, capabilities: { destructible: true,
      actions: { damage: true, restore: true },
      vision: { occluder: true, polygon: points, blockingHeightMeters: 6, passableWhenDestroyed: true },
      navigation: { blocks: true, blockingPolygon: points, collisionGroup: 'structure', passableWhenDestroyed: true },
      ...(statuses && id === 'house' ? { statusRules: featureRules } : {}) } });
  const features = [object('house', rect(40, 20, 20, 60)), object('other-wall', rect(140, 20, 20, 60), 'wall')];
  if (door) features.push({ ...object('door', rect(39, 40, 22, 20), 'gate'), capabilities: {
    ...object('door', rect(39, 40, 22, 20), 'gate').capabilities, openable: true,
    ...(statuses ? { statusRules: featureRules } : {}),
  } });
  const mapPackage = prepareMapPackage({ id: 'authority-map', version: '1', width: 300, height: 200, metersPerUnit: 1,
    layers: ['structure'], svg: '<svg><g data-layer="structure" /></svg>', features,
    ...(door ? { occlusionShapes: [{ id: 'door-outline', kind: 'door', featureId: 'door', hostShapeId: 'house',
      points: rect(39, 40, 22, 20), blockingHeightMeters: 6 }] } : {}) });
  const history = events || [
    { id: 'partial-house', type: 'damage', objectIds: [], clipHits: [{ featureId: 'house', polygon: rect(40, 20, 2, 60) }] },
    { id: 'severe-house', type: 'damage', objectIds: [], clipHits: [{ featureId: 'house', polygon: rect(58, 20, 2, 60) }],
      areaSnapshot: { severeDamage: true }, craterPolygon: rect(35, 45, 15, 15) },
    { id: 'partial-other', type: 'damage', objectIds: [], clipHits: [{ featureId: 'other-wall', polygon: rect(140, 20, 2, 60) }] },
  ];
  const actor = { id: 'actor', name: 'Shared template', type: 'pc', system: {}, effects: [], notes: '' };
  const token = { id: 'token', actorId: actor.id, actorLink: !synthetic, actorDelta: synthetic ? { effects: [] } : null,
    placement: 'map', x: 10, y: 50, elevationMeters: 0, diameterMeters: 1, rotation: 0, effects: [] };
  const otherToken = { ...structuredClone(token), id: 'other-token', actorLink: false,
    actorDelta: { effects: [], notes: 'independent sibling' }, x: 12 };
  const featureStates = { house: { open: true, vision: { occluder: true, blockingHeightMeters: 7 }, custom: { note: 'keep this' } },
    'other-wall': { open: false, vision: { occluder: true, blockingHeightMeters: 9 } }, ...(door ? { door: { open: false } } : {}) };
  let state = projectWorldOperationState({ preferences: { worldV2: { schemaVersion: 4, id: 'authority-world', name: 'World',
    ruleset: { id: 'test', version: '1' }, activeSceneId: 'scene', actors: [actor], statusDefinitions: structuredClone(statusDefinitions),
    scenes: [{ id: 'scene', name: 'Scene', mapPackage: { id: mapPackage.id, version: mapPackage.version },
      tokens: [token, otherToken], markers: [], attackAreas: [], sceneEvents: structuredClone(history),
      featureStates: structuredClone(featureStates), occlusionShapes: [], settings: { lineOfSightEnabled: true } }] } } });
  const commits = [], emitted = [];
  let statusCalls = 0, legacyWrites = 0;
  const operations = createFeatureOperations({ mapPackage, getState: () => state,
    replaceState() { legacyWrites++; throw new Error('Legacy replaceState must never commit World-backed damage or restoration'); },
    performOperations(batch, metadata) {
      const applied = applyWorldOperations(state, batch, { mapPackage, source: { role: 'gm' },
        applyStatus(value, message) {
          statusCalls++;
          if (failStatus) throw new Error('Injected authoritative status failure');
          const reduced = reduceStatusOperation(value.preferences.entitySystem, message);
          return { state: { ...value, preferences: { ...value.preferences, entitySystem: reduced.state } }, results: reduced.results };
        } });
      state = applied.state;
      commits.push({ batch: structuredClone(batch), metadata, results: applied.results });
      return applied;
    },
    getStatusDefinitions: () => state.preferences.worldV2.statusDefinitions,
    resolveStatus: () => ({ statuses: [], capabilities: { canInteract: true } }),
    emit: (name, detail) => emitted.push({ name, detail }),
  });
  return { mapPackage, operations, commits, emitted, getState: () => state,
    getStatusCalls: () => statusCalls, getLegacyWrites: () => legacyWrites };
}

function houseRay(fixture) {
  const scene = fixture.getState().preferences.worldV2.scenes[0];
  return inspectLineOfSight({ from: { x: 10, y: 50 }, to: { x: 90, y: 50 },
    occluders: deriveVisionOccluders(fixture.mapPackage, scene, deriveSceneState(scene.sceneEvents)) }).clear;
}

test('damage and restore without status side effects do not read unused status definitions', async () => {
  const mapPackage = map();
  mapPackage.features[0].capabilities.destructible = true;
  let state = initial(), definitionReads = 0;
  const operations = createFeatureOperations({ mapPackage, getState: () => state,
    replaceState() { throw new Error('authority required'); },
    getStatusDefinitions() { definitionReads++; throw new Error('unused definition lookup'); },
    performOperations(batch) {
      const applied = applyWorldOperations(state, batch, { mapPackage, source: { role: 'gm' } });
      state = applied.state;
      return applied;
    },
  });
  assert.equal((await operations.damage('wall')).ok, true);
  assert.equal((await operations.restore('wall')).ok, true);
  assert.equal(definitionReads, 0);
});

test('whole-damage and restore buttons commit real canonical World history after partial and severe damage', async () => {
  const fixture = authorityFixture(), originalState = fixture.getState(), before = structuredClone(originalState);
  const originalScene = before.preferences.worldV2.scenes[0];
  const beforeDerived = deriveSceneState(originalScene.sceneEvents);
  assert.equal(houseRay(fixture), false);
  const damage = await fixture.operations.damage('house');
  assert.equal(damage.ok, true);
  const damaged = fixture.getState(), damagedScene = damaged.preferences.worldV2.scenes[0];
  assert.equal(damagedScene.sceneEvents.length, originalScene.sceneEvents.length + 1);
  assert.deepEqual(damagedScene.sceneEvents.at(-1), damage.event);
  assert.deepEqual(damage.event.objectIds, ['house']);
  assert.deepEqual(damage.event.clipHits, []);
  assert.deepEqual(damaged.sceneEvents, damagedScene.sceneEvents, 'legacy view must reflect the authoritative Scene');
  assert.equal(fixture.operations.stateForFeature('house').destroyed, true);
  assert.equal(houseRay(fixture), true, 'whole destruction must remove the original blocker');
  assert.equal(fixture.commits.length, 1);
  assert.equal(fixture.commits[0].batch[0].type, 'scene.content.replace');
  assert.equal(fixture.commits[0].metadata.source, 'feature:damage');
  assert.deepEqual(damagedScene.featureStates, originalScene.featureStates);

  const restore = await fixture.operations.restore('house');
  assert.equal(restore.ok, true);
  const restored = fixture.getState(), restoredScene = restored.preferences.worldV2.scenes[0];
  const restoredDerived = deriveSceneState(restoredScene.sceneEvents);
  assert.deepEqual(restoredScene.sceneEvents.at(-1), restore.event);
  assert.deepEqual(restore.event.featureIds, ['house']);
  assert.equal(fixture.operations.stateForFeature('house').damaged, false);
  assert.equal(houseRay(fixture), false, 'restoration must rebuild the intact blocker');
  assert.deepEqual(restoredDerived.clipHits, beforeDerived.clipHits.filter(hit => hit.featureId !== 'house'));
  assert.deepEqual(restoredDerived.craterRegions, beforeDerived.craterRegions, 'independent severe crater must survive restoration');
  assert.equal(fixture.operations.stateForFeature('other-wall').damaged, true);
  assert.deepEqual(restoredScene.featureStates, originalScene.featureStates, 'Tag, height, custom settings and open state must survive');
  assert.deepEqual(restored.sceneEvents, restoredScene.sceneEvents);
  assert.equal(fixture.commits.length, 2);
  assert.equal(fixture.commits[1].batch[0].type, 'scene.content.replace');
  assert.equal(fixture.commits[1].metadata.source, 'feature:restore');
  assert.equal(fixture.getLegacyWrites(), 0);
  assert.deepEqual(originalState, before, 'World transactions must not mutate their original input');
  assert.deepEqual(fixture.emitted.map(item => item.name), ['scene:damage', 'scene:restore']);
});

test('button preflight failures return ok:false without committing a damage event or any status effects', async () => {
  const fixture = authorityFixture({ statuses: true, door: true, events: [] });
  const before = structuredClone(fixture.getState());
  const original = clipping.difference;
  clipping.difference = () => { throw new Error('Unable to pop() left SweepEvent injected at host aperture.'); };
  try {
    const result = await fixture.operations.damage('door', { tokenId: 'token' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /遮挡几何计算失败.*house/);
    assert.equal(fixture.commits.length, 0);
    assert.equal(fixture.getStatusCalls(), 0, 'geometry preflight must fail before applying following effects');
    assert.equal(fixture.getLegacyWrites(), 0);
    assert.deepEqual(fixture.emitted, []);
    assert.deepEqual(fixture.getState(), before);
    assert.deepEqual(fixture.getState().preferences.worldV2.scenes[0].sceneEvents, []);
  } finally { clipping.difference = original; }
});

test('damage and restore status effects share one real World transaction with the scene event', async () => {
  const fixture = authorityFixture({ statuses: true });
  const siblingBefore = structuredClone(fixture.getState().preferences.worldV2.scenes[0].tokens[1]);
  const damaged = await fixture.operations.damage('house', { tokenId: 'token' });
  assert.equal(damaged.ok, true);
  assert.deepEqual(fixture.commits[0].batch.map(operation => operation.type), ['scene.content.replace', 'status.apply', 'status.apply']);
  let world = fixture.getState().preferences.worldV2;
  assert.deepEqual(world.actors[0].effects.map(effect => effect.definitionId), ['ruins-shock']);
  assert.deepEqual(world.scenes[0].tokens[0].effects.map(effect => effect.definitionId), ['ruins-dust']);
  assert.deepEqual(world.scenes[0].tokens[1], siblingBefore);
  const restored = await fixture.operations.restore('house', { tokenId: 'token' });
  assert.equal(restored.ok, true);
  assert.deepEqual(fixture.commits[1].batch.map(operation => operation.type), ['scene.content.replace', 'status.remove', 'status.remove']);
  world = fixture.getState().preferences.worldV2;
  assert.deepEqual(world.actors[0].effects, []);
  assert.deepEqual(world.scenes[0].tokens[0].effects, []);
  assert.deepEqual(world.scenes[0].tokens[1], siblingBefore);
  assert.equal(fixture.getLegacyWrites(), 0);
});

test('authoritative status rejection atomically rolls back preceding damage and restore events', async () => {
  for (const action of ['damage', 'restore']) {
    const fixture = authorityFixture({ statuses: true, failStatus: true });
    const before = fixture.getState(), snapshot = structuredClone(before);
    const result = await fixture.operations[action]('house', { tokenId: 'token' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /authoritative status failure/);
    assert.equal(fixture.getStatusCalls(), 1);
    assert.equal(fixture.commits.length, 0);
    assert.deepEqual(fixture.emitted, []);
    assert.equal(fixture.getState(), before);
    assert.deepEqual(fixture.getState(), snapshot);
    assert.equal(houseRay(fixture), false);
  }
});

test('Feature actor effects on an unlinked Token remain isolated to its Synthetic Actor on damage and restore', async () => {
  const fixture = authorityFixture({ statuses: true, synthetic: true });
  const actorBefore = structuredClone(fixture.getState().preferences.worldV2.actors[0]);
  const siblingBefore = structuredClone(fixture.getState().preferences.worldV2.scenes[0].tokens[1]);
  const result = await fixture.operations.damage('house', { tokenId: 'token' });
  assert.equal(result.ok, true);
  assert.equal(fixture.commits[0].batch[1].payload.scope, 'syntheticActor');
  assert.equal(fixture.commits[0].batch[1].payload.targetId, 'token');
  assert.equal(fixture.commits[0].batch[2].payload.scope, 'token');
  let world = fixture.getState().preferences.worldV2;
  assert.deepEqual(world.actors[0], actorBefore);
  assert.deepEqual(world.scenes[0].tokens[1], siblingBefore);
  assert.deepEqual(world.scenes[0].tokens[0].actorDelta.effects.map(effect => effect.definitionId), ['ruins-shock']);
  assert.deepEqual(world.scenes[0].tokens[0].effects.map(effect => effect.definitionId), ['ruins-dust']);
  assert.equal((await fixture.operations.restore('house', { tokenId: 'token' })).ok, true);
  assert.equal(fixture.commits[1].batch[1].payload.scope, 'syntheticActor');
  world = fixture.getState().preferences.worldV2;
  assert.deepEqual(world.actors[0], actorBefore);
  assert.deepEqual(world.scenes[0].tokens[1], siblingBefore);
  assert.deepEqual(world.scenes[0].tokens[0].actorDelta.effects, []);
  assert.deepEqual(world.scenes[0].tokens[0].effects, []);
});

test('Feature status targeting uses the active canonical Token, preserving legacy fallback only without World', () => {
  const fixture = authorityFixture({ statuses: true, synthetic: true });
  const state = structuredClone(fixture.getState());
  state.preferences.entitySystem.tokens[0].actorLink = true;
  const feature = fixture.mapPackage.features.find(item => item.id === 'house');
  const args = { feature, action: 'damage', state, tokenId: 'token', definitions: statusDefinitions };
  assert.equal(featureStatusMutations(args)[0].scope, 'syntheticActor');
  state.preferences.worldV2.scenes[0].tokens[0].actorLink = true;
  state.preferences.entitySystem.tokens[0].actorLink = false;
  assert.equal(featureStatusMutations(args)[0].scope, 'actor');
  delete state.preferences.worldV2;
  assert.equal(featureStatusMutations(args)[0].scope, 'syntheticActor');
});

test('restoration can remove damaged geometry while unrelated old errors remain recoverable', () => {
  const packageMap = map(), state = initial([event('old')]);
  const original = clipping.difference;
  clipping.difference = () => { throw new Error('Unable to pop() left SweepEvent injected from queue.'); };
  try {
    const restored = applyWorldOperations(state, [{ type: 'scene.content.replace', payload: { sceneId: 'scene',
      sceneEvents: [...state.sceneEvents, { id: 'restore', type: 'restore', featureIds: ['wall'] }],
    } }], { mapPackage: packageMap, source: { role: 'gm' } }).state;
    assert.equal(restored.preferences.worldV2.scenes[0].sceneEvents.at(-1).type, 'restore');
    assert.equal(deriveVisionOccluders(packageMap, restored.preferences.worldV2.scenes[0]).length, 1);
    assert.equal(state.sceneEvents.length, 1);
  } finally { clipping.difference = original; }
});

function queuedButtons({ staleProjection = false } = {}) {
  const base = authorityFixture({ statuses: true, synthetic: true });
  let state = structuredClone(base.getState());
  if (staleProjection) state.sceneEvents = [];
  const pending = [], emitted = [], committed = [];
  let statusCalls = 0;
  const operations = createFeatureOperations({ mapPackage: base.mapPackage, getState: () => state,
    replaceState() { throw new Error('No optimistic projection commits'); },
    performOperations(batch) {
      const world = state.preferences.worldV2;
      // Real addressed transport conversion preserves all Scene preconditions.
      const values = documentWritesToWorldOperations(worldOperationsToDocumentWrites(batch,
        { worldId: world.id, sceneId: world.activeSceneId }));
      return new Promise((resolve, reject) => pending.push({ values, resolve, reject }));
    },
    getStatusDefinitions: () => statusDefinitions,
    resolveStatus: () => ({ statuses: [], capabilities: { canInteract: true } }),
    emit: (type, detail) => emitted.push({ type, detail }),
  });
  return { operations, pending, emitted, committed, state: () => state,
    statusCalls: () => statusCalls,
    switchScene() {
      const next = structuredClone(state), world = next.preferences.worldV2;
      const other = { ...structuredClone(world.scenes[0]), id: 'other-scene' };
      world.scenes.push(other); world.activeSceneId = other.id;
      state = projectWorldOperationState(next);
    },
    flush() {
      const item = pending.shift();
      try {
        const applied = applyWorldOperations(state, item.values, { mapPackage: base.mapPackage, source: { role: 'gm' },
          applyStatus(value, message) {
            statusCalls++;
            const reduced = reduceStatusOperation(value.preferences.entitySystem, message);
            return { state: { ...value, preferences: { ...value.preferences, entitySystem: reduced.state } }, results: reduced.results };
          } });
        state = applied.state; committed.push(item.values); item.resolve(applied);
      } catch (error) { item.reject(error); }
    },
  };
}

test('queued destruction and restoration reject old absolute history before applying any effects', async () => {
  const fixture = queuedButtons(), before = structuredClone(fixture.state());
  const damage = fixture.operations.damage('house', { tokenId: 'token' });
  const restore = fixture.operations.restore('house', { tokenId: 'token' });
  assert.equal(fixture.pending.length, 2);
  assert.deepEqual(fixture.state(), before, 'pending network actions cannot mutate authoritative history');
  assert.deepEqual(fixture.emitted, []);
  fixture.flush();
  assert.equal((await damage).ok, true);
  const afterDamage = structuredClone(fixture.state());
  fixture.flush();
  const rejected = await restore;
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /历史已更新/);
  assert.deepEqual(fixture.state(), afterDamage);
  assert.equal(fixture.statusCalls(), 2, 'rejected restore must not remove the just-applied statuses');
  assert.deepEqual(fixture.emitted.map(event => event.type), ['scene:damage']);
  const retry = fixture.operations.restore('house', { tokenId: 'token' });
  fixture.flush();
  assert.equal((await retry).ok, true, 'user retry rebuilds history from the latest confirmed Scene');
  assert.equal(fixture.state().sceneEvents.length, before.sceneEvents.length + 2);
  assert.deepEqual(fixture.state().sceneEvents.at(-1).featureIds, ['house']);
});

test('queued button effects cannot target a different active Scene after a switch', async () => {
  for (const action of ['damage', 'restore']) {
    const fixture = queuedButtons();
    const pending = fixture.operations[action]('house', { tokenId: 'token' });
    fixture.switchScene();
    const before = structuredClone(fixture.state());
    fixture.flush();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.reason, /场景已切换/);
    assert.deepEqual(fixture.state(), before);
    assert.equal(fixture.statusCalls(), 0);
    assert.deepEqual(fixture.emitted, []);
  }
});

test('button history comes from canonical Scene when the old top-level projection is stale', async () => {
  const fixture = queuedButtons({ staleProjection: true });
  const canonical = fixture.state().preferences.worldV2.scenes[0].sceneEvents;
  const pending = fixture.operations.restore('house', { tokenId: 'token' });
  const payload = fixture.pending[0].values[0].payload;
  assert.equal(payload.sceneId, 'scene');
  assert.equal(payload.expectedActiveSceneId, 'scene');
  assert.deepEqual(payload.expectedSceneEvents, canonical);
  assert.deepEqual(payload.sceneEvents.slice(0, -1), canonical);
  fixture.flush();
  assert.equal((await pending).ok, true);
});

test('Scene replacement guards validate arrays and compare values independent of object key order', () => {
  const fixture = authorityFixture(), state = fixture.getState(), scene = state.preferences.worldV2.scenes[0];
  const expected = scene.sceneEvents.map(event => Object.fromEntries(Object.entries(event).reverse()));
  const payload = { sceneId: scene.id, expectedActiveSceneId: scene.id,
    expectedSceneEvents: expected, sceneEvents: scene.sceneEvents, expectedAttackAreas: [], attackAreas: [] };
  assert.doesNotThrow(() => applyWorldOperations(state, [{ type: 'scene.content.replace', payload }], { mapPackage: fixture.mapPackage }));
  for (const override of [{ expectedSceneEvents: [] }, { expectedAttackAreas: [{ id: 'missing' }] },
    { expectedSceneEvents: null }, { expectedAttackAreas: 'bad' }]) {
    const snapshot = structuredClone(state);
    assert.throws(() => applyWorldOperations(state, [{ type: 'scene.content.replace', payload: { ...payload, ...override } }],
      { mapPackage: fixture.mapPackage }), error => ['scene_content_conflict', 'invalid_world_operation'].includes(error.code));
    assert.deepEqual(state, snapshot);
  }
});
