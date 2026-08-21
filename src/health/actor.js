import { currentForm } from '../entities/model.js';
import { resolveResource, setResourceCurrent } from '../entities/resolver.js';
import {
  HEALTH_MODE_SIMPLE,
  HEALTH_MODE_WOUND_TRACK,
  applySimpleDamage,
  applyWoundDamage,
  createHealthRuntime,
  defaultHealthMode,
  normalizeHealthRuntime,
  resolveHealth,
  switchHealthMode,
} from './model.js';

function sourceType(actor) {
  return currentForm(actor)?.source?.type || null;
}

export function ensureActorHealth(actor) {
  actor.runtime ||= {};
  const hp = resolveResource(actor, 'hp') || { max: 0, current: 0 };
  actor.runtime.health = normalizeHealthRuntime(actor.runtime.health, {
    defaultMode: defaultHealthMode(sourceType(actor)),
    max: hp.max,
    simpleCurrent: hp.current,
  });
  return actor.runtime.health;
}

export function resolveActorHealth(actor) {
  const hp = resolveResource(actor, 'hp') || { max: 0, current: 0 };
  const runtime = normalizeHealthRuntime(actor.runtime?.health, {
    defaultMode: defaultHealthMode(sourceType(actor)),
    max: hp.max,
    simpleCurrent: hp.current,
  });
  return resolveHealth(runtime, { max: hp.max, simpleCurrent: hp.current });
}

export function setActorHealthMode(actor, mode) {
  const hp = resolveResource(actor, 'hp') || { max: 0, current: 0 };
  const runtime = ensureActorHealth(actor);
  const switched = switchHealthMode(runtime, mode, { max: hp.max, simpleCurrent: hp.current });
  actor.runtime.health = switched.runtime;
  setResourceCurrent(actor, 'hp', switched.simpleCurrent);
  actor.updatedAt = new Date().toISOString();
  return resolveActorHealth(actor);
}

export function applyDamageToActor(actor, { amount = 0, type = 'L' } = {}) {
  const before = resolveActorHealth(actor);
  ensureActorHealth(actor);
  let applied = 0;
  let overflow = 0;

  if (before.mode === HEALTH_MODE_WOUND_TRACK) {
    const result = applyWoundDamage(actor.runtime.health, { amount, type }, { max: before.max });
    actor.runtime.health = result.runtime;
    setResourceCurrent(actor, 'hp', result.state.healthy);
    applied = result.applied;
    overflow = result.overflow;
  } else {
    const result = applySimpleDamage(before.current, amount, before.max);
    setResourceCurrent(actor, 'hp', result.current);
    actor.runtime.health = createHealthRuntime({ mode: HEALTH_MODE_SIMPLE, max: before.max, simpleCurrent: result.current });
    applied = result.applied;
    overflow = result.overflow;
  }

  actor.updatedAt = new Date().toISOString();
  const after = resolveActorHealth(actor);
  return { before, after, applied, overflow };
}
