import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultActor } from '../src/actor/model.js';
import { installActorSheetOpenPolicy } from '../src/entities/sheet-policy.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

function actor(type, id) {
  return createDefaultActor({ id, name: id, type, ruleset: infiniteHorrorRuleset });
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function fakeApi() {
  const actors = [
    actor('pc', 'pc-1'),
    actor('monster', 'monster-1'),
    actor('npc', 'npc-1'),
    actor('summon', 'summon-1'),
  ];
  const calls = [];
  const storage = memoryStorage();
  const tokens = new Map([
    ['token-monster', { id: 'token-monster', actorId: 'monster-1' }],
    ['token-npc', { id: 'token-npc', actorId: 'npc-1' }],
  ]);
  const api = {
    ruleset: infiniteHorrorRuleset,
    getState: () => ({ preferences: { entitySystem: { actors } } }),
    world: { get: () => ({ id: 'world-test', activeSceneId: 'scene-a' }) },
    map: { getContainer: () => ({ ownerDocument: { defaultView: { localStorage: storage } } }) },
    tokens: { get: id => tokens.get(String(id)) || null },
    entities: {
      openActor(actorId, tab) { calls.push(['actor', actorId, tab]); return true; },
      openToken(tokenId, tab) { calls.push(['token', tokenId, tab]); return true; },
      requestImport() { return true; },
    },
  };
  return { api, calls, storage };
}

test('Actor sheet open policy applies per-kind Ruleset default tabs on first open', () => {
  const { api, calls } = fakeApi();
  installActorSheetOpenPolicy(api);

  api.entities.openActor('pc-1');
  api.entities.openActor('monster-1');
  api.entities.openActor('npc-1');
  api.entities.openActor('summon-1');

  assert.deepEqual(calls, [
    ['actor', 'pc-1', 'overview'],
    ['actor', 'monster-1', 'combat'],
    ['actor', 'npc-1', 'overview'],
    ['actor', 'summon-1', 'combat'],
  ]);
});

test('Token sheets inherit the base Actor card default while explicit tabs win', () => {
  const { api, calls } = fakeApi();
  installActorSheetOpenPolicy(api);

  api.entities.openToken('token-monster');
  api.entities.openToken('token-npc', 'status');
  api.entities.openActor('monster-1', 'overview');

  assert.deepEqual(calls, [
    ['token', 'token-monster', 'combat'],
    ['token', 'token-npc', 'status'],
    ['actor', 'monster-1', 'overview'],
  ]);
});

test('saved per-World window tabs outrank kind defaults without overriding explicit requests', () => {
  const { api, calls, storage } = fakeApi();
  storage.setItem('rpgmap.ui.actor-sheets.v1.world-test', JSON.stringify({
    version: 1,
    windows: {
      'actor:monster-1': { tab: 'status' },
      'scene:scene-a:token:token-monster': { tab: 'token' },
    },
  }));
  installActorSheetOpenPolicy(api);

  api.entities.openActor('monster-1');
  api.entities.openToken('token-monster');
  api.entities.openActor('monster-1', 'combat');

  assert.deepEqual(calls, [
    ['actor', 'monster-1', 'status'],
    ['token', 'token-monster', 'token'],
    ['actor', 'monster-1', 'combat'],
  ]);
});
