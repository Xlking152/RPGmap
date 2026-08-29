export const FEATURE_STATE_KEY = 'featureStates';
export const LEGACY_FEATURE_INTERACTION_STATE_KEY = 'featureInteractions';

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 12;
const MAX_NODES = 2048;
const MAX_KEYS = 256;
const MAX_ARRAY_LENGTH = 1000;
const MAX_STRING_LENGTH = 65536;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message, code = 'invalid_feature_state_patch') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateValue(value, path, depth, budget) {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    fail(`${path} exceeds Feature State limits`, 'feature_state_patch_limit');
  }
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    fail(`${path} string is too long`, 'feature_state_patch_limit');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) fail(`${path} must be finite`);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value !== 'object') fail(`${path} must contain JSON values only`);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) fail(`${path} array is too long`, 'feature_state_patch_limit');
    value.forEach((item, index) => validateValue(item, `${path}[${index}]`, depth + 1, budget));
    return;
  }
  if (!isPlainObject(value)) fail(`${path} must contain JSON values only`);
  const keys = Object.keys(value);
  if (keys.length > MAX_KEYS) fail(`${path} has too many keys`, 'feature_state_patch_limit');
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) fail(`${path} contains a dangerous key`, 'feature_state_patch_unsafe_key');
    if (key.length > 160) fail(`${path} key is too long`, 'feature_state_patch_limit');
    validateValue(value[key], `${path}.${key}`, depth + 1, budget);
  }
}

export function assertFeatureStatePatch(patch) {
  if (patch !== null && !isPlainObject(patch)) fail('Feature State patch must be an object or null');
  validateValue(patch, 'patch', 0, { nodes: 0 });
  return patch;
}

export function applyFeatureStateMergePatch(current, patch) {
  assertFeatureStatePatch(patch);
  if (patch === null) return null;
  const result = isPlainObject(current) ? clone(current) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isPlainObject(value)) result[key] = applyFeatureStateMergePatch(result[key], value);
    else result[key] = clone(value);
  }
  return result;
}

function conflict(path) {
  fail(`Feature State migration conflict at ${path}`, 'feature_state_migration_conflict');
}

function mergeCompatible(current, legacy, path) {
  if (current === undefined) return clone(legacy);
  if (JSON.stringify(current) === JSON.stringify(legacy)) return clone(current);
  if (!isPlainObject(current) || !isPlainObject(legacy)) conflict(path);
  const result = clone(current);
  for (const [key, value] of Object.entries(legacy)) {
    if (DANGEROUS_KEYS.has(key)) fail(`${path} contains a dangerous key`, 'feature_state_patch_unsafe_key');
    result[key] = mergeCompatible(result[key], value, `${path}.${key}`);
  }
  return result;
}

function legacyRecords(preferences) {
  let records = {};
  for (const key of [LEGACY_FEATURE_INTERACTION_STATE_KEY, FEATURE_STATE_KEY]) {
    const source = preferences?.[key];
    if (source === undefined) continue;
    if (!isPlainObject(source)) conflict(`preferences.${key}`);
    for (const [featureId, value] of Object.entries(source)) {
      if (!featureId.trim() || featureId.length > 160 || !isPlainObject(value)) {
        conflict(`preferences.${key}.${featureId || '(missing)'}`);
      }
      assertFeatureStatePatch(value);
      records[featureId] = mergeCompatible(records[featureId], value, `preferences.${key}.${featureId}`);
    }
  }
  return records;
}

export function migrateLegacySceneFeatureStates(rawState) {
  if (!isPlainObject(rawState)) throw new TypeError('Feature State migration requires a state object');
  const preferences = isPlainObject(rawState.preferences) ? rawState.preferences : {};
  const hasLegacy = Object.prototype.hasOwnProperty.call(preferences, FEATURE_STATE_KEY)
    || Object.prototype.hasOwnProperty.call(preferences, LEGACY_FEATURE_INTERACTION_STATE_KEY);
  if (!hasLegacy) return Object.freeze({ state: clone(rawState), migrated: false });

  const next = clone(rawState);
  next.preferences = isPlainObject(next.preferences) ? next.preferences : {};
  const world = next.preferences.worldV2;
  if (!isPlainObject(world) || !Array.isArray(world.scenes)) {
    fail('Feature State migration requires World V2', 'world_v2_required');
  }
  const activeSceneId = String(world.activeSceneId ?? '');
  const scene = world.scenes.find(item => String(item?.id ?? '') === activeSceneId);
  if (!scene) fail(`Feature State migration cannot find active Scene: ${activeSceneId}`, 'invalid_reference');
  const canonical = isPlainObject(scene.featureStates) ? clone(scene.featureStates) : {};
  for (const [featureId, value] of Object.entries(legacyRecords(preferences))) {
    canonical[featureId] = mergeCompatible(canonical[featureId], value, `scene.${activeSceneId}.featureStates.${featureId}`);
  }
  scene.featureStates = canonical;
  delete next.preferences[FEATURE_STATE_KEY];
  delete next.preferences[LEGACY_FEATURE_INTERACTION_STATE_KEY];
  return Object.freeze({ state: next, migrated: true });
}

export function stripLegacyFeatureStateProjection(rawState) {
  const next = clone(rawState);
  if (isPlainObject(next?.preferences)) {
    delete next.preferences[FEATURE_STATE_KEY];
    delete next.preferences[LEGACY_FEATURE_INTERACTION_STATE_KEY];
  }
  return next;
}

export function normalizeFeatureStateRecords(value) {
  if (!isPlainObject(value)) return {};
  const result = {};
  for (const [featureId, record] of Object.entries(value)) {
    if (!featureId.trim() || featureId.length > 160 || !isPlainObject(record)) continue;
    assertFeatureStatePatch(record);
    result[featureId] = clone(record);
  }
  return result;
}
