export {
  FEATURE_ACTION_META,
  FEATURE_INTERACTION_STATE_KEY,
  damageFeatureState,
  featureInteractionSnapshot,
  getFeatureInteractionState,
  listFeatureInteractions,
  setFeatureOpenState,
} from './model.js';

export {
  featureInteractionEffectsRevision,
  recordFeatureInteractionEffects,
  runtimeFeatureInteractionEffects,
} from './effects.js';

export { createFeatureInteractionSystem } from './system.js';
