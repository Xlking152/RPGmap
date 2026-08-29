import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeActorDelta, mergeActorDeltaPatch, resolveTokenActor } from '../src/token/actor.js';

function baseActor() {
  return {
    id: 'actor-template',
    name: '普通士兵',
    system: {
      schemaVersion: 3,
      currentFormId: 'form-1',
      forms: [{
        id: 'form-1',
        healthBase: { baseMax: 10 },
        resourceBases: { stamina: { id: 'stamina', name: '精力', kind: 'stamina', baseMax: 6 } },
        attributes: [{ id: 'str', base: 5 }],
        source: { type: 'manual' },
      }],
      runtime: {
        resources: { stamina: { current: 6, maxOverride: null, policy: 'preserve' } },
        customResources: [],
        attributeAdjustments: {},
        badStatuses: {},
        health: { mode: 'simple', maxOverride: null, current: 10, wounds: { bashing: 0, lethal: 0, aggravated: 0 } },
      },
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
    actorDelta: { system: { runtime: { health: { current: 2 } } } },
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
      system: { runtime: { health: { current: 3 } } },
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
  assert.equal(source.actors[0].system.runtime.health.current, 10);
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
  const first = { system: { runtime: { health: { mode: 'simple', current: 4 } } } };
  const second = mergeActorDeltaPatch(first, {
    system: {
      runtime: {
        resources: { stamina: { current: 2 } },
        health: { current: 3 },
      },
    },
  });
  assert.equal(second.system.runtime.resources.stamina.current, 2);
  assert.equal(second.system.runtime.health.mode, 'simple');
  assert.equal(second.system.runtime.health.current, 3);
});

test('Synthetic Actor resolver rejects missing Token and missing Base Actor references', () => {
  assert.throws(() => resolveTokenActor(world(), 'missing'), /Unknown Token/);
  const broken = world();
  broken.scenes[0].tokens[0].actorId = 'missing-actor';
  assert.throws(() => resolveTokenActor(broken, 'token-1'), /missing Actor/);
});
