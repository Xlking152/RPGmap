export const HEALTH_MODE_SIMPLE = 'simple';
export const HEALTH_MODE_WOUND_TRACK = 'wound-track';

export const DAMAGE_BASHING = 'B';
export const DAMAGE_LETHAL = 'L';
export const DAMAGE_AGGRAVATED = 'A';

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function defaultHealthMode(sourceType) {
  return sourceType === 'xlsx' ? HEALTH_MODE_WOUND_TRACK : HEALTH_MODE_SIMPLE;
}

export function normalizeWounds(raw, max) {
  const limit = nonNegativeInt(max);
  let aggravated = clamp(nonNegativeInt(raw?.aggravated), 0, limit);
  let lethal = clamp(nonNegativeInt(raw?.lethal), 0, Math.max(0, limit - aggravated));
  let bashing = clamp(nonNegativeInt(raw?.bashing), 0, Math.max(0, limit - aggravated - lethal));
  return { bashing, lethal, aggravated };
}

export function createHealthRuntime({ mode = HEALTH_MODE_SIMPLE, max = 0, simpleCurrent = max } = {}) {
  const normalizedMode = mode === HEALTH_MODE_WOUND_TRACK ? HEALTH_MODE_WOUND_TRACK : HEALTH_MODE_SIMPLE;
  const limit = nonNegativeInt(max);
  const current = clamp(nonNegativeInt(simpleCurrent, limit), 0, limit);
  return {
    mode: normalizedMode,
    wounds: normalizedMode === HEALTH_MODE_WOUND_TRACK
      ? { bashing: limit - current, lethal: 0, aggravated: 0 }
      : { bashing: 0, lethal: 0, aggravated: 0 },
  };
}

export function normalizeHealthRuntime(raw, { defaultMode = HEALTH_MODE_SIMPLE, max = 0, simpleCurrent = max } = {}) {
  const mode = raw?.mode === HEALTH_MODE_WOUND_TRACK || raw?.mode === HEALTH_MODE_SIMPLE
    ? raw.mode
    : defaultMode;
  if (!raw || typeof raw !== 'object') return createHealthRuntime({ mode, max, simpleCurrent });
  return {
    mode,
    wounds: normalizeWounds(raw.wounds, max),
  };
}

export function resolveHealth(runtime, { max = 0, simpleCurrent = max } = {}) {
  const limit = nonNegativeInt(max);
  const mode = runtime?.mode === HEALTH_MODE_WOUND_TRACK ? HEALTH_MODE_WOUND_TRACK : HEALTH_MODE_SIMPLE;
  if (mode === HEALTH_MODE_SIMPLE) {
    const current = clamp(nonNegativeInt(simpleCurrent, limit), 0, limit);
    return {
      mode,
      max: limit,
      current,
      healthy: current,
      bashing: 0,
      lethal: 0,
      aggravated: 0,
      status: current > 0 ? 'normal' : 'depleted',
      deteriorating: false,
      dead: current <= 0,
      unconscious: current <= 0,
    };
  }
  const wounds = normalizeWounds(runtime?.wounds, limit);
  const healthy = Math.max(0, limit - wounds.bashing - wounds.lethal - wounds.aggravated);
  const dead = limit > 0 && wounds.aggravated >= limit;
  const unconscious = limit > 0 && healthy === 0 && !dead;
  const deteriorating = unconscious && wounds.aggravated > 0;
  const weightedDamage = wounds.bashing + wounds.lethal * 2 + wounds.aggravated * 3;
  const injury = dead || limit <= 0
    ? (dead ? 'dead' : 'unharmed')
    : weightedDamage <= 0
      ? 'unharmed'
      : weightedDamage <= limit
        ? 'minor'
        : weightedDamage <= limit * 2
          ? 'moderate'
          : 'severe';
  return {
    mode,
    max: limit,
    current: healthy,
    healthy,
    ...wounds,
    weightedDamage,
    injury,
    status: dead ? 'dead' : unconscious ? 'unconscious' : 'normal',
    deteriorating,
    dead,
    unconscious,
  };
}

function applySingleWoundPoint(wounds, type, max) {
  const total = wounds.bashing + wounds.lethal + wounds.aggravated;
  const healthy = Math.max(0, max - total);
  if (type === DAMAGE_BASHING) {
    if (healthy > 0) wounds.bashing += 1;
    else if (wounds.bashing > 0) { wounds.bashing -= 1; wounds.lethal += 1; }
    else if (wounds.lethal > 0) { wounds.lethal -= 1; wounds.aggravated += 1; }
    else return false;
    return true;
  }
  if (type === DAMAGE_LETHAL) {
    if (healthy > 0) wounds.lethal += 1;
    else if (wounds.bashing > 0) { wounds.bashing -= 1; wounds.lethal += 1; }
    else if (wounds.lethal > 0) { wounds.lethal -= 1; wounds.aggravated += 1; }
    else return false;
    return true;
  }
  if (type === DAMAGE_AGGRAVATED) {
    if (healthy > 0) wounds.aggravated += 1;
    else if (wounds.bashing > 0) { wounds.bashing -= 1; wounds.aggravated += 1; }
    else if (wounds.lethal > 0) { wounds.lethal -= 1; wounds.aggravated += 1; }
    else return false;
    return true;
  }
  return false;
}

