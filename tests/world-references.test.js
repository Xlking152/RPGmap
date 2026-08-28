import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';
import { createWorldSystem } from '../src/world/system.js';
import { activeWorldScene } from '../src/world/model.js';
import { pruneProjectedWorldReferences } from '../src/world/references.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: '测试地图' };

function actor(id, name) {
  return {
    id, name, currentFormId: `${id}-form`,
    forms: [{ id: `${id}-form`, tokenAppearance: { color: '#3d9b63' }, avatarDataUrl: null }],
    runtime: {}, effects: [],
  };
}

function projectedState() {
  return {
    saveVersion: 2,
    mapId: 'test-map',
    mapVersion: '1.0.0',
    markers: [], attackAreas: [], sceneEvents: [],
    characters: [
      { id: 'token-a', name: 'A', color: '#3d9b63', visible: true, location: { type: 'map', x: 1.5, y: 2.5 } },
      { id: 'token-b', name: 'B', color: '#3d9b63', visible: true, location: { type: 'map', x: 3.5, y: 4.5 } },
    ],
    preferences: {
      gridVisible: true,
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: [],
        actors: [actor('actor-a', 'A'), actor('actor-b', 'B')],
        tokens: [
          { id: 'token-a', characterId: 'token-a', actorId: 'actor-a', diameterMeters: 1, effects: [] },
          { id: 'token-b', characterId: 'token-b', actorId: 'actor-b', diameterMeters: 1, effects: [] },
        ],
      },
      combatSystem: {
        schemaVersion: 1,
        combat: {
          id: 'combat-1', state: 'active', round: 2, turnIndex: 0,
          combatants: [
            { id: 'combatant-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 20, order: 0 },
            { id: 'combatant-b', tokenId: 'token-b', actorId: 'actor-b', initiative: 10, order: 1 },
          ],
        },
      },
    },
  };
}

test('projected World reference cleanup removes only dangling Combat participants', () => {
  const state = projectedState();
  state.characters = state.characters.filter(character => character.id !== 'token-a');
  state.preferences.entitySystem.tokens = state.preferences.entitySystem.tokens.filter(token => token.id !== 'token-a');

  const pruned = pruneProjectedWorldReferences(state);
  const combat = pruned.preferences.combatSystem.combat;
  assert.deepEqual(combat.combatants.map(item => item.tokenId), ['token-b']);
  assert.equal(combat.turnIndex, 0);
  assert.equal(combat.round, 2);
  assert.equal(pruned.preferences.entitySystem.actors.length, 2);
});

test('projected World reference cleanup clears Combat when no participants remain', () => {
  const state = projectedState();
  state.characters = [];
  state.preferences.entitySystem.tokens = [];
  state.preferences.entitySystem.actors = [];

  const pruned = pruneProjectedWorldReferences(state);
  assert.equal(pruned.preferences.combatSystem.combat, null);
});

test('api.world.commit prunes missing Token combatants before authoritative adapter sees payload', async () => {
  let current = projectedState();
  let authoritativePayload = null;
  const api = {
    mapPackage,
    ruleset: infiniteHorrorRuleset,
    getState() { return structuredClone(current); },
    commitState(next) { current = structuredClone(next); return true; },
    async commitAuthoritativeState(next) {
      authoritativePayload = structuredClone(next);
      current = structuredClone(next);
      return { confirmed: true };
    },
    importState(next) { current = structuredClone(next); return true; },
    emit() {},
  };

  createWorldSystem().register(api);
  const world = api.world.get();
  const scene = activeWorldScene(world);
  scene.tokens = scene.tokens.filter(token => token.id !== 'token-a');

  await api.world.commit(world, { source: 'token-v2:remove', reason: 'token.remove' });

  assert.ok(authoritativePayload);
  assert.deepEqual(authoritativePayload.preferences.entitySystem.tokens.map(token => token.id), ['token-b']);
  assert.deepEqual(authoritativePayload.preferences.combatSystem.combat.combatants.map(item => item.tokenId), ['token-b']);
  assert.doesNotThrow(() => assertWorldState(structuredClone(authoritativePayload)));
});

test('WorldSystem source prunes projected references before authoritative commit', async () => {
  const source = await readFile(new URL('../src/world/system.js', import.meta.url), 'utf8');
  const pruneIndex = source.indexOf('pruneProjectedWorldReferences(');
  const authorityIndex = source.indexOf('coreCommitAuthoritativeState(projected');
  assert.ok(pruneIndex >= 0, 'WorldSystem must prune projected references');
  assert.ok(authorityIndex > pruneIndex, 'referential cleanup must happen before authority validation');
});
