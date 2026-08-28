import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSceneToken,
  getActiveSceneToken,
  listActiveSceneTokens,
  moveSceneToken,
  placeSceneTokenInFeature,
  removeSceneToken,
  updateSceneToken,
} from '../src/token/model.js';

function world() {
  return {
    schemaVersion: 2,
    id: 'world-test',
    name: 'World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    actors: [
      { id: 'actor-a', name: 'A' },
      { id: 'actor-b', name: 'B' },
    ],
    statusDefinitions: [],
    activeSceneId: 'scene-a',
    scenes: [
      {
        id: 'scene-a', name: 'A', mapPackage: { id: 'map', version: '1' },
        tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: {},
      },
      {
        id: 'scene-b', name: 'B', mapPackage: { id: 'map', version: '1' },
        tokens: [{
          id: 'token-other-scene', actorId: 'actor-b', actorLink: true, actorDelta: null,
          placement: 'map', x: 90, y: 91, featureId: null, diameterMeters: 1,
          rotation: 0, elevationFt: 0, hidden: false, locked: false, showName: true, effects: [],
        }],
        markers: [], attackAreas: [], sceneEvents: [], settings: {},
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('Token Runtime creates independent Token ids and allows one Actor to have many Tokens', () => {
  const first = createSceneToken(world(), { actorId: 'actor-a', x: 1.5, y: 2.5 });
  assert.match(first.token.id, /^token-/);
  assert.notEqual(first.token.id, 'actor-a');
  assert.equal(first.token.actorId, 'actor-a');

  const second = createSceneToken(first.world, { actorId: 'actor-a', id: 'token-a-2', x: 3.5, y: 4.5 });
  assert.equal(listActiveSceneTokens(second.world).length, 2);
  assert.deepEqual(listActiveSceneTokens(second.world).map(token => token.actorId), ['actor-a', 'actor-a']);
});

test('Token movement writes Scene token placement without touching another Scene', () => {
  const created = createSceneToken(world(), { actorId: 'actor-a', id: 'token-a', x: 1, y: 2 });
  const moved = moveSceneToken(created.world, 'token-a', { x: 30.5, y: 40.5 });
  assert.deepEqual(
    { placement: moved.token.placement, x: moved.token.x, y: moved.token.y, featureId: moved.token.featureId },
    { placement: 'map', x: 30.5, y: 40.5, featureId: null },
  );
  assert.equal(moved.world.scenes[1].tokens[0].x, 90);
  assert.equal(moved.world.scenes[1].tokens[0].y, 91);
});

test('Token can move between map placement and feature placement', () => {
  const created = createSceneToken(world(), { actorId: 'actor-a', id: 'token-a', x: 1, y: 2 });
  const inside = placeSceneTokenInFeature(created.world, 'token-a', 'building-1');
  assert.deepEqual(
    { placement: inside.token.placement, x: inside.token.x, y: inside.token.y, featureId: inside.token.featureId },
    { placement: 'feature', x: null, y: null, featureId: 'building-1' },
  );
  const outside = moveSceneToken(inside.world, 'token-a', { x: 8, y: 9 });
  assert.deepEqual(
    { placement: outside.token.placement, x: outside.token.x, y: outside.token.y, featureId: outside.token.featureId },
    { placement: 'map', x: 8, y: 9, featureId: null },
  );
});

test('unlinked Token actorDelta survives movement and ordinary Token updates', () => {
  const created = createSceneToken(world(), {
    actorId: 'actor-a', id: 'npc-1', actorLink: false,
    actorDelta: { runtime: { health: { mode: 'simple', current: 7 } } },
  });
  const moved = moveSceneToken(created.world, 'npc-1', { x: 10, y: 11 });
  assert.equal(moved.token.actorLink, false);
  assert.equal(moved.token.actorDelta.runtime.health.current, 7);

  const hidden = updateSceneToken(moved.world, 'npc-1', { hidden: true, rotation: 90 });
  assert.equal(hidden.token.hidden, true);
  assert.equal(hidden.token.rotation, 90);
  assert.equal(hidden.token.actorDelta.runtime.health.current, 7);
});

test('Token Runtime rejects broken Actor/Token references and can remove a Token', () => {
  assert.throws(() => createSceneToken(world(), { actorId: 'missing' }), /Unknown Actor/);
  assert.throws(() => moveSceneToken(world(), 'missing', { x: 1, y: 1 }), /Unknown Token/);

  const created = createSceneToken(world(), { actorId: 'actor-a', id: 'token-a' });
  assert.ok(getActiveSceneToken(created.world, 'token-a'));
  const removed = removeSceneToken(created.world, 'token-a');
  assert.equal(removed.token.id, 'token-a');
  assert.equal(getActiveSceneToken(removed.world, 'token-a'), null);
});
