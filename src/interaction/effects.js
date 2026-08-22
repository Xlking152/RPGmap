const runtimeFeatureEffects = new WeakMap();
let effectsRevision = 0;

function initialOpen(feature) {
  return Boolean(
    feature?.interaction?.initialState?.open
    ?? feature?.interaction?.initialOpen
    ?? feature?.initialOpen
    ?? false
  );
}

function normalizeEffects(feature, featureState = {}) {
  return Object.freeze({
    open: typeof featureState.open === 'boolean' ? featureState.open : initialOpen(feature),
    status: typeof featureState.status === 'string' ? featureState.status : 'intact',
    damaged: featureState.damaged === true,
    destroyed: featureState.destroyed === true,
  });
}

export function recordFeatureInteractionEffects(feature, featureState = {}) {
  if (!feature || (typeof feature !== 'object' && typeof feature !== 'function')) return;
  const next = normalizeEffects(feature, featureState);
  const previous = runtimeFeatureEffects.get(feature);
  if (!previous
    || previous.open !== next.open
    || previous.status !== next.status
    || previous.damaged !== next.damaged
    || previous.destroyed !== next.destroyed) {
    runtimeFeatureEffects.set(feature, next);
    effectsRevision += 1;
  }
}

export function runtimeFeatureInteractionEffects(feature) {
  return runtimeFeatureEffects.get(feature) || normalizeEffects(feature);
}

export function featureInteractionEffectsRevision() {
  return effectsRevision;
}
