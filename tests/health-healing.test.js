import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport } from '../src/entities/model.js';
import { deriveActorDocument, performActorOperation } from '../src/actor/index.js';

function resolveHealth(actor) {
  return deriveActorDocument(actor)?.health || null;
}

function applyDamage(actor, { amount, type }) {
  const result = performActorOperation(actor, { type: 'health.damage', amount, damageType: type });
  return { ...result, after: result.value || resolveHealth(actor) };
}

function applyHealing(actor, { amount, type }) {
  const result = performActorOperation(actor, { type: 'health.healing', amount, damageType: type });
  return { ...result, after: result.value || resolveHealth(actor) };
}

function editHealth(actor, operation) {
  const before = resolveHealth(actor);
  const result = performActorOperation(actor, { type: 'health.runtime', operation });
  return { ...result, before, after: result.value || before };
}

test('resolved wound healing restores the selected B/L/A slots to healthy', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '测试角色' },
    resources: { hp: { max: 20 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'xlsx' },
  });
  applyDamage(actor, { amount: 3, type: 'B' });
  applyDamage(actor, { amount: 4, type: 'L' });
  applyDamage(actor, { amount: 5, type: 'A' });
  const result = applyHealing(actor, { amount: 2, type: 'L' });
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
  applyDamage(actor, { amount: 6, type: 'A' });
  assert.equal(resolveHealth(actor).dead, true);
  const result = applyHealing(actor, { amount: 1, type: 'A' });
  assert.equal(result.blocked, 'dead');
  assert.equal(result.applied, 0);
  assert.equal(result.after.dead, true);
});

test('direct B/L/A editing is normalized by canonical Health Runtime', () => {
  const actor = createActorFromImport({
    formName: '默认形态', identity: { name: '直接编辑' },
    resources: { hp: { max: 10 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: {}, source: { type: 'xlsx' },
  });
  const result = editHealth(actor, {
    type: 'set-wounds',
    wounds: { bashing: 9, lethal: 6, aggravated: 4 },
  });
  assert.equal(result.changed, true);
  assert.deepEqual({ bashing: result.after.bashing, lethal: result.after.lethal, aggravated: result.after.aggravated }, { bashing: 0, lethal: 6, aggravated: 4 });
  assert.equal(result.after.healthy, 0);
  assert.equal(resolveHealth(actor).current, 0);
});
