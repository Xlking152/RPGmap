import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveActorDocument } from '../src/actor/index.js';
import { ChatStore } from '../src/chat/store.js';
import { CombatStore } from '../src/combat/store.js';
import { createCombat } from '../src/combat/model.js';
import { createHealthController } from '../src/health/controller.js';
import { createActorFromImport, createTokenForActor } from '../src/entities/model.js';

function resolveHealth(actor) {
  return deriveActorDocument(actor)?.health || null;
}

function createApi(state = { preferences: {}, characters: [] }) {
  const committed = [];
  const emitted = [];
  let current = structuredClone(state);
  return {
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

test('health mutations commit and synchronously persist the updated Actor state', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '测试角色' },
    resources: { hp: { max: 10 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'manual' },
  }, { id: 'actor-a', formId: 'form-a' });
  const api = createApi({
    characters: [{ id: 'token-a', location: { type: 'map', x: 1.5, y: 1.5 } }],
    preferences: { entitySystem: { schemaVersion: 2, actors: [actor], tokens: [createTokenForActor('actor-a', 'token-a')] } },
  });
  createHealthController().register(api);

  api.health.applyDamageToTokenIds(['token-a'], { amount: 4, type: 'L' });
  const healed = api.health.applyHealingToTokenIds(['token-a'], { amount: 2, type: 'L' });
  const savedActor = api.current.preferences.entitySystem.actors[0];
  assert.equal(resolveHealth(savedActor).current, 8);
  assert.equal(healed[0].after.current, 8);
  assert.equal(api.persistNowCalls, 2);
  assert.ok(api.committed.every(entry => entry.options.source === 'health'));
  assert.equal(api.emitted.filter(event => event.type === 'health:change').length, 2);
});

test('health B/L/A editor commits the same World path as recovery', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '伤势编辑' },
    resources: { hp: { max: 10 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'xlsx' },
  }, { id: 'actor-a', formId: 'form-a' });
  const api = createApi({
    characters: [{ id: 'token-a', location: { type: 'map', x: 1.5, y: 1.5 } }],
    preferences: { entitySystem: { schemaVersion: 2, actors: [actor], tokens: [createTokenForActor('actor-a', 'token-a')] } },
  });
  createHealthController().register(api);

  const result = api.health.performActorOperation('actor-a', {
    type: 'set-wounds',
    wounds: { bashing: 2, lethal: 3, aggravated: 1 },
  });
  assert.equal(result.after.current, 4);
  assert.equal(resolveHealth(api.current.preferences.entitySystem.actors[0]).current, 4);
  assert.equal(api.committed.at(-1).options.source, 'health');
  assert.equal(api.persistNowCalls, 1);
});
