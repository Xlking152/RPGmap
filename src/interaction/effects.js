const runtimeFeatureEffects = new WeakMap();

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
  runtimeFeatureEffects.set(feature, normalizeEffects(feature, featureState));
}

export function runtimeFeatureInteractionEffects(feature) {
  return runtimeFeatureEffects.get(feature) || normalizeEffects(feature);
}
