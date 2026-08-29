import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveActorDocument } from '../src/actor/index.js';
import { ChatStore } from '../src/chat/store.js';
import { CombatStore } from '../src/combat/store.js';
import { createCombat } from '../src/combat/model.js';
import { createHealthController } from '../src/health/controller.js';
import { createActorFromImport, createTokenForActor } from '../src/entities/model.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { createWorldSystem } from '../src/world/system.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: '测试地图', width: 100, height: 100 };

function resolveHealth(actor) {
  return deriveActorDocument(actor)?.health || null;
}

function createApi(state = { preferences: {}, characters: [] }) {
  const committed = [];
  const emitted = [];
  let current = structuredClone(state);
  return {
    mapPackage,
    ruleset: infiniteHorrorRuleset,
    getState: () => structuredClone(current),
    commitState(next, options) { current = structuredClone(next); committed.push({ state: current, options }); },
    importState() { throw new Error('ordinary mutations must not import the full World'); },
    persistNowCalls: 0,
    persistNow() { this.persistNowCalls += 1; },
    emit(type, detail) { emitted.push({ type, detail }); },
    get current() { return current; },
    committed,
    emitted,
  };
}

function healthState(actor) {
  return {
    saveVersion: 2,
    mapId: 'test-map',
    mapVersion: '1.0.0',
    markers: [],
    attackAreas: [],
    sceneEvents: [],
    characters: [],
    preferences: {
      gridVisible: true,
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: [],
        actors: [actor],
        tokens: [{
          ...createTokenForActor('actor-a', 'token-a'),
          placement: 'map',
          x: 1.5,
          y: 1.5,
        }],
      },
    },
  };
}

function registerHealthWorld(api) {
  createWorldSystem().register(api);
  createHealthController().register(api);
}

test('Combat and local chat commit World state without re-importing it', () => {
  const combatApi = createApi();
  const combatStore = new CombatStore(combatApi);
  combatStore.state.combat = createCombat([{ tokenId: 'token-a', actorId: 'actor-a' }]);
  combatStore.persist();
  assert.equal(combatApi.committed[0].options.source, 'combat');
  assert.equal(combatApi.current.preferences.combatSystem.combat.combatants.length, 1);

  const chatApi = createApi();
  const chatStore = new ChatStore(chatApi);
  chatStore.append({ type: 'combat', text: '进入战斗' });
  assert.equal(chatApi.committed[0].options.source, 'chat');
  assert.equal(chatApi.current.preferences.chatSystem.messages.length, 1);
});

test('health mutations commit and persist through canonical World operations', async () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '测试角色' },
    resources: { hp: { max: 10 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'manual' },
  }, { id: 'actor-a', formId: 'form-a' });
  const api = createApi(healthState(actor));
  registerHealthWorld(api);

  await api.health.applyDamageToTokenIds(['token-a'], { amount: 4, type: 'L' });
  const healed = await api.health.applyHealingToTokenIds(['token-a'], { amount: 2, type: 'L' });
  const savedActor = api.current.preferences.worldV2.actors[0];
  assert.equal(resolveHealth(savedActor).current, 8);
  assert.equal(healed[0].after.current, 8);
  assert.equal(api.persistNowCalls, 2);
  const healthCommits = api.committed.filter(entry => String(entry.options?.source || '').startsWith('health:'));
  assert.deepEqual(healthCommits.map(entry => entry.options.source), ['health:damage', 'health:healing']);
  assert.equal(api.emitted.filter(event => event.type === 'health:change').length, 2);
});

test('health B/L/A editor commits the same canonical World operation path as recovery', async () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '伤势编辑' },
    resources: { hp: { max: 10 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'xlsx' },
  }, { id: 'actor-a', formId: 'form-a' });
  const api = createApi(healthState(actor));
  registerHealthWorld(api);

  const result = await api.health.performActorOperation('actor-a', {
    type: 'set-wounds',
    wounds: { bashing: 2, lethal: 3, aggravated: 1 },
  });
  assert.equal(result.after.current, 4);
  assert.equal(resolveHealth(api.current.preferences.worldV2.actors[0]).current, 4);
  assert.equal(api.committed.at(-1).options.source, 'health:runtime');
  assert.equal(api.persistNowCalls, 1);
});
