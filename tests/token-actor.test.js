import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeActorDelta, mergeActorDeltaPatch, resolveTokenActor } from '../src/token/actor.js';

function baseActor() {
  return {
    id: 'actor-template',
    name: '普通士兵',
    currentFormId: 'form-1',
    forms: [{
      id: 'form-1',
      resourceBases: {
        hp: { id: 'hp', name: '生命', kind: 'hp', baseMax: 10 },
        stamina: { id: 'stamina', name: '精力', kind: 'stamina', baseMax: 6 },
      },
      attributes: [{ id: 'str', base: 5 }],
      source: { type: 'manual' },
    }],
    runtime: {
      resources: {
        hp: { current: 10, maxOverride: null },
        stamina: { current: 6, maxOverride: null },
      },
      health: { mode: 'simple', current: 10 },
    },
    effects: [{ id: 'base-effect', enabled: true }],
  };
}

function world({ actorLink = true, actorDelta = null } = {}) {
  return {
    id: 'world',
    activeSceneId: 'scene',
    actors: [baseActor()],
    scenes: [{
      id: 'scene',
      tokens: [{
        id: 'token-1', actorId: 'actor-template', actorLink, actorDelta,
        placement: 'map', x: 1, y: 2, effects: [],
      }],
    }],
  };
}

test('linked Token resolves the World Actor and ignores dormant actorDelta', () => {
  const result = resolveTokenActor(world({
    actorLink: true,
    actorDelta: { runtime: { resources: { hp: { current: 2 } } } },
  }), 'token-1');
  assert.equal(result.synthetic, false);
  assert.equal(result.actorLink, true);
  assert.equal(result.actor.system.runtime.health.current, 10);
  assert.equal(result.actor.system.runtime.resources.hp, undefined);
});

test('unlinked Token resolves Base Actor + actorDelta without mutating the template', () => {
  const source = world({
    actorLink: false,
    actorDelta: {
      name: '士兵 A',
      runtime: {
        resources: { hp: { current: 3 } },
        health: { current: 3 },
      },
    },
  });
  const result = resolveTokenActor(source, 'token-1');
  assert.equal(result.synthetic, true);
  assert.equal(result.actor.name, '士兵 A');
  assert.equal(result.actor.system.runtime.health.current, 3);
  assert.equal(result.actor.system.runtime.resources.hp, undefined);
  assert.equal(result.actor.system.runtime.resources.stamina.current, 6);
  assert.equal(result.actor.system.runtime.health.mode, 'simple');
  assert.equal(result.actor.id, 'actor-template');
  assert.equal(source.actors[0].runtime.resources.hp.current, 10);
});

test('actorDelta cannot rebind the synthetic Actor id and arrays use replacement semantics', () => {
  const actor = mergeActorDelta(baseActor(), {
    id: 'forged-id',
    effects: [{ id: 'instance-effect', enabled: true }],
  });
  assert.equal(actor.id, 'actor-template');
  assert.deepEqual(actor.effects, [{ id: 'instance-effect', enabled: true }]);
});

test('actorDelta patches merge deeply for independent runtime changes', () => {
  const first = { runtime: { resources: { hp: { current: 4 } } } };
  const second = mergeActorDeltaPatch(first, {
    runtime: {
      resources: { stamina: { current: 2 } },
      health: { mode: 'simple', current: 4 },
    },
  });
  assert.equal(second.runtime.resources.hp.current, 4);
  assert.equal(second.runtime.resources.stamina.current, 2);
  assert.equal(second.runtime.health.current, 4);
});

test('Synthetic Actor resolver rejects missing Token and missing Base Actor references', () => {
  assert.throws(() => resolveTokenActor(world(), 'missing'), /Unknown Token/);
  const broken = world();
  broken.scenes[0].tokens[0].actorId = 'missing-actor';
  assert.throws(() => resolveTokenActor(broken, 'token-1'), /missing Actor/);
});
