import {
  HEALTH_MODE_SIMPLE,
  HEALTH_MODE_WOUND_TRACK,
  applySimpleDamage,
  applySimpleHealing,
  applyWoundDamage,
  applyWoundHealing,
  createHealthRuntime,
  normalizeHealthRuntime,
  resolveHealth,
  switchHealthMode,
} from '../../health/model.js';

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function modeForRuntime(runtime, fallback = HEALTH_MODE_SIMPLE) {
  return runtime?.mode === HEALTH_MODE_WOUND_TRACK ? HEALTH_MODE_WOUND_TRACK : fallback;
}

export const INFINITE_HORROR_HEALTH = Object.freeze({
  supportedModes: Object.freeze([HEALTH_MODE_SIMPLE, HEALTH_MODE_WOUND_TRACK]),

  defaultModeForSource(sourceType) {
    return sourceType === 'xlsx' ? HEALTH_MODE_WOUND_TRACK : HEALTH_MODE_SIMPLE;
  },

  createRuntime(options = {}) {
    return createHealthRuntime(options);
  },

  normalizeRuntime(runtime, options = {}) {
    return normalizeHealthRuntime(runtime, options);
  },

  resolve(runtime, options = {}) {
    return resolveHealth(runtime, options);
  },

  switchMode(runtime, nextMode, options = {}) {
    return switchHealthMode(runtime, nextMode, options);
  },

  setWounds(runtime, wounds = {}, { max = 0, simpleCurrent = max } = {}) {
    const before = resolveHealth(runtime, { max, simpleCurrent });
    if (before.mode !== HEALTH_MODE_WOUND_TRACK) {
      return { runtime, current: before.current, state: before, changed: false, blocked: 'simple_mode' };
    }
    const next = normalizeHealthRuntime({
      ...runtime,
      mode: HEALTH_MODE_WOUND_TRACK,
      wounds: { ...(runtime?.wounds || {}), ...wounds },
    }, {
      defaultMode: HEALTH_MODE_WOUND_TRACK,
      max,
      simpleCurrent,
    });
    const state = resolveHealth(next, { max, simpleCurrent });
    return { runtime: next, current: state.healthy, state, changed: true, blocked: null };
  },

  applyDamage({ runtime, current = 0, max = 0, amount = 0, type = 'L' } = {}) {
    const before = resolveHealth(runtime, { max, simpleCurrent: current });
    if (before.mode === HEALTH_MODE_WOUND_TRACK) {
      const result = applyWoundDamage(runtime, { amount, type }, { max });
      return {
        runtime: result.runtime,
        current: result.state.healthy,
        state: result.state,
        applied: result.applied,
        overflow: result.overflow,
        blocked: null,
      };
    }
    const result = applySimpleDamage(before.current, amount, before.max);
    const nextRuntime = createHealthRuntime({ mode: HEALTH_MODE_SIMPLE, max: before.max, simpleCurrent: result.current });
    return {
      runtime: nextRuntime,
      current: result.current,
      state: resolveHealth(nextRuntime, { max: before.max, simpleCurrent: result.current }),
      applied: result.applied,
      overflow: result.overflow,
      blocked: null,
    };
  },

  applyHealing({ runtime, current = 0, max = 0, amount = 0, type = 'L' } = {}) {
    const before = resolveHealth(runtime, { max, simpleCurrent: current });
    if (before.mode === HEALTH_MODE_WOUND_TRACK) {
      if (before.dead) {
        return {
          runtime,
          current: before.healthy,
          state: before,
          applied: 0,
          overflow: nonNegativeInt(amount),
          blocked: 'dead',
        };
      }
      const result = applyWoundHealing(runtime, { amount, type }, { max });
      return {
        runtime: result.runtime,
        current: result.state.healthy,
        state: result.state,
        applied: result.applied,
        overflow: result.overflow,
        blocked: null,
      };
    }
    const result = applySimpleHealing(before.current, amount, before.max);
    const nextRuntime = createHealthRuntime({ mode: HEALTH_MODE_SIMPLE, max: before.max, simpleCurrent: result.current });
    return {
      runtime: nextRuntime,
      current: result.current,
      state: resolveHealth(nextRuntime, { max: before.max, simpleCurrent: result.current }),
      applied: result.applied,
      overflow: result.overflow,
      blocked: null,
    };
  },
});
