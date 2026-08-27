import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMovementStatusMutations,
  createMovementTokenRuntimeSystem,
} from '../src/movement/token-runtime.js';

function actor() {
  return { id: 'actor-a', name: 'Template', effects: [] };
}

function token(overrides = {}) {
  return {
    id: 'token-a', actorId: 'actor-a', actorLink: true, actorDelta: null,
    placement: 'map', x: 1.5, y: 1.5, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    hidden: false, locked: false, showName: true, effects: [],
    ...overrides,
  };
}

function world(tokenValue = token()) {
  return {
    schemaVersion: 2,
    id: 'world-test', name: 'World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    actors: [actor()],
    statusDefinitions: [],
    activeSceneId: 'scene-a',
    scenes: [{
      id: 'scene-a', name: 'Scene', mapPackage: { id: 'map', version: '1' },
      tokens: [tokenValue], markers: [], attackAreas: [], sceneEvents: [], settings: {},
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fixture({ tokenValue = token(), features = [] } = {}) {
  let currentWorld = world(tokenValue);
  const state = {
    characters: [{ id: tokenValue.id, location: { type: 'map', x: 999, y: 999 } }],
    preferences: { featureStates: {} },
    sceneEvents: [],
  };
  const listeners = new Map();
  const events = [];
  const api = {
    mapPackage: {
      id: 'map', mapId: 'map', version: '1', width: 20, height: 20,
      features, roadBuffers: [], liquidBodies: [], floodRules: {}, navigation: {},
    },
    getState() { return structuredClone(state); },
    tokens: {
      get(id) {
        const scene = currentWorld.scenes.find(item => item.id === currentWorld.activeSceneId);
        const value = scene.tokens.find(item => String(item.id) === String(id));
        return value ? structuredClone(value) : null;
      },
      list() {
        const scene = currentWorld.scenes.find(item => item.id === currentWorld.activeSceneId);
        return structuredClone(scene.tokens);
      },
    },
    world: {
      get() { return structuredClone(currentWorld); },
      getActiveScene() {
        return structuredClone(currentWorld.scenes.find(item => item.id === currentWorld.activeSceneId));
      },
      async commit(next) { currentWorld = structuredClone(next); return structuredClone(currentWorld); },
    },
    status: {
      resolve() {
        return {
          statusVersion: 'test', statuses: [],
          capabilities: { canMove: true, canInteract: true, collisionBypassGroups: [] },
        };
      },
    },
    on(name, listener) {
      const set = listeners.get(name) || new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit(name, detail) {
      events.push({ name, detail: structuredClone(detail) });
      for (const listener of listeners.get(name) || []) listener({ detail });
    },
  };
  createMovementTokenRuntimeSystem().register(api);
  return { api, events, getWorld: () => structuredClone(currentWorld), state };
}

function once(api, name) {
  return new Promise(resolve => {
    const off = api.on(name, event => { off(); resolve(event.detail); });
  });
}

test('Movement Runtime commits map movement to Scene.tokens without mutating Character location directly', async () => {
  const { api, getWorld, state } = fixture();
  const route = await api.movement.planTokenMove('token-a', { x: 5.5, y: 6.5 });
  assert.equal(route.valid, true);
  const moved = once(api, 'token:move');
  assert.equal(api.movement.commitTokenMove(), true);
  await moved;

  const committed = getWorld().scenes[0].tokens[0];
  assert.equal(committed.placement, 'map');
  assert.equal(committed.x, 5.5);
  assert.equal(committed.y, 6.5);
  assert.deepEqual(state.characters[0].location, { type: 'map', x: 999, y: 999 });
});

test('Movement Runtime enters and exits a Feature by changing canonical Token placement', async () => {
  const building = {
    id: 'building-1', center: [10, 10], entrance: [9.5, 10.5],
    capabilities: { enterable: true },
  };
  const { api, getWorld } = fixture({ features: [building] });

  const route = await api.movement.planTokenMove('token-a', { x: 9.5, y: 10.5 }, {
    type: 'feature', featureId: 'building-1',
  });
  assert.equal(route.valid, true);
  let moved = once(api, 'token:move');
  assert.equal(api.movement.commitTokenMove(), true);
  await moved;
  let committed = getWorld().scenes[0].tokens[0];
  assert.equal(committed.placement, 'feature');
  assert.equal(committed.featureId, 'building-1');
  assert.equal(committed.x, null);
  assert.equal(committed.y, null);

  moved = once(api, 'token:move');
  assert.equal(await api.movement.exitFeature('token-a'), true);
  await moved;
  committed = getWorld().scenes[0].tokens[0];
  assert.equal(committed.placement, 'map');
  assert.equal(committed.featureId, null);
  assert.equal(Number.isFinite(committed.x), true);
  assert.equal(Number.isFinite(committed.y), true);
});

test('Feature Actor-status side effects on an unlinked Token write Synthetic Actor actorDelta only', () => {
  const source = world(token({
    id: 'npc-1', actorLink: false, actorDelta: {},
  }));
  const next = applyMovementStatusMutations(source, 'npc-1', [{
    type: 'status.apply', scope: 'actor', targetId: 'actor-a',
    statusId: 'status-rooted', stacks: 1,
  }], { source: { type: 'feature', featureId: 'trap-1', action: 'enter' } });

  assert.deepEqual(next.actors[0].effects, []);
  const npc = next.scenes[0].tokens[0];
  assert.equal(npc.actorLink, false);
  assert.equal(npc.actorDelta.effects.length, 1);
  assert.equal(npc.actorDelta.effects[0].definitionId, 'status-rooted');
});
