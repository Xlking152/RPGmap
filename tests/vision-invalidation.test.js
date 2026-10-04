import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVisionChange, visionStatusTargets } from '../src/vision/invalidation.js';
import { createVisionFogSystem } from '../src/vision/system.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';

function fixtureState() {
  const scene = { id: 's', mapPackage: { id: 'map' }, featureStates: {}, sceneEvents: [], occlusionShapes: [],
    settings: { lighting: 'dark' }, fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {
      party: { rows: { 1: [[1, 2]] } }, foreign: { rows: { 1: [[10, 11]] } },
    } }, tokens: [
      { id: 'scout', actorId: 'actor', placement: 'map', x: 20, y: 20, elevationMeters: 0, vision: { enabled: true } },
      { id: 'other', actorId: 'foreign-actor', placement: 'map', x: 40, y: 20 },
      { id: 'lamp', actorId: 'foreign-actor', placement: 'map', x: 50, y: 30,
        light: { enabled: true, rangeMeters: 80, intensity: 1, elevationOffsetMeters: 2 } },
    ] };
  return { preferences: { worldV2: { id: 'world', activeSceneId: 's',
    actors: [{ id: 'actor', partyId: 'party', system: { perception: 1 } }, { id: 'foreign-actor', partyId: 'foreign' }],
    scenes: [scene, { ...structuredClone(scene), id: 'inactive' }] },
    audienceVision: { source: { tokenId: 'scout', x: 20, y: 20, preciseRangeMeters: 60 }, partyIds: ['party'] } } };
}

function replaceScene(state, transform, sceneId = 's') {
  const world = state.preferences.worldV2;
  return { ...state, preferences: { ...state.preferences, worldV2: { ...world,
    scenes: world.scenes.map(scene => scene.id === sceneId ? transform(scene) : scene) } } };
}

function changeToken(state, id, changes, sceneId = 's') {
  return replaceScene(state, scene => ({ ...scene,
    tokens: changes === null ? scene.tokens.filter(token => token.id !== id)
      : scene.tokens.map(token => token.id === id ? { ...token, ...changes } : token) }), sceneId);
}

const tokenSet = (id, fields = ['x'], sceneId = 's', deleted = false) => ({ tokens: [{ sceneId,
  upsertIds: deleted ? [] : [id], removeIds: deleted ? [id] : [], fields: { [id]: fields } }] });
const classify = (before, after, changeSet, options = {}) => classifyVisionChange({
  beforeState: before, afterState: after, changeSet, sourceTokenId: 'scout', ...options,
});

test('ordinary non-source movement and visual properties leave Fog and spatial inputs intact', () => {
  const before = fixtureState();
  for (const changes of [{ x: 41 }, { color: '#ffffff', name: 'Renamed' }, { movement: { spentMeters: 5 } }]) {
    const result = classify(before, changeToken(before, 'other', changes), tokenSet('other', Object.keys(changes)));
    assert.equal(result.render, false);
    assert.equal(result.spatialChanged, false);
    assert.equal(result.sourceChanged, false);
  }
});

test('source movement, elevation, synthetic Actor, senses and removal invalidate the source', () => {
  const before = fixtureState();
  for (const changes of [{ x: 21 }, { elevationMeters: 4 }, { actorDelta: { effects: [{ id: 'xray' }] } },
    { vision: { preciseRangeOverrideMeters: 1000 } }, { effects: [{ definitionId: 'blind' }] }, { placement: 'feature', featureId: 'house' }]) {
    assert.equal(classify(before, changeToken(before, 'scout', changes), tokenSet('scout', Object.keys(changes))).sourceChanged, true);
  }
  const removed = classify(before, changeToken(before, 'scout', null), tokenSet('scout', [], 's', true));
  assert.equal(removed.render, true);
  assert.equal(removed.resetVisibility, true);
  assert.equal(classify(before, before, { statusDefinitionsChanged: true }).sourceChanged, true);
});

test('light moves, disables and deletes use both canonical snapshots; disabled ordinary Tokens stay irrelevant', () => {
  const before = fixtureState();
  for (const changes of [{ x: 60 }, { elevationMeters: 10 }, { placement: 'feature' },
    { light: { enabled: false, rangeMeters: 80 } }, { light: { enabled: true, rangeMeters: 90 } }, null]) {
    const result = classify(before, changeToken(before, 'lamp', changes), tokenSet('lamp', changes ? Object.keys(changes) : [], 's', !changes));
    assert.equal(result.spatialChanged, true);
    assert.equal(result.render, true);
  }
  const disabled = changeToken(before, 'lamp', { light: { enabled: false, rangeMeters: 80 } });
  assert.equal(classify(disabled, changeToken(disabled, 'lamp', { x: 60 }), tokenSet('lamp')).render, false);
  assert.equal(classify(before, changeToken(before, 'other', { light: { enabled: true, rangeMeters: 10 } }),
    tokenSet('other', ['light'])).spatialChanged, true);
});

