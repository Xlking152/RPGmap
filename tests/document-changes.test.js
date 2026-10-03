import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocumentChanges, createDocumentChanges, createDocumentChangesFull, createFogDocumentChanges, documentChangeSet } from '../src/documents/changes.js';
import { createDocumentBackendSystem } from '../src/documents/index.js';

function fixture() {
  const actors = [{ id: 'a', system: { forms: [{ id: 'base', notes: 'private template' }], runtime: { health: { current: 10, max: 20 }, extension: { remove: true, keep: true } } } }];
  const scene = id => ({
    id, name: id, mapPackage: { id: 'map', version: '1.0.0' },
    tokens: [{ id: 't', actorId: 'a', x: 10, y: 20, actorDelta: { effects: [] } }],
    markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} }, settings: { gridVisible: true },
  });
  const world = { id: 'w', schemaVersion: 3, ruleset: { id: 'test', version: '1' }, activeSceneId: 's1', actors, scenes: [scene('s1'), scene('s2')], statusDefinitions: [], updatedAt: 'before' };
  return { preferences: { worldV2: world, entitySystem: { actors, tokens: world.scenes[0].tokens, statusDefinitions: [] }, combatSystem: { combat: null }, chatSystem: { schemaVersion: 1, messages: [] } } };
}

function roundTrip(before, after, options = {}) {
  const frozenBefore = structuredClone(before);
  const changes = createDocumentChanges(before, after, null, options);
  const applied = applyDocumentChanges(before, changes, { updatedAt: after.preferences.worldV2.updatedAt });
  assert.deepEqual(applied.preferences.worldV2, after.preferences.worldV2);
  assert.deepEqual(applied.preferences.chatSystem, after.preferences.chatSystem);
  assert.deepEqual(applied.preferences.combatSystem, after.preferences.combatSystem);
  assert.deepEqual(applied.preferences.audienceVision, after.preferences.audienceVision);
  assert.deepEqual(before, frozenBefore);
  return { changes, applied };
}

test('paired Document diff has byte-identical changes to the full diff for large moves and structural fallbacks', () => {
  const before = fixture();
  const firstScene = before.preferences.worldV2.scenes[0];
  for (let index = 2; index <= 500; index += 1) {
    firstScene.tokens.push({ ...firstScene.tokens[0], id: `t-${index}`, x: 10 + index, y: 20 + index });
  }
  const cases = [
    {
      name: 'move and sparse fog',
      mutate(after) {
        after.preferences.worldV2.scenes[0].tokens[320].x += 1;
        after.preferences.worldV2.scenes[0].fog.exploredByParty.party = { rows: { 7: [[10, 12]] } };
        after.preferences.audienceVision = { source: { tokenId: 't-321', x: 331, y: 341 }, partyIds: ['party'] };
      },
      options: { motion: [{ sceneId: 's1', tokenId: 't-321' }], fog: [{ sceneId: 's1', dirtyBounds: { minX: 0, minY: 0, maxX: 30, maxY: 30 } }] },
    },
    { name: 'nested actor deletion', mutate(after) { delete after.preferences.worldV2.actors[0].system.runtime.extension.remove; } },
    { name: 'cross-scene duplicate Token ID', mutate(after) { after.preferences.worldV2.scenes[1].tokens[0].y += 2; },
      options: { motion: [{ sceneId: 's2', tokenId: 't' }] } },
    { name: 'Token reorder fallback', mutate(after) { after.preferences.worldV2.scenes[0].tokens.reverse(); } },
    { name: 'Token append fallback', mutate(after) { after.preferences.worldV2.scenes[0].tokens.push({ ...after.preferences.worldV2.scenes[0].tokens[0], id: 'new' }); } },
    { name: 'optional OcclusionShape collection fallback', mutate(after) { after.preferences.worldV2.scenes[0].occlusionShapes = []; } },
    { name: 'Chat append fallback', mutate(after) { after.preferences.chatSystem.messages.push({ id: 'new-message', text: 'test' }); } },
  ];
  for (const entry of cases) {
    const after = structuredClone(before);
    entry.mutate(after);
    const options = entry.options || {};
    const quick = createDocumentChanges(before, after, null, options);
    const full = createDocumentChangesFull(before, after, null, options);
    assert.equal(JSON.stringify(quick), JSON.stringify(full), entry.name);
    assert.deepEqual(applyDocumentChanges(before, quick, { updatedAt: after.preferences.worldV2.updatedAt }),
      applyDocumentChanges(before, full, { updatedAt: after.preferences.worldV2.updatedAt }), entry.name);
  }
});

