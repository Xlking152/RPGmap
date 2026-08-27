import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { removeSceneToken } from '../src/token/model.js';
import {
  deleteCanonicalToken,
  listWorldActorTokens,
  removeActorAndTokensFromWorld,
} from '../src/entities/canonical-delete.js';
import { listFeatureTokenViews } from '../src/entities/feature-token-view.js';

function worldFixture() {
  return {
    schemaVersion: 2,
    id: 'world-test',
    activeSceneId: 'scene-a',
    actors: [
      { id: 'actor-a', name: '模板 A' },
      { id: 'actor-b', name: '模板 B' },
    ],
    scenes: [
      {
        id: 'scene-a',
        tokens: [
          { id: 'token-a1', actorId: 'actor-a', actorLink: true, placement: 'map', x: 12, y: 18, effects: [] },
          { id: 'token-b1', actorId: 'actor-b', actorLink: true, placement: 'map', x: 22, y: 28, effects: [] },
        ],
        attackAreas: [
          { id: 'area-a1', origin: { x: 1, y: 2 }, anchor: { type: 'character', characterId: 'token-a1' } },
          { id: 'area-b1', origin: { x: 3, y: 4 }, anchor: { type: 'character', characterId: 'token-b1' } },
        ],
      },
      {
        id: 'scene-b',
        tokens: [
          { id: 'token-a2', actorId: 'actor-a', actorLink: false, actorDelta: { name: '实例 A2' }, placement: 'feature', featureId: 'house-7', x: null, y: null, effects: [] },
        ],
        attackAreas: [
          { id: 'area-a2', origin: { x: 90, y: 91 }, anchor: { type: 'character', characterId: 'token-a2' } },
        ],
      },
    ],
  };
}

test('api.tokens.remove model operation detaches Token-bound attack areas atomically', () => {
  const result = removeSceneToken(worldFixture(), 'token-a1');
  const scene = result.world.scenes[0];
  assert.equal(result.token.id, 'token-a1');
  assert.deepEqual(scene.tokens.map(token => token.id), ['token-b1']);
  assert.deepEqual(scene.attackAreas[0].anchor, { type: 'free', markerId: null });
  assert.deepEqual(scene.attackAreas[0].origin, { x: 12, y: 18 });
  assert.deepEqual(scene.attackAreas[1].anchor, { type: 'character', characterId: 'token-b1' });
});

test('Actor deletion removes every canonical Scene Token before removing the World Actor', () => {
  const world = worldFixture();
  assert.deepEqual(listWorldActorTokens(world, 'actor-a').map(entry => [entry.sceneId, entry.token.id]), [
    ['scene-a', 'token-a1'],
    ['scene-b', 'token-a2'],
  ]);

  const result = removeActorAndTokensFromWorld(world, 'actor-a');
  assert.deepEqual(result.world.actors.map(actor => actor.id), ['actor-b']);
  assert.deepEqual(result.world.scenes[0].tokens.map(token => token.id), ['token-b1']);
  assert.deepEqual(result.world.scenes[1].tokens, []);
  assert.deepEqual(result.world.scenes[0].attackAreas[0].anchor, { type: 'free', markerId: null });
  assert.deepEqual(result.world.scenes[0].attackAreas[0].origin, { x: 12, y: 18 });
  assert.deepEqual(result.world.scenes[1].attackAreas[0].anchor, { type: 'free', markerId: null });
  assert.deepEqual(result.world.scenes[1].attackAreas[0].origin, { x: 90, y: 91 });
  assert.deepEqual(result.world.scenes[0].attackAreas[1].anchor, { type: 'character', characterId: 'token-b1' });
  assert.deepEqual(result.tokens.map(entry => entry.token.id), ['token-a1', 'token-a2']);
});

