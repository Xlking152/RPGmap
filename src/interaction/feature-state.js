import { featureSceneStatus } from '../engine/feature-selection.js';

export const FEATURE_STATE_KEY = 'featureStates';
export const LEGACY_FEATURE_INTERACTION_STATE_KEY = 'featureInteractions';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneRecord(value) {
  return isPlainObject(value) ? structuredClone(value) : {};
}

function initialOpen(feature) {
  return Boolean(
    feature?.interaction?.initialState?.open
    ?? feature?.interaction?.initialOpen
    ?? feature?.initialOpen
    ?? false
  );
}

function initialCustom(feature) {
  const source = feature?.interaction?.initialState?.custom
    ?? feature?.interaction?.customState
    ?? feature?.initialState?.custom;
  return cloneRecord(source);
}

function persistedState(state, featureId) {
  const preferences = state?.preferences;
  if (!isPlainObject(preferences)) return {};
  const current = preferences[FEATURE_STATE_KEY]?.[featureId];
  if (isPlainObject(current)) return current;
  const legacy = preferences[LEGACY_FEATURE_INTERACTION_STATE_KEY]?.[featureId];
  return isPlainObject(legacy) ? legacy : {};
}

export function getFeatureState(state, feature) {
  if (!feature?.id) throw new TypeError('Feature State requires a Feature with an id');
  const saved = persistedState(state, String(feature.id));
  const status = featureSceneStatus(feature.id, state?.sceneEvents || []);
  const open = typeof saved.open === 'boolean' ? saved.open : initialOpen(feature);
  const custom = Object.freeze({
    ...initialCustom(feature),
    ...cloneRecord(saved.custom),
  });
  return Object.freeze({
    open,
    status,
    damaged: status !== 'intact',
    destroyed: status === 'destroyed',
    custom,
  });
}

export function patchFeatureState(state, featureId, patch = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Feature State requires a state object');
  const id = String(featureId ?? '').trim();
  if (!id) throw new TypeError('Feature State requires featureId');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Feature State patch must be an object');
  }

  const next = structuredClone(state);
  next.preferences ||= {};
  next.preferences[FEATURE_STATE_KEY] ||= {};

  const legacy = next.preferences[LEGACY_FEATURE_INTERACTION_STATE_KEY]?.[id];
  const current = next.preferences[FEATURE_STATE_KEY][id];
  const record = {
    ...(isPlainObject(legacy) ? legacy : {}),
    ...(isPlainObject(current) ? current : {}),
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'open')) {
    if (typeof patch.open !== 'boolean') throw new TypeError('Feature State open must be boolean');
    record.open = patch.open;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'custom')) {
    if (patch.custom === null) delete record.custom;
    else if (!isPlainObject(patch.custom)) throw new TypeError('Feature State custom must be an object or null');
    else record.custom = structuredClone(patch.custom);
  }

  next.preferences[FEATURE_STATE_KEY][id] = record;
  return next;
}

export function setFeatureCustomState(state, featureId, custom) {
  return patchFeatureState(state, featureId, { custom });
}
