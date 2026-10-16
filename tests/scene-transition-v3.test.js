import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldSystem } from '../src/world/system.js';
import { createMovementTokenRuntimeSystem } from '../src/movement/token-runtime.js';
import { createMovementFastPathSystem } from '../src/movement/fast-path.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { documentWritesToWorldOperations, worldOperationsToDocumentWrites } from '../src/documents/protocol.js';

function runtime() {
  const mapPackage = { id: 'transition-map', version: '1', width: 100, height: 100, metersPerUnit: 1, features: [] };
  const actor = { id: 'actor', name: 'Actor', type: 'pc', system: {}, effects: [], partyId: 'party' };
  const scene = id => ({ id, name: id, mapPackage: { id: mapPackage.id, version: '1' },
    tokens: [{ id: 'same-token', actorId: actor.id, placement: 'map', x: 10, y: 10,
      elevationMeters: 0, diameterMeters: 1, actorLink: true, effects: [] }],
    markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, settings: {} });
  let state = { preferences: { worldV2: { schemaVersion: 4, id: 'world', ruleset: { id: ruleset.id, version: ruleset.version },
    activeSceneId: 'a', actors: [actor], statusDefinitions: [], scenes: [scene('a'), scene('b')] } } };
  const handlers = new Map(), writes = [];
  const api = { mapPackage, ruleset, getState: () => structuredClone(state),
    commitState(next, options) { state = structuredClone(next); api.emit('state:commit', options); return true; },
    persistNow: () => true,
    on(name, callback) { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list);
      return () => handlers.set(name, list.filter(fn => fn !== callback)); },
    emit(name, detail) { for (const callback of handlers.get(name) || []) callback({ detail }); },
  };
  createWorldSystem().register(api);
  api.tokens = { get: id => api.world.getActiveScene().tokens.find(token => token.id === id) };
  createMovementTokenRuntimeSystem().register(api);
  api.documents = { dispatch(write) { writes.push(structuredClone(write));
    return api.world.performOperations(documentWritesToWorldOperations([write])); } };
  createMovementFastPathSystem().register(api);
  return { api, writes, state: () => state, switchWithoutEvent() { state.preferences.worldV2.activeSceneId = 'b'; } };
}

for (const event of ['scene:switch-starting', 'scene:reset-starting']) {
  test(`${event} prevents an awaiting movement validation from writing same-ID Tokens into either Scene`, async () => {
    const value = runtime(), { api } = value;
    const before = structuredClone(value.state());
    const pending = api.movementFast.moveTokenPath(['same-token'], 'same-token', [{ x: 20, y: 10 }]);
    api.emit(event, { sceneId: event === 'scene:switch-starting' ? 'b' : 'a' });
    const result = await pending;
    assert.equal(result.valid, false);
    assert.equal(result.code, 'scene_content_conflict');
    assert.equal(value.writes.length, 0);
    assert.deepEqual(value.state(), before);
    assert.equal(api.world.isSceneTransitionPending(), true);
    await assert.rejects(api.world.performOperations([{ type: 'world.rename', payload: { name: 'late old input' } }]),
      { code: 'scene_transition_pending' });
    await assert.rejects(api.runtimeSession.dispatch(worldOperationsToDocumentWrites([
      { type: 'world.rename', payload: { name: 'direct port cannot bypass pause' } },
    ], { worldId: 'world' })), { code: 'scene_transition_pending' });
    api.emit(event === 'scene:switch-starting' ? 'scene:switch-failed' : 'scene:reset-failed');
    assert.equal(api.world.isSceneTransitionPending(), false);
    assert.equal((await api.movementFast.moveTokenPath(['same-token'], 'same-token', [{ x: 20, y: 10 }])).valid, true);
    assert.equal(value.writes[0].document.parent.id, 'a');
    api.emit('app:destroy');
  });
}

test('movement retains its initiating Scene identity even without a transition notification', async () => {
  const value = runtime();
  const pending = value.api.movementFast.moveTokenPath(['same-token'], 'same-token', [{ x: 20, y: 10 }]);
  value.switchWithoutEvent();
  assert.equal((await pending).code, 'scene_content_conflict');
  assert.equal(value.writes.length, 0);
  assert.equal(value.api.world.getActiveScene().tokens[0].x, 10);
  value.api.emit('app:destroy');
});

test('same-map activation cancels both completed plans and plans still being validated', async () => {
  const value = runtime(), { api } = value;
  assert.equal((await api.movement.planTokenMove('same-token', { x: 20, y: 10 })).valid, true);
  const events = [];
  for (const event of ['scene:switch-starting', 'scene:switch-complete']) api.on(event, () => events.push(event));
  await api.world.setActiveScene('b');
  assert.deepEqual(events, ['scene:switch-starting', 'scene:switch-complete']);
  assert.equal(api.movement.getPendingPlan(), null);
  assert.equal(api.movement.commitTokenMove(), false);
  const pending = api.movement.planTokenMove('same-token', { x: 20, y: 10 });
  api.emit('scene:reset-starting', { sceneId: 'b' });
  assert.equal(await pending, null);
  assert.equal(api.movement.getPendingPlan(), null);
  assert.equal(api.world.getActiveScene().tokens[0].x, 10);
  api.emit('app:destroy');
});