test('unchanged immutable leaf collections skip repeated identity scans while Scene child changes remain complete', () => {
  const freeze = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value);
  };
  const before = fixture();
  before.preferences.worldV2.actors[0].id = 'immutable-leaf-actor';
  before.preferences.worldV2.scenes.forEach(scene => { scene.tokens[0].actorId = 'immutable-leaf-actor'; });
  freeze(before);
  assert.deepEqual(createDocumentChanges(before, before), []); // Qualify shared immutable collections once.
  const world = before.preferences.worldV2, scene = world.scenes[0];
  const after = { ...before, preferences: { ...before.preferences, worldV2: { ...world,
    scenes: [{ ...scene, tokens: [{ ...scene.tokens[0], x: 37 }],
      fog: { ...scene.fog, exploredByParty: { party: { rows: { 3: [[4, 7]] } } } } }, world.scenes[1]],
  } } };
  const originalString = globalThis.String;
  let idReads = 0;
  globalThis.String = value => { if (value === 'immutable-leaf-actor') idReads++; return originalString(value); };
  try {
    const quick = createDocumentChanges(before, after), quickReads = idReads;
    idReads = 0;
    const full = createDocumentChangesFull(before, after);
    assert.deepEqual(quick, full);
    assert.equal(quickReads, 0);
    assert.ok(idReads > 0, 'the full oracle still visits the shared Actor collection');
    assert.deepEqual(quick.map(change => change.document.type), ['Token', 'Fog']);
    assert.deepEqual(applyDocumentChanges(before, quick).preferences.worldV2, after.preferences.worldV2);
  } finally { globalThis.String = originalString; }
});

test('mutable IDs, frozen accessors and duplicate collections retain the full diff fallback', () => {
  for (const variant of ['mutable', 'shallow-frozen', 'accessor', 'duplicate']) {
    const before = fixture(), actors = before.preferences.worldV2.actors;
    actors.push({ ...structuredClone(actors[0]), id: 'second' });
    let id = 'second';
    if (variant === 'accessor') {
      Object.defineProperty(actors[1], 'id', { enumerable: true, get: () => id });
      Object.freeze(actors[1]); Object.freeze(actors);
    } else if (variant === 'shallow-frozen') Object.freeze(actors);
    else if (variant === 'duplicate') {
      actors[1].id = 'a'; actors.forEach(Object.freeze); Object.freeze(actors);
    }
    createDocumentChanges(before, before);
    if (variant === 'accessor') id = 'a';
    else if (variant !== 'duplicate') actors[1].id = 'a';
    const after = { ...before, preferences: { ...before.preferences, audienceVision: { source: null, partyIds: ['party'] } } };
    assert.deepEqual(createDocumentChanges(before, after), createDocumentChangesFull(before, after), variant);
  }
});

test('focused Fog updates match full recipient deltas through sparse rows, removals and missing documents', () => {
  for (const variant of ['update', 'create', 'delete', 'unchanged']) {
    const before = fixture();
    before.preferences.worldV2.scenes[0].fog.exploredByParty = { party: { rows: { 1: [[1, 3]], 2: [[8, 9]] } } };
    const after = structuredClone(before);
    if (variant === 'update') {
      after.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows = { 1: [[1, 6]], 3: [[2, 4]] };
    } else if (variant === 'create') delete before.preferences.worldV2.scenes[0].fog;
    else if (variant === 'delete') delete after.preferences.worldV2.scenes[0].fog;
    after.preferences.worldV2.updatedAt = 'after';
    const preserved = structuredClone(before);
    const options = { fog: [{ sceneId: 's1', dirtyBounds: { minX: 0, minY: 5, maxX: 30, maxY: 10 } },
      { sceneId: 's1', dirtyBounds: { minX: 10, minY: 0, maxX: 50, maxY: 15 } }] };
    const focused = createFogDocumentChanges(before, after, options);
    const full = createDocumentChanges(before, after, null, options);
    assert.deepEqual(focused, full, variant);
    const applied = applyDocumentChanges(before, focused, { updatedAt: 'after' });
    assert.deepEqual(applied, applyDocumentChanges(before, full, { updatedAt: 'after' }));
    assert.deepEqual(JSON.parse(JSON.stringify(applied.preferences.worldV2)), JSON.parse(JSON.stringify(after.preferences.worldV2)));
    assert.deepEqual(before, preserved);
    assert.ok(focused.every(change => change.document.type === 'Fog'));
  }
});

