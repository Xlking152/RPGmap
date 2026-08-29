import { createFeatureControlLayer } from './control-layer.js';
import { createFeatureMapInspector } from './map-inspector.js';
import { createFeatureInteractionSystem as createCoreFeatureInteractionSystem } from './system.js';

export {
  FEATURE_ACTION_META,
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
  recordFeatureInteractionEffects,
  runtimeFeatureInteractionEffects,
} from './effects.js';

export {
  featureCategoryLabel,
  featureDetailRows,
  featureEntranceText,
  featureLocationLabel,
  featureSubtypeLabel,
  tokenFeatureId,
  tokensInsideFeature,
} from './ui-model.js';

export {
  featureControlAction,
  featureControlDescriptor,
  featureControlTitle,
} from './control-model.js';

export { createFeatureControlLayer };
export { createFeatureMapInspector, featureAtMapLatLng } from './map-inspector.js';
export { createFeatureOperations } from './operations.js';
export {
  evaluateFeatureStatusRule,
  featureStatusMutations,
  featureStatusRule,
} from './status-rules.js';

/**
 * Register the generic Feature API first, then mount map-facing entry points on
 * top of that same API. The direct map inspector and open/close controls are UI
 * adapters only; neither owns a second Feature-state machine.
 */
export function createFeatureInteractionSystem() {
  const core = createCoreFeatureInteractionSystem();
  const inspector = createFeatureMapInspector();
  const controls = createFeatureControlLayer();
  return Object.freeze({
    register(api) {
      core.register(api);
      inspector.register(api);
      controls.register(api);
    },
  });
}
