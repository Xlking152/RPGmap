import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport, normalizeEntityState } from '../src/entities/model.js';
import { resolveActor } from '../src/entities/resolver.js';

test('xlsx actors default to wound-track health while manual actors remain simple HP', () => {
  const base = {
    formName: '默认形态',
    identity: { name: '测试角色' },
    resources: { hp: { max: 20 }, stamina: { max: 10 }, willpower: { max: 5 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {},
  };
  const xlsx = createActorFromImport({ ...base, source: { type: 'xlsx' } });
  const manual = createActorFromImport({ ...base, source: { type: 'manual' } });
  assert.equal(resolveActor(xlsx).health.mode, 'wound-track');
  assert.equal(resolveActor(xlsx).health.healthy, 20);
  assert.equal(resolveActor(manual).health.mode, 'simple');
});

test('legacy xlsx actor without health runtime migrates missing simple HP to B wounds', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '旧角色' },
    resources: { hp: { max: 20 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'xlsx' },
  });
  delete actor.system.runtime.health;
  actor.system.runtime.resources.hp.current = 15;
  const state = normalizeEntityState({ actors: [actor], tokens: [] });
  const health = resolveActor(state.actors[0]).health;
  assert.equal(health.mode, 'wound-track');
  assert.equal(health.healthy, 15);
  assert.equal(health.bashing, 5);
});