test('Document deltas preserve nested deletions, nulls and unrelated template data', () => {
  const before = fixture();
  const after = structuredClone(before);
  after.preferences.worldV2.actors[0].system.runtime.health.current = 7;
  after.preferences.worldV2.actors[0].system.runtime.health.max = null;
  delete after.preferences.worldV2.actors[0].system.runtime.extension.remove;
  const { changes, applied } = roundTrip(before, after);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].changed, { system: { runtime: { health: { current: 7, max: null } } } });
  assert.deepEqual(changes[0].removed, [['system', 'runtime', 'extension', 'remove']]);
  assert.equal(JSON.stringify(changes).includes('private template'), false);
  assert.strictEqual(applied.preferences.worldV2.actors[0].system.forms, before.preferences.worldV2.actors[0].system.forms);
});

test('Scene-qualified Token updates isolate duplicate Token ids and preserve unchanged objects', () => {
  const before = fixture();
  const after = structuredClone(before);
  after.preferences.worldV2.scenes[1].tokens[0].x = 25;
  const { changes, applied } = roundTrip(before, after, { motion: [{ sceneId: 's2', tokenId: 't' }] });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].action, 'move');
  assert.equal(changes[0].document.parent.id, 's2');
  assert.deepEqual(changes[0].changed, { x: 25 });
  assert.strictEqual(applied.preferences.worldV2.scenes[0], before.preferences.worldV2.scenes[0]);
  assert.strictEqual(applied.preferences.worldV2.actors, before.preferences.worldV2.actors);
  assert.deepEqual(documentChangeSet(changes).tokens[0].fields, { t: ['x'] });
});

test('Feature, fog rows, Status definitions and Scene history survive a single changes-only commit', () => {
  const before = fixture();
  before.preferences.worldV2.scenes[0].featureStates.gate = { open: false, custom: { kept: 1, removed: 2 } };
  const after = structuredClone(before);
  const scene = after.preferences.worldV2.scenes[0];
  scene.featureStates.gate = { open: true, custom: { kept: 1 } };
  scene.fog.exploredByParty.team = { rows: { 0: [[0, 3]] } };
  scene.sceneEvents.push({ id: 'damage', type: 'damage', objectIds: ['wall'] });
  scene.markers.push({ id: 'note', x: 2, y: 3 });
  after.preferences.worldV2.statusDefinitions.push({ id: 'custom', name: 'custom' });
  const { changes } = roundTrip(before, after);
  assert.deepEqual(new Set(changes.map(change => change.document.type)), new Set(['FeatureState', 'Fog', 'SceneEvent', 'Marker', 'StatusDefinition']));
  assert.equal(changes.some(change => change.document.type === 'Scene'), false);
  roundTrip(after, before);
});

test('Scene creation, activation, deletion and child documents are atomic', () => {
  const before = fixture();
  const after = structuredClone(before);
  const next = structuredClone(after.preferences.worldV2.scenes[0]);
  next.id = 's3';
  after.preferences.worldV2.scenes = [after.preferences.worldV2.scenes[1], next];
  after.preferences.worldV2.activeSceneId = 's3';
  const { changes, applied } = roundTrip(before, after);
  const created = changes.find(change => change.document.type === 'Scene' && change.action === 'create');
  assert.equal(Object.hasOwn(created.changed, 'tokens'), false);
  assert.strictEqual(applied.preferences.entitySystem.tokens, applied.preferences.worldV2.scenes[1].tokens);
});

test('Chat appends, retention removals and clear never send unchanged history', () => {
  const before = fixture();
  before.preferences.chatSystem.messages = [{ id: 'old', text: 'old' }, { id: 'keep', text: 'keep' }];
  const after = structuredClone(before);
  after.preferences.chatSystem.messages = [{ id: 'keep', text: 'keep' }, { id: 'new', text: 'new' }];
  const { changes } = roundTrip(before, after);
  assert.deepEqual(changes.map(change => [change.action, change.document.id]), [['append', 'new'], ['delete', 'old']]);
  const clear = structuredClone(after);
  clear.preferences.chatSystem.messages = [];
  roundTrip(after, clear);
});

