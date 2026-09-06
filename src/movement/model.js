export const MOVEMENT_MODES = Object.freeze(['walk', 'swim', 'waterWalk', 'fly']);
export const MOVEMENT_VERTICAL_ACTIONS = Object.freeze(['takeoff', 'landing']);

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizeMovementMode(value, fallback = 'walk') {
  return MOVEMENT_MODES.includes(String(value)) ? String(value) : fallback;
}

export function normalizeMovementState(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.freeze({
    ...structuredClone(source),
    mode: normalizeMovementMode(source.mode),
    spentMeters: finiteNonNegative(source.spentMeters),
    turnKey: typeof source.turnKey === 'string' && source.turnKey ? source.turnKey : null,
    adjudicationRequired: source.adjudicationRequired === true,
  });
}

export function normalizeMovementBudget(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    const error = new TypeError('Movement budget must be a finite non-negative number or null');
    error.code = 'movement_budget_invalid';
    throw error;
  }
  return number;
}

export function movementTurnKey(combat) {
  if (!combat || combat.state !== 'active') return null;
  return `${String(combat.id || 'combat')}:${Math.max(1, Number(combat.round) || 1)}:${Math.max(0, Number(combat.turnIndex) || 0)}`;
}

export function spatialDistanceMeters(from, to, metersPerUnit = 1) {
  const scale = Number(metersPerUnit);
  const horizontal = Math.hypot(Number(to.x) - Number(from.x), Number(to.y) - Number(from.y))
    * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  return Math.hypot(horizontal, Number(to.elevationMeters) - Number(from.elevationMeters));
}

export function movementCostMeters(distanceMeters, {
  difficult = false,
  water = false,
  mode = 'walk',
  swimCostMultiplier = 2,
} = {}) {
  let multiplier = 1;
  if (difficult && mode !== 'fly') multiplier *= 2;
  if (water && mode === 'swim') multiplier *= finiteNonNegative(swimCostMultiplier, 2) || 1;
  return finiteNonNegative(distanceMeters) * multiplier;
}

export function movementTerrainCostMeters(distanceMeters, counts = {}, options = {}) {
  const values = {
    normal: finiteNonNegative(counts.normal),
    difficult: finiteNonNegative(counts.difficult),
    water: finiteNonNegative(counts.water),
    difficultWater: finiteNonNegative(counts.difficultWater),
  };
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (!total) return movementCostMeters(distanceMeters, options);
  return Object.entries(values).reduce((sum, [kind, count]) => sum + movementCostMeters(
    finiteNonNegative(distanceMeters) * count / total,
    { ...options, difficult: kind.includes('difficult'), water: kind.includes('Water') || kind === 'water' },
  ), 0);
}

export function movementCapabilityFailure(descriptor, mode, verticalAction = null) {
  const movement = descriptor && typeof descriptor === 'object' ? descriptor : {};
  if (mode === 'walk' && movement.walk === false) return 'movement_walk_forbidden';
  if (mode === 'swim' && movement.swim !== true) return 'movement_swim_forbidden';
  if (mode === 'waterWalk' && movement.waterWalk !== true) return 'movement_water_walk_forbidden';
  if (mode === 'fly' && movement.fly !== true) return 'movement_flight_forbidden';
  if (verticalAction === 'takeoff' && movement.fly !== true) return 'movement_takeoff_forbidden';
  if (verticalAction === 'landing' && movement.fly !== true) return 'movement_landing_forbidden';
  return null;
}

export function nextMovementState(raw, { costMeters, budgetMeters, turnKey, mode, capabilityAvailable = true } = {}) {
  const current = normalizeMovementState(raw);
  const spent = turnKey && current.turnKey === turnKey ? current.spentMeters : 0;
  const nextSpent = spent + finiteNonNegative(costMeters);
  if (budgetMeters !== null && budgetMeters !== undefined && nextSpent > Number(budgetMeters) + 1e-9) {
    const error = new Error('Movement budget exceeded');
    error.code = 'movement_budget_exceeded';
    error.spentMeters = spent;
    error.costMeters = costMeters;
    error.budgetMeters = Number(budgetMeters);
    throw error;
  }
  return Object.freeze({
    ...current,
    mode: normalizeMovementMode(mode, current.mode),
    spentMeters: nextSpent,
    turnKey: turnKey || null,
    adjudicationRequired: !capabilityAvailable,
  });
}
