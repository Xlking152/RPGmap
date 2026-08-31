import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateTestWorldToV3 } from './helpers/world-v3.js';
import { applySyntheticActorStatusOperation } from '../src/token/synthetic-status.js';
import { resolveTokenActor } from '../src/token/actor.js';
import { createTokenStatusBridgeSystem } from '../src/token/status-bridge.js';
import { resolveStatuses } from '../src/status/model.js';
import { assertWorldV2 } from '../deployment/local-server/world-v2.mjs';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';

function actor() {
  return {
    id: 'actor-soldier',
    name: '普通士兵模板',
    currentFormId: 'form-1',
    forms: [{
      id: 'form-1',
      resourceBases: { hp: { baseMax: 10 } },
      badStatuses: [],
    }],
    runtime: {
      resources: { hp: { current: 10, maxOverride: null } },
      badStatuses: {},
      health: { mode: 'simple' },
    },
    effects: [],
  };
}

function token(id) {
  return {
    id,
    actorId: 'actor-soldier',
    actorLink: false,
    actorDelta: null,
    placement: 'map',
    x: id === 'npc-a' ? 10 : 20,
    y: 30,
    featureId: null,
    diameterMeters: 1,
    rotation: 0,
    elevationFt: 0,
    hidden: false,
    locked: false,
    showName: true,
    effects: [],
  };
}

function world() {
  return {
    schemaVersion: 2,
    id: 'world-test',
    name: 'Synthetic status test',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    actors: [actor()],
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
    activeSceneId: 'scene-test',
    scenes: [{
      id: 'scene-test',
      name: 'Test',
      mapPackage: { id: 'default-map', version: '1' },
      tokens: [token('npc-a'), token('npc-b')],
      markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true },
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function statusSnapshot(worldState, tokenId) {
  const resolved = resolveTokenActor(worldState, tokenId);
  const state = {
    schemaVersion: 3,
    statusDefinitions: worldState.statusDefinitions,
    actors: [resolved.actor],
    tokens: [],
  };
  return resolveStatuses(state, { actorId: resolved.actor.id });
}

test('Synthetic Actor status mutates one unlinked Token without changing template or sibling', () => {
  const base = world();
  const applied = applySyntheticActorStatusOperation(base, {
    type: 'status.apply',
    scope: 'syntheticActor',
    targetId: 'npc-a',
    definitionId: 'status-rooted',
  }, { idFactory: () => 'effect-rooted-a', now: '2026-01-01T00:00:01.000Z' });

  assert.deepEqual(base.actors[0].effects, []);
  assert.equal(base.scenes[0].tokens[0].actorDelta, null);
  assert.equal(base.scenes[0].tokens[1].actorDelta, null);
  assert.equal(applied.world.actors[0].effects.length, 0);
  assert.equal(applied.world.scenes[0].tokens[1].actorDelta, null);
  assert.equal(applied.world.scenes[0].tokens[0].actorDelta.effects[0].definitionId, 'status-rooted');

  const a = statusSnapshot(applied.world, 'npc-a');
  const b = statusSnapshot(applied.world, 'npc-b');
  assert.equal(a.actorStatuses.some(status => status.definitionId === 'status-rooted'), true);
  assert.equal(a.capabilities.canMove, false);
  assert.equal(b.actorStatuses.some(status => status.definitionId === 'status-rooted'), false);
});

test('removing a Synthetic Actor status drops only the instance override', () => {
  const applied = applySyntheticActorStatusOperation(world(), {
    type: 'status.apply', targetId: 'npc-a', definitionId: 'status-rooted',
  }, { idFactory: () => 'effect-rooted-a' });
  const removed = applySyntheticActorStatusOperation(applied.world, {
    type: 'status.remove', targetId: 'npc-a', definitionId: 'status-rooted',
  });
  assert.equal(statusSnapshot(removed.world, 'npc-a').actorStatuses.length, 0);
  assert.deepEqual(removed.world.actors[0].effects, []);
});

test('World V2 server validator accepts legal actorDelta effects and rejects forged references', () => {
  const applied = applySyntheticActorStatusOperation(world(), {
    type: 'status.apply', targetId: 'npc-a', definitionId: 'status-rooted',
  }, { idFactory: () => 'effect-rooted-a' });
  const canonical = migrateTestWorldToV3(applied.world);
  assert.doesNotThrow(() => assertWorldV2(canonical));

  const forged = structuredClone(canonical);
  forged.scenes[0].tokens[0].actorDelta.effects[0].definitionId = 'status-does-not-exist';
  assert.throws(() => assertWorldV2(forged), /references missing definition/);
});

test('Status bridge waits for World commit when applying a Synthetic Actor status', async () => {
  let current = world();
  let commitCount = 0;
  const api = {
    world: {
      get: () => structuredClone(current),
      async commit(next) {
        commitCount += 1;
        current = structuredClone(next);
        return current;
      },
    },
    getState() {
      const resolvedWorld = structuredClone(current);
      return {
        preferences: {
          entitySystem: {
            schemaVersion: 3,
            statusDefinitions: resolvedWorld.statusDefinitions,
            actors: resolvedWorld.actors,
            tokens: resolvedWorld.scenes[0].tokens.map(item => ({
              ...structuredClone(item), characterId: item.id,
            })),
          },
        },
      };
    },
    tokens: {
      resolveActor(tokenId) { return resolveTokenActor(current, tokenId); },
    },
    status: {
      resolve(context = {}) {
        const tokenId = context.tokenId;
        if (!tokenId) return resolveStatuses({ schemaVersion: 3, statusDefinitions: [], actors: current.actors, tokens: [] }, context);
        return statusSnapshot(current, tokenId);
      },
      resolveCapabilities(context = {}) { return this.resolve(context).capabilities; },
      has(context = {}, definitionId) { return this.resolve(context).statuses.some(status => status.definitionId === definitionId); },
      apply() { throw new Error('base apply should not receive syntheticActor'); },
      remove() { throw new Error('base remove should not receive syntheticActor'); },
      setStacks() { throw new Error('base setStacks should not receive syntheticActor'); },
      setEnabled() { throw new Error('base setEnabled should not receive syntheticActor'); },
      setNote() { throw new Error('base setNote should not receive syntheticActor'); },
      applyBatch() { throw new Error('base batch should not receive syntheticActor'); },
    },
    multiplayer: { getStatus: () => ({ connected: true }) },
    emit() {},
  };

  createTokenStatusBridgeSystem().register(api);
  const result = await api.status.applyToTokenActor('npc-a', 'status-rooted');
  assert.equal(commitCount, 1);
  assert.equal(result.confirmed, true);
  assert.equal(statusSnapshot(current, 'npc-a').capabilities.canMove, false);
  assert.equal(statusSnapshot(current, 'npc-b').capabilities.canMove, true);
});
