import { currentForm } from '../entities/model.js';
import { resolveResource, setResourceCurrent } from '../entities/resolver.js';
import { getActiveRuleset } from '../ruleset/index.js';

function sourceType(actor) {
  return currentForm(actor)?.source?.type || null;
}

function healthRules() {
  const health = getActiveRuleset().health;
  const required = ['normalizeRuntime', 'resolve', 'switchMode', 'applyRuntimeOperation', 'applyDamage', 'applyHealing'];
  for (const key of required) {
    if (typeof health?.[key] !== 'function') {
      throw new Error(`Active ruleset does not implement health.${key}`);
    }
  }
  return health;
}

function healthContext(actor) {
  const hp = resolveResource(actor, 'hp') || { max: 0, current: 0 };
  const rules = healthRules();
  return {
    hp,
    rules,
    options: {
      defaultMode: rules.defaultModeForSource(sourceType(actor)),
      max: hp.max,
      simpleCurrent: hp.current,
    },
  };
}

export function ensureActorHealth(actor) {
  actor.runtime ||= {};
  const { rules, options } = healthContext(actor);
  actor.runtime.health = rules.normalizeRuntime(actor.runtime.health, options);
  return actor.runtime.health;
}

export function resolveActorHealth(actor) {
  const { hp, rules, options } = healthContext(actor);
  const runtime = rules.normalizeRuntime(actor.runtime?.health, options);
  return rules.resolve(runtime, { max: hp.max, simpleCurrent: hp.current });
}

export function setActorHealthMode(actor, mode) {
  const { hp, rules } = healthContext(actor);
  const runtime = ensureActorHealth(actor);
  const switched = rules.switchMode(runtime, mode, { max: hp.max, simpleCurrent: hp.current });
  actor.runtime.health = switched.runtime;
  setResourceCurrent(actor, 'hp', switched.simpleCurrent);
  actor.updatedAt = new Date().toISOString();
  return resolveActorHealth(actor);
}

export function performActorHealthOperation(actor, operation = {}) {
  const before = resolveActorHealth(actor);
  const { hp, rules } = healthContext(actor);
  const runtime = ensureActorHealth(actor);
  const result = rules.applyRuntimeOperation(runtime, operation, { max: hp.max, simpleCurrent: hp.current });
  if (!result?.changed) {
    return { before, after: result?.state || before, changed: false, blocked: result?.blocked || 'unsupported' };
  }
  actor.runtime.health = result.runtime;
  setResourceCurrent(actor, 'hp', result.current);
  actor.updatedAt = new Date().toISOString();
  return { before, after: resolveActorHealth(actor), changed: true, blocked: null };
}

export function applyDamageToActor(actor, { amount = 0, type } = {}) {
  const before = resolveActorHealth(actor);
  const { hp, rules } = healthContext(actor);
  const runtime = ensureActorHealth(actor);
  const result = rules.applyDamage({
    runtime,
    current: hp.current,
    max: hp.max,
    amount,
    type,
  });
  actor.runtime.health = result.runtime;
  setResourceCurrent(actor, 'hp', result.current);
  actor.updatedAt = new Date().toISOString();
  const after = resolveActorHealth(actor);
  return {
    before,
    after,
    applied: result.applied || 0,
    overflow: result.overflow || 0,
    blocked: result.blocked || null,
  };
}

export function applyHealingToActor(actor, { amount = 0, type } = {}) {
  const before = resolveActorHealth(actor);
  const { hp, rules } = healthContext(actor);
  const runtime = ensureActorHealth(actor);
  const result = rules.applyHealing({
    runtime,
    current: hp.current,
    max: hp.max,
    amount,
    type,
  });
  actor.runtime.health = result.runtime;
  setResourceCurrent(actor, 'hp', result.current);
  actor.updatedAt = new Date().toISOString();
  const after = resolveActorHealth(actor);
  return {
    before,
    after,
    applied: result.applied || 0,
    overflow: result.overflow || 0,
    blocked: result.blocked || null,
  };
}
