export {
  FEATURE_ACTION_META,
  FEATURE_INTERACTION_STATE_KEY,
  FEATURE_STATE_KEY,
  LEGACY_FEATURE_INTERACTION_STATE_KEY,
  damageFeatureState,
  featureInteractionSnapshot,
  getFeatureInteractionState,
  getFeatureRuntimeState,
  listFeatureInteractions,
  patchFeatureRuntimeState,
  setFeatureCustomState,
  setFeatureOpenState,
} from './model.js';

export {
  featureInteractionEffectsRevision,
  recordFeatureInteractionEffects,
  runtimeFeatureInteractionEffects,
} from './effects.js';

export { createFeatureOperations } from './operations.js';
export { createFeatureInteractionSystem } from './system.js';
