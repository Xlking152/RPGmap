import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport } from '../src/entities/model.js';
import { createHealthController } from '../src/health/controller.js';
import { createTokenRuntimeSystem } from '../src/token/system.js';
import { createWorldSystem } from '../src/world/system.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: '测试地图', width: 100, height: 100 };

function actor() {
  return createActorFromImport({
    formName: '默认形态',
    identity: { name: '士兵模板' },
    resources: { hp: { max: 10 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [],
    combat: { attacks: [], defenses: [] }, tokenAppearance: { color: '#333333', scale: 1 },
    source: { type: 'manual' },
  }, { id: 'actor-template', formId: 'form-template' });
}

function fixture() {
  let current = {
    saveVersion: 2, mapId: 'test-map', mapVersion: '1.0.0',
    markers: [], attackAreas: [], sceneEvents: [], characters: [],
    preferences: {
      gridVisible: true,
      entitySystem: { schemaVersion: 3, statusDefinitions: [], actors: [actor()], tokens: [] },
    },
  };
  const api = {
    mapPackage,
    getState() { return structuredClone(current); },
    commitState(next) { current = structuredClone(next); return true; },
    importState(next) { current = structuredClone(next); return true; },
    persistNow() {},
    emit() {},
  };
  createWorldSystem().register(api);
  createTokenRuntimeSystem().register(api);
  createHealthController().register(api);
  return { api, state: () => structuredClone(current) };
}

test('damage to one unlinked Token writes actorDelta and leaves its Base Actor and sibling untouched', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-a', actorLink: false, x: 1, y: 1 });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-b', actorLink: false, x: 2, y: 2 });

  const results = api.health.applyDamageToTokenIds(['npc-a'], { amount: 3, type: 'L' });
  assert.equal(results.length, 1);
  assert.equal(results[0].synthetic, true);
  assert.equal(api.health.resolveToken('npc-a').current, 7);
  assert.equal(api.health.resolveToken('npc-b').current, 10);
  assert.equal(api.health.resolveActor('actor-template').current, 10);

  const damagedToken = api.tokens.get('npc-a');
  assert.equal(damagedToken.actorLink, false);
  assert.equal(damagedToken.actorDelta.runtime.resources.hp.current, 7);
});

test('two unlinked Tokens sharing one template take damage independently', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-a', actorLink: false });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-b', actorLink: false });

  const results = api.health.applyDamageToTokenIds(['npc-a', 'npc-b'], { amount: 2 });
  assert.equal(results.length, 2);
  assert.equal(api.health.resolveToken('npc-a').current, 8);
  assert.equal(api.health.resolveToken('npc-b').current, 8);
  assert.equal(api.health.resolveActor('actor-template').current, 10);
});

test('linked Tokens still share the World Actor and selected duplicates only apply damage once', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'pc-a', actorLink: true });
  await api.tokens.create({ actorId: 'actor-template', id: 'pc-b', actorLink: true });

  const results = api.health.applyDamageToTokenIds(['pc-a', 'pc-b'], { amount: 2 });
  assert.equal(results.length, 1);
  assert.equal(results[0].synthetic, false);
  assert.equal(api.health.resolveActor('actor-template').current, 8);
  assert.equal(api.health.resolveToken('pc-a').current, 8);
  assert.equal(api.health.resolveToken('pc-b').current, 8);
});

test('healing an unlinked Token updates only that Token delta', async () => {
  const { api } = fixture();
  await api.tokens.create({
    actorId: 'actor-template', id: 'npc-a', actorLink: false,
    actorDelta: {
      runtime: {
        resources: { hp: { current: 4 } },
        health: { mode: 'simple' },
      },
    },
  });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-b', actorLink: false });

  const results = api.health.applyHealingToTokenIds(['npc-a'], { amount: 3 });
  assert.equal(results.length, 1);
  assert.equal(results[0].synthetic, true);
  assert.equal(api.health.resolveToken('npc-a').current, 7);
  assert.equal(api.health.resolveToken('npc-b').current, 10);
  assert.equal(api.health.resolveActor('actor-template').current, 10);
});
