import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport, normalizeEntityState } from '../src/entities/model.js';
import { resolveActor } from '../src/entities/resolver.js';
import { performActorOperation } from '../src/actor/index.js';

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
  assert.equal(resolveActor(manual).health.current, 20);
  assert.equal(xlsx.system.runtime.resources.hp, undefined);
  assert.equal(manual.system.runtime.resources.hp, undefined);
  assert.equal(manual.system.runtime.health.current, 20);
});

test('legacy xlsx actor without health runtime migrates HP current into B wounds and removes resource HP runtime', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '旧角色' },
    resources: { hp: { max: 20 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'xlsx' },
  });
  actor.system.schemaVersion = 1;
  delete actor.system.runtime.health;
  actor.system.runtime.resources.hp = { current: 15, maxOverride: null, policy: 'preserve' };
  const state = normalizeEntityState({ actors: [actor], tokens: [] });
  const migrated = state.actors[0];
  const health = resolveActor(migrated).health;
  assert.equal(health.mode, 'wound-track');
  assert.equal(health.healthy, 15);
  assert.equal(health.bashing, 5);
  assert.equal(migrated.system.runtime.resources.hp, undefined);
});

test('simple HP mutations write only Ruleset Health Runtime', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '普通生命角色' },
    resources: { hp: { max: 12 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'manual' },
  });
  const result = performActorOperation(actor, { type: 'resource.set-current', resourceId: 'hp', value: 7 });
  assert.equal(result.changed, true);
  assert.equal(resolveActor(actor).health.current, 7);
  assert.equal(actor.system.runtime.health.current, 7);
  assert.equal(actor.system.runtime.resources.hp, undefined);
});