test('only the current parties actual Fog changes repaint exploration, including reset and membership', () => {
  const before = fixtureState();
  const fogChange = (party, value) => replaceScene(before, scene => ({ ...scene, fog: { ...scene.fog,
    exploredByParty: { ...scene.fog.exploredByParty, [party]: value } } }));
  const bounds = { minX: 0, minY: 0, maxX: 20, maxY: 20 };
  const changes = { fog: [{ sceneId: 's', dirtyBounds: bounds }] };
  assert.equal(classify(before, fogChange('foreign', { rows: { 1: [[10, 20]] } }), changes).render, false);
  assert.equal(classify(before, structuredClone(before), changes).render, false);
  assert.deepEqual(classify(before, fogChange('party', { rows: { 1: [[1, 3]] } }), changes).dirtyBounds, bounds);
  assert.equal(classify(before, fogChange('party', { rows: {} }), changes).exploredChanged, true);
  const changedParty = { ...before, preferences: { ...before.preferences,
    audienceVision: { ...before.preferences.audienceVision, partyIds: ['foreign'] } } };
  assert.equal(classify(before, changedParty, {}, { connected: true }).exploredChanged, true);
  const changedActor = { ...before, preferences: { ...before.preferences, worldV2: {
    ...before.preferences.worldV2, actors: [{ id: 'actor', partyId: 'foreign' }, before.preferences.worldV2.actors[1]],
  } } };
  assert.equal(classify(before, changedActor, { actors: { upsertIds: ['actor'] } }).exploredChanged, true);
});

test('geometry, preview inputs and lighting invalidate, while inactive-scene updates do not', () => {
  const before = fixtureState();
  for (const [field, value] of [['featureStates', { house: { door: { open: true } } }],
    ['occlusionShapes', [{ id: 'drawn-wall' }]], ['sceneEvents', [{ id: 'destroy-house' }]],
    ['settings', { lighting: 'normal' }], ['mapPackage', { id: 'map', version: '2' }]]) {
    assert.equal(classify(before, replaceScene(before, scene => ({ ...scene, [field]: value })),
      { scenes: { upsertIds: ['s'] } }).spatialChanged, true, field);
  }
  const inactive = changeToken(before, 'lamp', { x: 60 }, 'inactive');
  assert.equal(classify(before, inactive, tokenSet('lamp', ['x'], 'inactive')).render, false);
  assert.equal(classify(before, replaceScene(before, scene => ({ ...scene, featureStates: { door: {} } }), 'inactive'),
    { featureStates: [{ sceneId: 'inactive', featureIds: ['door'] }] }).render, false);
  assert.equal(classify(before, before, { sceneContent: [{ sceneId: 'inactive', types: ['SceneEvent'] }] }).render, false);
  const audience = { ...before, preferences: { ...before.preferences,
    audienceVision: { ...before.preferences.audienceVision,
      source: { ...before.preferences.audienceVision.source, senses: { xray: true } } } } };
  assert.equal(classify(before, audience, {}, { connected: true }).sourceChanged, true);
  assert.equal(classify(before, before, {}, { previousSourceTokenId: 'other' }).resetVisibility, true);
  const switched = { ...before, preferences: { ...before.preferences,
    worldV2: { ...before.preferences.worldV2, activeSceneId: 'inactive' } } };
  assert.equal(classify(before, switched, { scenes: { activeSceneChanged: true } }).resetVisibility, true);
});

test('unrecognized or malformed changes conservatively refresh instead of guessing', () => {
  const state = fixtureState();
  for (const changes of [null, { futureGeometry: true }, { tokens: {} }, { tokens: [{ upsertIds: {} }] },
    { tokens: [{ upsertIds: ['other'], fields: { other: ['futureSensor'] } }] }, { fog: [null] },
    { sceneContent: [{ sceneId: 's', types: ['FutureShape'] }] }, { collections: [{ type: 'FutureDocument' }] }]) {
    const result = classify(state, state, changes);
    assert.equal(result.render, true);
    assert.equal(result.unknown, true);
  }
});

