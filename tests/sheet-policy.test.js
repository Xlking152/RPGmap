import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultActor } from '../src/actor/model.js';
import { installActorSheetOpenPolicy } from '../src/entities/sheet-policy.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

function actor(type, id) {
  return createDefaultActor({ id, name: id, type, ruleset: infiniteHorrorRuleset });
}

function fakeApi() {
  const actors = [
    actor('pc', 'pc-1'),
    actor('monster', 'monster-1'),
    actor('npc', 'npc-1'),
    actor('summon', 'summon-1'),
  ];
  const calls = [];
  const tokens = new Map([
    ['token-monster', { id: 'token-monster', actorId: 'monster-1' }],
    ['token-npc', { id: 'token-npc', actorId: 'npc-1' }],
  ]);
  const api = {
    ruleset: infiniteHorrorRuleset,
    getState: () => ({ preferences: { entitySystem: { actors } } }),
    tokens: { get: id => tokens.get(String(id)) || null },
    entities: {
      openActor(actorId, tab) { calls.push(['actor', actorId, tab]); return true; },
      openToken(tokenId, tab) { calls.push(['token', tokenId, tab]); return true; },
      requestImport() { return true; },
    },
  };
  return { api, calls };
}

test('Actor sheet open policy applies per-kind Ruleset default tabs', () => {
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