export function applyWoundDamage(runtime, damage, { max = 0 } = {}) {
  const limit = nonNegativeInt(max);
  const next = normalizeHealthRuntime(runtime, { defaultMode: HEALTH_MODE_WOUND_TRACK, max: limit });
  next.mode = HEALTH_MODE_WOUND_TRACK;
  const wounds = { ...next.wounds };
  const amounts = {
    [DAMAGE_BASHING]: nonNegativeInt(damage?.bashing ?? (damage?.type === DAMAGE_BASHING ? damage?.amount : 0)),
    [DAMAGE_LETHAL]: nonNegativeInt(damage?.lethal ?? (damage?.type === DAMAGE_LETHAL ? damage?.amount : 0)),
    [DAMAGE_AGGRAVATED]: nonNegativeInt(damage?.aggravated ?? (damage?.type === DAMAGE_AGGRAVATED ? damage?.amount : 0)),
  };
  let applied = 0;
  let overflow = 0;
  // Rules require simultaneous mixed damage to resolve from the least severe type upward: B -> L -> A.
  for (const type of [DAMAGE_BASHING, DAMAGE_LETHAL, DAMAGE_AGGRAVATED]) {
    for (let index = 0; index < amounts[type]; index += 1) {
      if (applySingleWoundPoint(wounds, type, limit)) applied += 1;
      else overflow += 1;
    }
  }
  next.wounds = normalizeWounds(wounds, limit);
  return { runtime: next, state: resolveHealth(next, { max: limit }), applied, overflow };
}

export function applySimpleDamage(current, amount, max) {
  const limit = nonNegativeInt(max);
  const before = clamp(nonNegativeInt(current, limit), 0, limit);
  const requested = nonNegativeInt(amount);
  const after = Math.max(0, before - requested);
  return { current: after, applied: before - after, overflow: Math.max(0, requested - before) };
}

export function switchHealthMode(runtime, nextMode, { max = 0, simpleCurrent = max } = {}) {
  const limit = nonNegativeInt(max);
  const currentState = resolveHealth(runtime, { max: limit, simpleCurrent });
  if (nextMode === HEALTH_MODE_WOUND_TRACK) {
    const healthy = currentState.mode === HEALTH_MODE_WOUND_TRACK
      ? currentState.healthy
      : currentState.current;
    return {
      runtime: {
        mode: HEALTH_MODE_WOUND_TRACK,
        wounds: { bashing: Math.max(0, limit - healthy), lethal: 0, aggravated: 0 },
      },
      simpleCurrent: healthy,
    };
  }
  return {
    runtime: { mode: HEALTH_MODE_SIMPLE, wounds: { bashing: currentState.bashing || 0, lethal: currentState.lethal || 0, aggravated: currentState.aggravated || 0 } },
    simpleCurrent: currentState.healthy,
  };
}

export function injuryStateLabel(state) {
  if (!state || state.mode === HEALTH_MODE_SIMPLE) return '';
  if (state.injury === 'minor') return '轻微受伤';
  if (state.injury === 'moderate') return '中度受伤';
  if (state.injury === 'severe') return '严重受伤';
  if (state.injury === 'dead') return '死亡';
  return '毫发无损';
}

export function healthStatusLabel(state) {
  if (!state) return '未知';
  if (state.mode === HEALTH_MODE_SIMPLE) return state.current > 0 ? '正常' : '生命耗尽';
  if (state.dead) return '死亡';
  const injury = injuryStateLabel(state);
  if (state.unconscious) return `${injury} · 昏迷${state.deteriorating ? ' · 伤势恶化' : ''}`;
  return injury;
}

export function formatHealthSummary(state) {
  if (!state) return '—';
  if (state.mode === HEALTH_MODE_SIMPLE) return `${state.current} / ${state.max}`;
  return `${state.healthy}完好 · ${state.bashing}B · ${state.lethal}L · ${state.aggravated}A`;
}

export function damageTypeLabel(type) {
  if (type === DAMAGE_BASHING) return '冲击 B';
  if (type === DAMAGE_AGGRAVATED) return '恶性 A';
  return '严重 L';
}
