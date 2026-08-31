import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport } from '../src/entities/model.js';
import { createHealthController } from '../src/health/controller.js';
import { createTokenRuntimeSystem } from '../src/token/system.js';
import { createWorldSystem } from '../src/world/system.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

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
    ruleset: infiniteHorrorRuleset,
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

  const results = await api.health.applyDamageToTokenIds(['npc-a'], { amount: 3, type: 'L' });
  assert.equal(results.length, 1);
  assert.equal(results[0].synthetic, true);
  assert.equal(api.health.resolveToken('npc-a').current, 7);
  assert.equal(api.health.resolveToken('npc-b').current, 10);
  assert.equal(api.health.resolveActor('actor-template').current, 10);

  const damagedToken = api.tokens.get('npc-a');
  assert.equal(damagedToken.actorLink, false);
  assert.equal(damagedToken.actorDelta.system.runtime.health.current, 7);
  assert.equal(damagedToken.actorDelta.system.runtime.resources?.hp, undefined);
});

test('two unlinked Tokens sharing one template take damage independently', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-a', actorLink: false });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-b', actorLink: false });

  const results = await api.health.applyDamageToTokenIds(['npc-a', 'npc-b'], { amount: 2 });
  assert.equal(results.length, 2);
  assert.equal(api.health.resolveToken('npc-a').current, 8);
  assert.equal(api.health.resolveToken('npc-b').current, 8);
  assert.equal(api.health.resolveActor('actor-template').current, 10);
});

test('linked Tokens share the World Actor while each selected Token is settled independently', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'pc-a', actorLink: true });
  await api.tokens.create({ actorId: 'actor-template', id: 'pc-b', actorLink: true });

  const results = await api.health.applyDamageToTokenIds(['pc-a', 'pc-b'], { amount: 2 });
  assert.equal(results.length, 2);
  assert.equal(results.every(result => result.synthetic === false), true);
  assert.equal(api.health.resolveActor('actor-template').current, 6);
  assert.equal(api.health.resolveToken('pc-a').current, 6);
  assert.equal(api.health.resolveToken('pc-b').current, 6);
});

test('healing an unlinked Token updates only that Token delta', async () => {
  const { api } = fixture();
  await api.tokens.create({
    actorId: 'actor-template', id: 'npc-a', actorLink: false,
    actorDelta: {
      system: {
        runtime: {
          health: { mode: 'simple', current: 4 },
        },
      },
    },
  });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-b', actorLink: false });

  const results = await api.health.applyHealingToTokenIds(['npc-a'], { amount: 3 });
  assert.equal(results.length, 1);
  assert.equal(results[0].synthetic, true);
  assert.equal(api.health.resolveToken('npc-a').current, 7);
  assert.equal(api.health.resolveToken('npc-b').current, 10);
  assert.equal(api.health.resolveActor('actor-template').current, 10);
});

test('instance sheet Health operations target the selected Token instead of its template', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-a', actorLink: false });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-b', actorLink: false });

  const result = await api.health.performActorOperation(
    'actor-template',
    { type: 'set-current', value: 3 },
    { tokenId: 'npc-a' },
  );

  assert.equal(result.changed, true);
  assert.equal(api.health.resolveToken('npc-a').current, 3);
  assert.equal(api.health.resolveToken('npc-b').current, 10);
  assert.equal(api.health.resolveActor('actor-template').current, 10);
});

test('mixed linked and Synthetic health changes commit as one atomic World batch', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'pc-a', actorLink: true });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-a', actorLink: false });

  const calls = [];
  const original = api.world.performOperations.bind(api.world);
  api.world.performOperations = async (operations, options) => {
    calls.push({ operations: structuredClone(operations), options: structuredClone(options) });
    return original(operations, options);
  };

  const results = await api.health.applyDamageToTokenIds(['pc-a', 'npc-a'], { amount: 2 });
  assert.equal(results.length, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].operations.map(operation => operation.type), [
    'actor.runtime.perform',
    'actor.runtime.perform',
  ]);
  assert.equal(calls[0].options.kind, 'health');
  assert.equal(api.health.resolveActor('actor-template').current, 8);
  assert.equal(api.health.resolveToken('npc-a').current, 8);
});


test('rejected Health World batch leaves canonical Actor and Token state untouched', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'pc-a', actorLink: true });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-a', actorLink: false });

  const emitted = [];
  api.emit = (type, detail) => emitted.push({ type, detail });
  api.world.performOperations = async () => {
    throw Object.assign(new Error('conflict'), { code: 'world_state_stale' });
  };

  await assert.rejects(
    api.health.applyDamageToTokenIds(['pc-a', 'npc-a'], { amount: 3 }),
    error => error?.code === 'world_state_stale',
  );
  assert.equal(api.health.resolveActor('actor-template').current, 10);
  assert.equal(api.health.resolveToken('pc-a').current, 10);
  assert.equal(api.health.resolveToken('npc-a').current, 10);
  assert.equal(emitted.some(event => event.type === 'health:change'), false);
});