test('Audience removals erase hidden runtime fields rather than retaining stale details', () => {
  const before = fixture();
  before.preferences.audienceVision = { sourceTokenId: 't', preciseRangeMeters: 30 };
  const after = structuredClone(before);
  delete after.preferences.audienceVision;
  after.preferences.worldV2.actors[0].system = {};
  roundTrip(before, after);
});

test('Explicit collection order preserves scene and token reordering without resending documents', () => {
  const before = fixture();
  before.preferences.worldV2.scenes[0].tokens.push({ ...before.preferences.worldV2.scenes[0].tokens[0], id: 't2' });
  const after = structuredClone(before);
  after.preferences.worldV2.scenes.reverse();
  after.preferences.worldV2.scenes[1].tokens.reverse();
  const { changes } = roundTrip(before, after);
  assert.equal(changes.length, 2);
  assert.ok(changes.every(change => change.document.type === 'Collection'));
  assert.equal(JSON.stringify(changes).includes('private template'), false);
});

test('Invalid references and prototype payloads reject without mutating the prior projection', () => {
  const before = fixture();
  const original = structuredClone(before);
  const change = { action: 'update', document: { type: 'Token', id: 't', parent: { type: 'Scene', id: 's1' } }, changed: { actorId: 'missing' } };
  assert.throws(() => applyDocumentChanges(before, [change]), error => error.code === 'invalid_reference');
  assert.throws(() => applyDocumentChanges(before, [{ ...change, changed: JSON.parse('{"__proto__":{"polluted":true}}') }]), error => error.code === 'invalid_document_change');
  assert.throws(() => applyDocumentChanges(before, [{ ...change, changed: {}, removed: [['constructor', 'prototype']] }]), error => error.code === 'invalid_document_change');
  assert.deepEqual(before, original);
  assert.equal({}.polluted, undefined);
});

test('Offline Document dispatch applies actual reducer changes without rebuilding the Collection', async () => {
  let state = fixture();
  let reads = 0;
  const events = [];
  const api = {
    getState() { reads += 1; return state; },
    on() {},
    emit(type, detail) { events.push({ type, detail }); },
    world: {
      get() { return state.preferences.worldV2; },
      async performOperations() {
        const after = structuredClone(state);
        after.preferences.worldV2.scenes[0].tokens[0].x = 27;
        after.preferences.worldV2.scenes[0].featureStates.door = { open: true };
        const changes = createDocumentChanges(state, after);
        state = applyDocumentChanges(state, changes);
        api.documents.applyCommitted(changes);
        return { offline: true, changes };
      },
    },
  };
  createDocumentBackendSystem().register(api);
  const initialReads = reads;
  await api.documents.dispatch({ action: 'move', document: { type: 'Token', id: 't', parent: { type: 'Scene', id: 's1' } }, intent: 'token.move', data: { x: 27, y: 20 } });
  assert.equal(reads, initialReads);
  assert.equal(api.documents.get({ type: 'Token', id: 't', parent: { type: 'Scene', id: 's1' } }).x, 27);
  assert.equal(api.documents.get({ type: 'Token', id: 't', parent: { type: 'Scene', id: 's2' } }).x, 10);
  assert.deepEqual(api.documents.get({ type: 'FeatureState', id: 'door', parent: { type: 'Scene', id: 's1' } }), { open: true });
  assert.equal(events.filter(event => event.detail.document.type === 'Token').length, 1);
});

test('Committed addresses cannot replace collections, duplicate documents or change identity', () => {
  const before = fixture();
  const original = structuredClone(before);
  const invalid = [
    { document: { type: 'World', id: 'w' }, removed: [['actors']], changed: {} },
    { document: { type: 'World', id: 'w' }, changed: { id: 'another' } },
    { document: { type: 'Scene', id: 's1' }, removed: [['tokens']], changed: {} },
    { document: { type: 'Actor', id: 'a', parent: { type: 'Scene', id: 's1' } }, changed: {} },
    { document: { type: 'Fog', id: 's2', parent: { type: 'Scene', id: 's1' } }, changed: {} },
    { document: { type: 'ChatLog', id: 'active' }, changed: { messages: [] } },
    { document: { type: 'Actor', id: 'a' }, action: 'create', changed: { id: 'a' } },
  ];
  for (const change of invalid) assert.throws(() => applyDocumentChanges(before, [{ action: 'update', ...change }]), /Document|Fog|collections/);
  assert.deepEqual(before, original);
});
