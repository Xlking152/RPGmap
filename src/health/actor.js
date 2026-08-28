import { deriveActorDocument, performActorOperation } from '../actor/index.js';

export function ensureActorHealth(actor, context = {}) {
  return resolveActorHealth(actor, context);
}

export function resolveActorHealth(actor, context = {}) {
  return deriveActorDocument(actor, context)?.health || null;
}

export function setActorHealthMode(actor, mode, context = {}) {
  const result = performActorOperation(actor, { type: 'health.set-mode', mode }, context);
  return result.value || resolveActorHealth(actor, context);
}

export function performActorHealthOperation(actor, operation = {}, context = {}) {
  const before = resolveActorHealth(actor, context);
  const result = performActorOperation(actor, { type: 'health.runtime', operation }, context);
  return {
    before,
    after: result.value || before,
    changed: result.changed,
    blocked: result.blocked || null,
  };
}

export function applyDamageToActor(actor, { amount = 0, type } = {}, context = {}) {
  const result = performActorOperation(actor, {
    type: 'health.damage',
    amount,
    damageType: type,
  }, context);
  return {
    before: result.before || null,
    after: result.value || resolveActorHealth(actor, context),
    applied: result.applied || 0,
    overflow: result.overflow || 0,
    blocked: result.blocked || null,
  };
}

export function applyHealingToActor(actor, { amount = 0, type } = {}, context = {}) {
  const result = performActorOperation(actor, {
    type: 'health.healing',
    amount,
    damageType: type,
  }, context);
  return {
    before: result.before || null,
    after: result.value || resolveActorHealth(actor, context),
    applied: result.applied || 0,
    overflow: result.overflow || 0,
    blocked: result.blocked || null,
  };
}
