const runtimeFeatureEffects = new WeakMap();
let effectsRevision = 0;

function initialOpen(feature) {
  return Boolean(feature?.interaction?.initialOpen ?? feature?.initialOpen ?? false);
}

export function recordFeatureInteractionEffects(feature, interactionState = {}) {
  if (!feature || (typeof feature !== 'object' && typeof feature !== 'function')) return;
  const next = Object.freeze({ open: Boolean(interactionState.open) });
  const previous = runtimeFeatureEffects.get(feature);
  if (!previous || previous.open !== next.open) {
    runtimeFeatureEffects.set(feature, next);
    effectsRevision += 1;
  }
}

export function runtimeFeatureInteractionEffects(feature) {
  return runtimeFeatureEffects.get(feature) || Object.freeze({ open: initialOpen(feature) });
}

export function featureInteractionEffectsRevision() {
  return effectsRevision;
}
