import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createActorTokenAtPoint,
  relocateActorTokenAtPoint,
  snapActorTokenPlacementPoint,
} from '../src/token/placement.js';

function api({ valid = true } = {}) {
  const calls = [];
  const tokens = new Map([
    ['token-existing', { id: 'token-existing', actorId: 'actor-7', x: 4.5, y: 5.5, placement: 'map' }],
  ]);
  return {
    calls,
    mapPackage: { width: 100, height: 80 },
    inspectTokenPlacement(characterId, point) {
      calls.push({ type: 'inspect', characterId, point });
      return { valid };
    },
    tokens: {
      get(tokenId) {
        return tokens.get(String(tokenId)) || null;
      },
      async create(options) {
        calls.push({ type: 'create', options });
        const token = { id: 'token-created', ...options };
        tokens.set(token.id, token);
        return token;
      },
      async move(tokenId, point) {
        calls.push({ type: 'move', tokenId, point });
        const current = tokens.get(String(tokenId));
        const token = { ...current, placement: 'map', featureId: null, ...point };
        tokens.set(String(tokenId), token);
        return token;
      },
    },
  };
}

test('Actor placement snaps the map click to the current 1 m cell centre', () => {
  assert.deepEqual(snapActorTokenPlacementPoint({ mapPackage: { width: 10, height: 8 } }, { x: 2.13, y: 7.91 }), {
    x: 2.5,
    y: 7.5,
  });
  assert.deepEqual(snapActorTokenPlacementPoint({ mapPackage: { width: 10, height: 8 } }, { x: -20, y: 99 }), {
    x: 0.5,
    y: 7.5,
  });
});

test('Actor placement writes through api.tokens.create with the existing Actor id', async () => {
  const runtime = api();
  const result = await createActorTokenAtPoint(runtime, 'actor-7', { x: 12.2, y: 18.8 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.point, { x: 12.5, y: 18.5 });
  assert.equal(result.token.id, 'token-created');
  assert.deepEqual(runtime.calls, [
    { type: 'inspect', characterId: null, point: { x: 12.5, y: 18.5 } },
    {
      type: 'create',
      options: {
        actorId: 'actor-7',
        x: 12.5,
        y: 18.5,
        actorLink: true,
        actorDelta: null,
        diameterMeters: 1,
        rotation: 0,
        elevationFt: 0,
        visibility: null,
        locked: false,
        showName: true,
        effects: [],
      },
    },
  ]);
});

test('blocked placement never creates a Scene Token', async () => {
  const runtime = api({ valid: false });
  const result = await createActorTokenAtPoint(runtime, 'actor-7', { x: 12.2, y: 18.8 });
  assert.equal(result.ok, false);
  assert.equal(result.token, null);
  assert.equal(runtime.calls.filter(call => call.type === 'create').length, 0);
});

test('Token repositioning validates while excluding itself and writes only through api.tokens.move', async () => {
  const runtime = api();
  const result = await relocateActorTokenAtPoint(runtime, 'token-existing', { x: 21.2, y: 31.9 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.point, { x: 21.5, y: 31.5 });
  assert.deepEqual(result.token, {
    id: 'token-existing', actorId: 'actor-7', placement: 'map', featureId: null, x: 21.5, y: 31.5,
  });
  assert.deepEqual(runtime.calls, [
    { type: 'inspect', characterId: 'token-existing', point: { x: 21.5, y: 31.5 } },
    { type: 'move', tokenId: 'token-existing', point: { x: 21.5, y: 31.5 } },
  ]);
});

test('blocked Token repositioning never calls api.tokens.move', async () => {
  const runtime = api({ valid: false });
  const result = await relocateActorTokenAtPoint(runtime, 'token-existing', { x: 21.2, y: 31.9 });
  assert.equal(result.ok, false);
  assert.equal(result.token, null);
  assert.equal(runtime.calls.filter(call => call.type === 'move').length, 0);
});
