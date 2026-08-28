import { deriveActorDocument, performActorOperation } from '../actor/index.js';

export function ensureActorHealth(actor) {
  return resolveActorHealth(actor);
}

export function resolveActorHealth(actor) {
  return deriveActorDocument(actor)?.health || null;
}

export function setActorHealthMode(actor, mode) {
  const result = performActorOperation(actor, { type: 'health.set-mode', mode });
  return result.value || resolveActorHealth(actor);
}

export function performActorHealthOperation(actor, operation = {}) {
  const before = resolveActorHealth(actor);
  const result = performActorOperation(actor, { type: 'health.runtime', operation });
  return {
    before,
    after: result.value || before,
    changed: result.changed,
    blocked: result.blocked || null,
  };
}

export function applyDamageToActor(actor, { amount = 0, type } = {}) {
  const result = performActorOperation(actor, {
    type: 'health.damage',
    amount,
    damageType: type,
  });
  return {
    before: result.before || null,
    after: result.value || resolveActorHealth(actor),
    applied: result.applied || 0,
    overflow: result.overflow || 0,
    blocked: result.blocked || null,
  };
}

export function applyHealingToActor(actor, { amount = 0, type } = {}) {
  const result = performActorOperation(actor, {
    type: 'health.healing',
    amount,
    damageType: type,
  });
  return {
    before: result.before || null,
    after: result.value || resolveActorHealth(actor),
    applied: result.applied || 0,
    overflow: result.overflow || 0,
    blocked: result.blocked || null,
  };
}
