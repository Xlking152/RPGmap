import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldSystem } from '../src/world/system.js';
import { exportRuntimeState } from '../src/engine/runtime-state.js';
import { applyDocumentChanges } from '../src/documents/changes.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';

function fixture(ruleset = copyRuleset) {
  let current = exportRuntimeState(worldCopyInput().state, { mapPackage: copyMap, ruleset });
  let revision = 1, local = true, connected = false;
  const calls = [], saves = [], events = new Map();
  const api = {
    ruleset, mapPackage: copyMap,
    getState: () => structuredClone(current), getStateRevision: () => revision,
    isLocalWorldActive: () => local,
    multiplayer: { getConnectionState: () => ({ connected }) },
    commitState(next) { current = next; revision++; },
    applyAuthoritativeDocumentChanges(changes, options) {
      current = applyDocumentChanges(current, changes, { updatedAt: options.updatedAt });
      revision++; calls.push('commit');
    },
    persistNow() { calls.push('sync-save'); return true; },
    persistValidatedAsync() { calls.push('full-save'); return new Promise(resolve => saves.push(resolve)); },
    on(name, handler) { const handlers = events.get(name) || []; handlers.push(handler); events.set(name, handlers); },
    emit(name, detail) { for (const handler of events.get(name) || []) handler({ detail }); },
  };
  registerRuntimeStateReader(api, () => current);
  createWorldSystem().register(api);
  return { api, calls, saves, current: () => current,
    reconnect() { connected = true; }, suspend() { local = false; } };
}

function historyOperation(f, id = 'restore-once') {
  const scene = f.current().preferences.worldV2.scenes[0];
  return { type: 'scene.content.replace', payload: {
    sceneId: scene.id, expectedActiveSceneId: scene.id,
    expectedSceneEvents: structuredClone(scene.sceneEvents),
    sceneEvents: [...structuredClone(scene.sceneEvents), { id, type: 'restore', featureIds: ['wall'] }],
  } };
}

function frames(t) {
  const priorRAF = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const priorCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  const pending = new Map(); let next = 0;
  globalThis.requestAnimationFrame = callback => { pending.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => pending.delete(id);
  t.after(() => {
    if (priorRAF) Object.defineProperty(globalThis, 'requestAnimationFrame', priorRAF); else delete globalThis.requestAnimationFrame;
    if (priorCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', priorCancel); else delete globalThis.cancelAnimationFrame;
  });
  return { get count() { return pending.size; }, async paint() {
    const callbacks = [...pending.values()]; pending.clear();
    for (const callback of callbacks) callback(performance.now());
    await new Promise(resolve => setTimeout(resolve, 0));
  } };
}

test('scene edit yields before any commit and still waits for full durable validation', async t => {
  const frame = frames(t), f = fixture(), before = f.current(), operation = historyOperation(f);
  const result = f.api.world.performOperations([operation]);
  assert.equal(frame.count, 1);
  assert.equal(f.current(), before);
  assert.deepEqual(f.calls, []);
  operation.payload.sceneEvents.at(-1).featureIds.push('caller mutation');
  await frame.paint();
  assert.deepEqual(f.calls, ['commit', 'full-save']);
  assert.deepEqual(f.current().sceneEvents.at(-1).featureIds, ['wall']);
  let acknowledged = false; result.then(() => { acknowledged = true; });
  await Promise.resolve(); assert.equal(acknowledged, false);
  f.saves.shift()(true);
  assert.equal((await result).offline, true);
});

test('a concurrent Fog commit is preserved when the scene edit is recomputed after paint', async t => {
  const frame = frames(t), f = fixture(), operation = historyOperation(f);
  const edited = f.api.world.performOperations([operation]);
  await f.api.world.performOperations([{ type: 'scene.fog.explore', payload: {
    sceneId: 'scene-a', partyId: 'party', x: 21, y: 22, radiusMeters: 20,
  } }], { addedExploration: { schemaVersion: 1, cellSizeMeters: 5,
    exploredByParty: { party: { rows: { 15: [[11, 15]] } } } } });
  const fog = structuredClone(f.current().preferences.worldV2.scenes[0].fog);
  operation.payload.sceneEvents.at(-1).featureIds.push('caller mutation');
  await frame.paint();
  assert.deepEqual(f.current().preferences.worldV2.scenes[0].fog, fog);
  assert.deepEqual(f.current().sceneEvents.at(-1).featureIds, ['wall']);
  f.saves.shift()(true); await edited;
});

test('two replacements based on the same history cannot overwrite one another after paint', async t => {
  const frame = frames(t), f = fixture();
  const first = f.api.world.performOperations([historyOperation(f, 'first')]);
  const second = f.api.world.performOperations([historyOperation(f, 'second')]);
  const rejected = assert.rejects(second, { code: 'scene_content_conflict' });
  assert.equal(frame.count, 2); assert.deepEqual(f.calls, []);
  await frame.paint();
  assert.deepEqual(f.calls, ['commit', 'full-save']);
  assert.equal(f.current().sceneEvents.at(-1).id, 'first');
  f.saves.shift()(true); await first; await rejected;
});

test('imports, source invalidation, destruction and reconnect prevent a suspended edit from committing', async t => {
  const frame = frames(t);
  for (const invalidate of [f => f.api.emit('state:import'), f => f.api.emit('vision:source-change'),
    f => f.api.emit('app:destroy'), f => f.reconnect(), f => f.suspend()]) {
    const f = fixture(), before = f.current();
    const edit = f.api.world.performOperations([historyOperation(f)]);
    const rejected = assert.rejects(edit, { code: 'world_operation_context_changed' });
    invalidate(f); await frame.paint(); await rejected;
    assert.equal(f.current(), before); assert.deepEqual(f.calls, []);
  }
});

test('custom Rulesets keep their original immediate reducer and commit behavior', async t => {
  const frame = frames(t), f = fixture({ ...copyRuleset });
  const edit = f.api.world.performOperations([historyOperation(f)]);
  assert.equal(frame.count, 0);
  assert.deepEqual(f.calls, ['commit', 'full-save']);
  f.saves.shift()(true); await edit;
});

test('a scene switch during the paint opportunity retains absolute replacement guards', async t => {
  const frame = frames(t), f = fixture();
  const edit = f.api.world.performOperations([historyOperation(f)]);
  const rejected = assert.rejects(edit, { code: 'scene_content_conflict' });
  const switched = f.api.world.performOperations([{ type: 'scene.activate', payload: { sceneId: 'scene-b' } }]);
  const current = f.current();
  f.saves.shift()(true); await switched;
  await frame.paint(); await rejected;
  assert.equal(f.current(), current);
  assert.equal(f.current().preferences.worldV2.activeSceneId, 'scene-b');
  assert.deepEqual(f.calls, ['commit', 'full-save']);
});