test('status targets support canonical payloads, synthetic instances and mixed batches without guessing unknown scopes', () => {
  assert.deepEqual(visionStatusTargets({ payload: { scope: 'actor', targetId: 'actor' } }),
    { tokenIds: [], actorIds: ['actor'] });
  assert.deepEqual(visionStatusTargets({ snapshots: [{ tokenId: 'scout' }] }),
    { tokenIds: ['scout'], actorIds: [] });
  assert.deepEqual(visionStatusTargets({ payload: { operations: [
    { scope: 'syntheticActor', targetId: 'scout' }, { scope: 'actor', targetId: 'actor' },
  ] } }), { tokenIds: ['scout'], actorIds: ['actor'] });
  assert.equal(visionStatusTargets({ payload: { scope: 'futureScope', targetId: 'other' } }), null);
  assert.equal(visionStatusTargets({ payload: { operations: [
    { scope: 'token', targetId: 'other' }, { type: 'status.definition.upsert' },
  ] } }), null);
  assert.equal(visionStatusTargets({ type: 'status.definition.upsert' }), null);
});

function fakeRuntime(connected = false) {
  let state = fixtureState(), revision = 1, sequence = 0, explorationClears = 0;
  const handlers = new Map(), frames = new Map(), requests = [], toasts = [];
  const documentNode = { defaultView: { requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); } }, createElement() {
    const canvas = { width: 0, height: 0, style: {}, dataset: {}, setAttribute() {}, remove() {} };
    const context = new Proxy({ clearRect() {
      if (canvas.dataset.fogLayer === 'exploration-cache') explorationClears++;
    } }, { get(target, name) { return target[name] ?? (() => {}); } });
    canvas.getContext = () => context;
    return canvas;
  } };
  const mapPackage = { id: 'map', width: 120, height: 120, metersPerUnit: 1, features: [] };
  const pane = { style: {}, append() {} };
  const api = { mapPackage, map: { getContainer: () => ({ ownerDocument: documentNode }), getPane: () => pane,
    getSize: () => ({ x: 100, y: 100 }), containerPointToLayerPoint: point => ({ x: point[0], y: point[1] }),
    latLngToContainerPoint: point => ({ x: point.lng, y: mapPackage.height - point.lat }), on() {}, off() {} },
    getState: () => structuredClone(state), getStateRevision: () => revision,
    world: { queuesConfirmedExploration: true, performOperations: async () => null },
    ruleset: { vision: { describe: () => ({ preciseRangeMeters: 60, vagueRangeMeters: 80 }) } },
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list);
      return () => handlers.set(name, list.filter(fn => fn !== handler)); },
    emit(name, detail) { for (const handler of handlers.get(name) || []) handler({ detail }); },
    showToast(message) { toasts.push(message); } };
  if (connected) api.multiplayer = { getStatus: () => ({ connected: true }), getVisionSource: () => 'scout',
    canControlToken: id => Boolean(state.preferences.worldV2.scenes[0].tokens.find(token => token.id === id)),
    setVisionSource: async id => { requests.push(id); } };
  registerRuntimeStateReader(api, () => state);
  createVisionFogSystem().register(api);
  return { api, requests, toasts, frames, get state() { return state; }, get explorationClears() { return explorationClears; },
    replace(next) { state = next; revision++; },
    flush() { const entries = [...frames]; frames.clear(); for (const [, fn] of entries) fn(); },
    destroy() { api.emit('app:destroy'); } };
}