test('deleteCanonicalToken delegates only to api.tokens.remove and clears canonical selection', async () => {
  const calls = [];
  const api = {
    tokens: {
      get(id) { return id === 'token-a1' ? { id, actorId: 'actor-a' } : null; },
      async remove(id) { calls.push(['remove', id]); return { id, actorId: 'actor-a' }; },
    },
    selection: { remove(ids) { calls.push(['selection', ids]); } },
  };
  const removed = await deleteCanonicalToken(api, 'token-a1');
  assert.equal(removed.id, 'token-a1');
  assert.deepEqual(calls, [['remove', 'token-a1'], ['selection', ['token-a1']]]);
});

test('Feature occupant views use canonical Token placement and resolved Synthetic Actor display', () => {
  const tokens = [
    { id: 'token-a', actorId: 'actor-a', actorLink: true, placement: 'feature', featureId: 'house-7' },
    { id: 'token-b', actorId: 'actor-a', actorLink: false, placement: 'feature', featureId: 'house-7' },
    { id: 'token-c', actorId: 'actor-c', actorLink: true, placement: 'map', x: 1, y: 2 },
  ];
  const api = {
    tokens: {
      list: () => structuredClone(tokens),
      resolveActor(tokenId) {
        if (tokenId === 'token-b') return {
          actor: { id: 'actor-a', name: '独立实例', currentFormId: 'f2', forms: [{ id: 'f2', avatarDataUrl: 'data:image/png;base64,B', tokenAppearance: { color: '#222222' } }] },
          baseActor: { id: 'actor-a', name: '模板角色' },
          synthetic: true,
        };
        return {
          actor: { id: tokenId === 'token-a' ? 'actor-a' : 'actor-c', name: tokenId === 'token-a' ? '模板角色' : '其他角色', currentFormId: 'f1', forms: [{ id: 'f1', avatarDataUrl: null, tokenAppearance: { color: '#111111' } }] },
          baseActor: null,
          synthetic: false,
        };
      },
    },
  };

  const views = listFeatureTokenViews(api, 'house-7');
  assert.deepEqual(views.map(view => view.token.id), ['token-a', 'token-b']);
  assert.equal(views[1].name, '独立实例');
  assert.equal(views[1].synthetic, true);
  assert.equal(views[1].avatarDataUrl, 'data:image/png;base64,B');
});

test('Entity controller deletion and Feature bridge have no Character-storage mutation dependency', async () => {
  const deleteCore = await readFile(new URL('../src/entities/canonical-delete.js', import.meta.url), 'utf8');
  const controller = await readFile(new URL('../src/entities/token-controller.js', import.meta.url), 'utf8');
  const entityUi = await readFile(new URL('../src/entities/ui.js', import.meta.url), 'utf8');
  const entityIndex = await readFile(new URL('../src/entities/index.js', import.meta.url), 'utf8');
  const featureView = await readFile(new URL('../src/entities/feature-token-view.js', import.meta.url), 'utf8');
  const featureUi = await readFile(new URL('../src/entities/feature-token-ui.js', import.meta.url), 'utf8');

  assert.match(deleteCore, /api\.tokens\.remove\(/);
  assert.match(deleteCore, /api\.world\.commit\(/);
  assert.doesNotMatch(deleteCore, /deleteCharacter|character:delete|state\.characters|preferences\.entitySystem|\.removeToken\(|\.removeActor\(/);
  assert.match(controller, /deleteCanonicalToken\(api, target\)/);
  assert.match(controller, /deleteCanonicalActor\(api, target\)/);
  assert.doesNotMatch(controller, /api\.deleteCharacter|store\.removeToken|store\.removeActor|commitState\(|importState\(|state\.characters|character:delete/);
  assert.doesNotMatch(entityUi, /api\.deleteCharacter|store\.removeToken|store\.removeActor|character:delete|character:create|character:move/);
  assert.doesNotMatch(entityIndex, /token-delete-ui|token-read-ui|withCanonicalEntityTokenReadView/);
  assert.match(featureView, /api\.tokens\.list\(\)/);
  assert.match(featureView, /api\.tokens\.resolveActor\(/);
  assert.doesNotMatch(featureView, /state\.characters|preferences\.entitySystem/);
  assert.doesNotMatch(featureUi, /state\.characters|preferences\.entitySystem/);
});
