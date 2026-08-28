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
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? structuredClone(raw) : {};
  const limit = nonNegativeInt(max);
  const aggravated = clamp(nonNegativeInt(raw?.aggravated), 0, limit);
  const lethal = clamp(nonNegativeInt(raw?.lethal), 0, Math.max(0, limit - aggravated));
  const bashing = clamp(nonNegativeInt(raw?.bashing), 0, Math.max(0, limit - aggravated - lethal));
  return { ...source, bashing, lethal, aggravated };
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
  return { ...structuredClone(raw), mode, wounds: normalizeWounds(raw.wounds, max) };
}

export function resolveHealth(runtime, { max = 0, simpleCurrent = max } = {}) {
  const limit = nonNegativeInt(max);
  const mode = runtime?.mode === HEALTH_MODE_WOUND_TRACK ? HEALTH_MODE_WOUND_TRACK : HEALTH_MODE_SIMPLE;
  if (mode === HEALTH_MODE_SIMPLE) {
    const current = clamp(nonNegativeInt(simpleCurrent, limit), 0, limit);
    return {
      mode, max: limit, current, healthy: current, bashing: 0, lethal: 0, aggravated: 0,
      status: current > 0 ? 'normal' : 'depleted', deteriorating: false,
      dead: current <= 0, unconscious: current <= 0,
    };
  }
  const wounds = normalizeWounds(runtime?.wounds, limit);
  const healthy = Math.max(0, limit - wounds.bashing - wounds.lethal - wounds.aggravated);
  const dead = limit > 0 && wounds.aggravated >= limit;
  const unconscious = limit > 0 && healthy === 0 && !dead;
  const deteriorating = unconscious && wounds.aggravated > 0;
  const weightedDamage = wounds.bashing + wounds.lethal * 2 + wounds.aggravated * 3;
  const injury = dead || limit <= 0 ? (dead ? 'dead' : 'unharmed')
    : weightedDamage <= 0 ? 'unharmed'
      : weightedDamage <= limit ? 'minor'
        : weightedDamage <= limit * 2 ? 'moderate' : 'severe';
  return {
    mode, max: limit, current: healthy, healthy, ...wounds, weightedDamage, injury,
    status: dead ? 'dead' : unconscious ? 'unconscious' : 'normal',
    deteriorating, dead, unconscious,
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

export function applyWoundHealing(runtime, healing, { max = 0 } = {}) {
  const limit = nonNegativeInt(max);
  const next = normalizeHealthRuntime(runtime, { defaultMode: HEALTH_MODE_WOUND_TRACK, max: limit });
  next.mode = HEALTH_MODE_WOUND_TRACK;
  const wounds = { ...next.wounds };
  const type = [DAMAGE_BASHING, DAMAGE_LETHAL, DAMAGE_AGGRAVATED].includes(healing?.type)
    ? healing.type : DAMAGE_LETHAL;
  const requested = nonNegativeInt(healing?.amount);
  const key = type === DAMAGE_BASHING ? 'bashing' : type === DAMAGE_AGGRAVATED ? 'aggravated' : 'lethal';
  const applied = Math.min(requested, wounds[key]);
  wounds[key] -= applied;
  next.wounds = normalizeWounds(wounds, limit);
  return { runtime: next, state: resolveHealth(next, { max: limit }), applied, overflow: Math.max(0, requested - applied) };
}

export function applySimpleHealing(current, amount, max) {
  const limit = nonNegativeInt(max);
  const before = clamp(nonNegativeInt(current, limit), 0, limit);
  const requested = nonNegativeInt(amount);
  const after = Math.min(limit, before + requested);
  return { current: after, applied: after - before, overflow: Math.max(0, requested - (after - before)) };
}

export function switchHealthMode(runtime, nextMode, { max = 0, simpleCurrent = max } = {}) {
  const limit = nonNegativeInt(max);
  const currentState = resolveHealth(runtime, { max: limit, simpleCurrent });
  if (nextMode === HEALTH_MODE_WOUND_TRACK) {
    const healthy = currentState.mode === HEALTH_MODE_WOUND_TRACK ? currentState.healthy : currentState.current;
    return {
      runtime: { mode: HEALTH_MODE_WOUND_TRACK, wounds: { bashing: Math.max(0, limit - healthy), lethal: 0, aggravated: 0 } },
      simpleCurrent: healthy,
    };
  }
  return {
    runtime: {
      mode: HEALTH_MODE_SIMPLE,
      wounds: { bashing: currentState.bashing || 0, lethal: currentState.lethal || 0, aggravated: currentState.aggravated || 0 },
    },
    simpleCurrent: currentState.healthy,
  };
}

function injuryStateLabel(state) {
  if (!state || state.mode === HEALTH_MODE_SIMPLE) return '';
  if (state.injury === 'minor') return '轻微受伤';
  if (state.injury === 'moderate') return '中度受伤';
  if (state.injury === 'severe') return '严重受伤';
  if (state.injury === 'dead') return '死亡';
  return '毫发无损';
}

function healthStatusLabel(state) {
  if (!state) return '未知';
  if (state.mode === HEALTH_MODE_SIMPLE) return state.current > 0 ? '正常' : '生命耗尽';
  if (state.dead) return '死亡';
  const injury = injuryStateLabel(state);
  if (state.unconscious) return `${injury} · 昏迷${state.deteriorating ? ' · 伤势恶化' : ''}`;
  return injury;
}

function formatHealthSummary(state) {
  if (!state) return '—';
  if (state.mode === HEALTH_MODE_SIMPLE) return `${state.current} / ${state.max}`;
  return `${state.healthy}完好 · ${state.bashing}B · ${state.lethal}L · ${state.aggravated}A`;
}

function describeHealth(state) {
  const summary = formatHealthSummary(state);
  const status = healthStatusLabel(state);
  if (!state || state.mode === HEALTH_MODE_SIMPLE) {
    return {
      summary, status, danger: Boolean(state?.dead || state?.unconscious), hideBaseResource: false,
      title: '生命系统', help: '普通 HP 模式沿用原有“当前 / 最大”生命值。',
      segments: state ? [{ id: 'current', label: '当前', value: state.current, color: '#4b9f69' }] : [], fields: [],
    };
  }
  const field = (id, label, value) => ({
    id, label, value, min: 0, max: state.max,
    operation: nextValue => ({ type: 'set-wounds', wounds: { [id]: nextValue } }),
  });
  return {
    summary,
    status: `${status}${state.deteriorating ? ' · 每轮伤势恶化规则请由操作者确认后处理' : ''}`,
    danger: Boolean(state.dead || state.unconscious), hideBaseResource: true,
    title: `生命值 · 上限 ${state.max}`,
    help: '伤害由右侧“聊天 → 伤害”应用。这里显示生命槽结果；盔甲、硬度、DR、临时生命等前置步骤由具体效果处理。',
    segments: [
      { id: 'healthy', label: '完好', value: state.healthy, color: '#4b9f69' },
      { id: 'bashing', label: '冲击 B', value: state.bashing, color: '#d9b84a' },
      { id: 'lethal', label: '严重 L', value: state.lethal, color: '#d77c42' },
      { id: 'aggravated', label: '恶性 A', value: state.aggravated, color: '#a94442' },
    ],
    fields: [field('bashing', '冲击 B', state.bashing), field('lethal', '严重 L', state.lethal), field('aggravated', '恶性 A', state.aggravated)],
  };
}

const DAMAGE_TYPES = Object.freeze([
  Object.freeze({ id: DAMAGE_BASHING, label: '冲击 B' }),
  Object.freeze({ id: DAMAGE_LETHAL, label: '严重 L' }),
  Object.freeze({ id: DAMAGE_AGGRAVATED, label: '恶性 A' }),
]);

const HEALING_TYPES = Object.freeze([
  Object.freeze({ id: DAMAGE_BASHING, label: '冲击 B' }),
  Object.freeze({ id: DAMAGE_LETHAL, label: '严重 L' }),
  Object.freeze({ id: DAMAGE_AGGRAVATED, label: '恶性 A' }),
]);

export const INFINITE_HORROR_HEALTH = Object.freeze({
  supportedModes: Object.freeze([HEALTH_MODE_SIMPLE, HEALTH_MODE_WOUND_TRACK]),
  defaultModeForSource: defaultHealthMode,
  createRuntime: createHealthRuntime,
  normalizeRuntime: normalizeHealthRuntime,
  resolve: resolveHealth,
  switchMode: switchHealthMode,

  applyRuntimeOperation(runtime, operation = {}, { max = 0, simpleCurrent = max } = {}) {
    const before = resolveHealth(runtime, { max, simpleCurrent });
    if (operation?.type !== 'set-wounds') {
      return { runtime, current: before.current, state: before, changed: false, blocked: 'unsupported' };
    }
    if (before.mode !== HEALTH_MODE_WOUND_TRACK) {
      return { runtime, current: before.current, state: before, changed: false, blocked: 'simple_mode' };
    }
    const next = normalizeHealthRuntime({
      ...runtime, mode: HEALTH_MODE_WOUND_TRACK,
      wounds: { ...(runtime?.wounds || {}), ...(operation.wounds || {}) },
    }, { defaultMode: HEALTH_MODE_WOUND_TRACK, max, simpleCurrent });
    const state = resolveHealth(next, { max, simpleCurrent });
    return { runtime: next, current: state.healthy, state, changed: true, blocked: null };
  },

  applyDamage({ runtime, current = 0, max = 0, amount = 0, type = DAMAGE_LETHAL } = {}) {
    const before = resolveHealth(runtime, { max, simpleCurrent: current });
    if (before.mode === HEALTH_MODE_WOUND_TRACK) {
      const result = applyWoundDamage(runtime, { amount, type }, { max });
      return { runtime: result.runtime, current: result.state.healthy, state: result.state,
        applied: result.applied, overflow: result.overflow, blocked: null };
    }
    const result = applySimpleDamage(before.current, amount, before.max);
    const nextRuntime = createHealthRuntime({ mode: HEALTH_MODE_SIMPLE, max: before.max, simpleCurrent: result.current });
    return { runtime: nextRuntime, current: result.current,
      state: resolveHealth(nextRuntime, { max: before.max, simpleCurrent: result.current }),
      applied: result.applied, overflow: result.overflow, blocked: null };
  },

  applyHealing({ runtime, current = 0, max = 0, amount = 0, type = DAMAGE_LETHAL } = {}) {
    const before = resolveHealth(runtime, { max, simpleCurrent: current });
    if (before.mode === HEALTH_MODE_WOUND_TRACK) {
      if (before.dead) {
        return { runtime, current: before.healthy, state: before, applied: 0,
          overflow: nonNegativeInt(amount), blocked: 'dead' };
      }
      const result = applyWoundHealing(runtime, { amount, type }, { max });
      return { runtime: result.runtime, current: result.state.healthy, state: result.state,
        applied: result.applied, overflow: result.overflow, blocked: null };
    }
    const result = applySimpleHealing(before.current, amount, before.max);
    const nextRuntime = createHealthRuntime({ mode: HEALTH_MODE_SIMPLE, max: before.max, simpleCurrent: result.current });
    return { runtime: nextRuntime, current: result.current,
      state: resolveHealth(nextRuntime, { max: before.max, simpleCurrent: result.current }),
      applied: result.applied, overflow: result.overflow, blocked: null };
  },

  presentation: Object.freeze({
    modes: Object.freeze([
      Object.freeze({ id: HEALTH_MODE_WOUND_TRACK, label: '伤势生命槽 B/L/A' }),
      Object.freeze({ id: HEALTH_MODE_SIMPLE, label: '普通 HP' }),
    ]),
    operations: Object.freeze({
      damage: Object.freeze({
        defaultType: DAMAGE_LETHAL, types: DAMAGE_TYPES, inputPlaceholder: '伤害点数',
        submitLabel: '应用到所选角色', unitLabel: '伤害', overflowLabel: '生命槽已满，未生效',
        help: '输入已经完成防御、减免等前置处理后的结算伤害。伤势生命槽按 B / L / A 规则处理；普通 HP 模式直接扣除同等数值。',
      }),
      healing: Object.freeze({
        defaultType: DAMAGE_LETHAL, types: HEALING_TYPES, inputPlaceholder: '实际恢复生命槽',
        submitLabel: '恢复所选角色', unitLabel: '生命槽', overflowLabel: '没有对应伤势或已恢复至上限，未生效',
        noEffectMessage: '恢复生命：所选角色没有可恢复的伤势',
        blockedMessages: Object.freeze({ dead: '恢复生命：目标已死亡；普通恢复不能代替复活' }),
        help: '输入规则结算后的实际恢复生命槽数。换算后恢复对应 B / L / A；普通 HP 模式直接恢复同等 HP。',
      }),
    }),
    describe: describeHealth,
  }),
});