test('offline and LAN events suppress unrelated commits and preserve every source animation frame', async () => {
  const previousWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { this.terminated = false; workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
  };
  try {
    for (const connected of [false, true]) {
      const runtime = fakeRuntime(connected), { api } = runtime;
      try {
        if (!connected) await api.vision.setSource('scout');
        runtime.flush();
        const worker = workers.at(-1);
        worker.onmessage({ data: { id: worker.message.id, result: { precise: [['0', [[0, 10]]]], vague: [] } } });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(api.vision.getFeedbackState().rendered, false);
        assert.equal(runtime.frames.size, 1, 'complete Worker masks share the next frame');
        runtime.flush();
        const completed = api.vision.getFeedbackState();
        assert.equal(completed.rendered, true);
        for (let i = 0; i < 20; i++) {
          runtime.replace(changeToken(runtime.state, 'other', { x: 40 + i }));
          api.emit('status:change', { canonical: true, tokenIds: ['other'] });
          api.emit('state:patch', { changeSet: tokenSet('other') });
          api.emit('token:visual-position', { tokenId: 'other' });
          assert.equal(runtime.frames.size, 0, `${connected ? 'LAN' : 'offline'} foreign move ${i}`);
        }
        assert.equal(worker.terminated, false, 'unrelated commits retain the completed mask and its Worker');
        assert.deepEqual(api.vision.getFeedbackState(), completed);
        api.emit('status:change', { payload: { scope: 'token', targetId: 'other' } });
        api.emit('status:change', { snapshots: [{ tokenId: 'other' }] });
        assert.equal(runtime.frames.size, 0, 'unrelated normal and synthetic statuses do not repaint');
        api.emit('status:change', { payload: { scope: 'actor', targetId: 'actor' } });
        assert.equal(runtime.frames.size, 1, 'source Actor status stays responsive');
        runtime.flush();
        runtime.replace(changeToken(runtime.state, 'scout', { x: 21 }));
        api.emit('state:patch', { changeSet: tokenSet('scout') });
        assert.equal(runtime.frames.size, 1);
        runtime.flush();
        for (let i = 0; i < 6; i++) {
          api.emit('token:visual-position', { tokenId: 'scout' });
          assert.equal(runtime.frames.size, 1, `source animation sample ${i}`);
          runtime.flush();
        }
        runtime.replace(changeToken(runtime.state, 'lamp', { x: 60 }));
        api.emit('state:patch', { changeSet: tokenSet('lamp') });
        assert.equal(runtime.frames.size, 1, 'light movement refreshes the mask');
        runtime.flush();
        runtime.replace(changeToken(runtime.state, 'lamp', null));
        api.emit('token:delete', { canonical: true, id: 'lamp' });
        api.emit('state:patch', { changeSet: tokenSet('lamp', [], 's', true) });
        assert.equal(runtime.frames.size, 1, 'deleting a light invalidates using its previous canonical value');
        runtime.flush();
        const next = replaceScene(runtime.state, scene => ({ ...scene, fog: { ...scene.fog,
          exploredByParty: { ...scene.fog.exploredByParty, foreign: { rows: { 1: [[10, 20]] } } } } }));
        runtime.replace(next);
        api.emit('fog:change', { canonical: true, sceneId: 's' });
        api.emit('state:patch', { changeSet: { fog: [{ sceneId: 's', dirtyBounds: null }] } });
        assert.equal(runtime.frames.size, 0, 'another party exploration does not repaint');
        const exploredClears = runtime.explorationClears;
        api.emit('token:visual-position', { tokenId: 'scout' });
        runtime.flush();
        assert.equal(runtime.explorationClears, exploredClears, 'the next source frame reuses unchanged party exploration');
        runtime.replace(replaceScene(runtime.state, scene => ({ ...scene, fog: { ...scene.fog,
          exploredByParty: { ...scene.fog.exploredByParty, party: { rows: { 1: [[1, 4]] } } } } })));
        api.emit('fog:change', { canonical: true, sceneId: 's' });
        api.emit('state:patch', { changeSet: { fog: [{ sceneId: 's', dirtyBounds: null }] } });
        assert.equal(runtime.frames.size, 1, 'current party exploration paints once');
        runtime.flush();
        runtime.replace(changeToken(runtime.state, 'lamp', null, 'inactive'));
        api.emit('state:patch', { changeSet: tokenSet('lamp', [], 'inactive', true) });
        api.emit('feature:state-change', { sceneId: 'inactive' });
        assert.equal(runtime.frames.size, 0, 'inactive-scene lights and feature edits do not refresh');
        api.emit('occlusion:preview', {});
        assert.equal(runtime.frames.size, 1, 'authoring preview remains live');
        runtime.flush();
        runtime.replace(replaceScene(runtime.state, scene => ({ ...scene, settings: { lighting: 'normal' } })));
        api.emit('state:patch', { changeSet: { scenes: { upsertIds: ['s'] } } });
        assert.equal(runtime.frames.size, 1, 'ambient lighting invalidates the ruleset Scene descriptor');
        if (!connected) assert.equal(api.vision.getVisibleRegion().lighting, 'normal');
        runtime.flush();
        api.emit('state:patch', {});
        assert.equal(runtime.frames.size, 1, 'unknown patches retain conservative invalidation');
        runtime.flush();
        runtime.replace(changeToken(runtime.state, 'scout', null));
        api.emit('token:delete', { canonical: true, id: 'scout' });
        api.emit('state:patch', { changeSet: tokenSet('scout', [], 's', true) });
        assert.equal(runtime.frames.size, 1, 'source removal clears the visible mask');
        assert.equal(api.vision.getVisibleRegion(), null);
        if (connected) assert.deepEqual(runtime.requests, [null], 'unavailable LAN sources still request authoritative clearing');
        assert.deepEqual(runtime.toasts, []);
      } finally { runtime.destroy(); }
    }
  } finally { globalThis.Worker = previousWorker; }
});
