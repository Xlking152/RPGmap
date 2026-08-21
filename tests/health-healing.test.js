import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport } from '../src/entities/model.js';
import { applyDamageToActor, applyHealingToActor, resolveActorHealth } from '../src/health/actor.js';

test('resolved wound healing restores the selected B/L/A slots to healthy', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '测试角色' },
    resources: { hp: { max: 20 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'xlsx' },
  });
  applyDamageToActor(actor, { amount: 3, type: 'B' });
  applyDamageToActor(actor, { amount: 4, type: 'L' });
  applyDamageToActor(actor, { amount: 5, type: 'A' });
  const result = applyHealingToActor(actor, { amount: 2, type: 'L' });
  assert.equal(result.applied, 2);
  assert.equal(result.after.healthy, 10);
  assert.equal(result.after.bashing, 3);
  assert.equal(result.after.lethal, 2);
  assert.equal(result.after.aggravated, 5);
});

test('ordinary wound healing does not replace resurrection after all slots become A', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '死亡角色' },
    resources: { hp: { max: 6 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'xlsx' },
  });
  applyDamageToActor(actor, { amount: 6, type: 'A' });
  assert.equal(resolveActorHealth(actor).dead, true);
  const result = applyHealingToActor(actor, { amount: 1, type: 'A' });
  assert.equal(result.blocked, 'dead');
  assert.equal(result.applied, 0);
  assert.equal(result.after.dead, true);
});
