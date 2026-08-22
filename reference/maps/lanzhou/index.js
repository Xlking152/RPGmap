import { createLanzhouGeneratedArtAssets } from './assets.js';
import { LANZHOU_LAYER_PLAN, LANZHOU_REFERENCE_META } from './manifest.js';
import { createLanzhouMapPackage } from './package.js';
import { cleanMapPackagePresentation } from './presentation.js';

const OPENABLE_FEATURE_IDS = new Set([
  'yamen-gate',
  'gate-north',
  'gate-east',
  'gate-south',
  'gate-west',
  'jincheng-gatehouse',
]);

function applyLanzhouInteractionCapabilities(features = []) {
  return features.map((feature) => {
    if (!OPENABLE_FEATURE_IDS.has(feature?.id)) return feature;
    const declared = feature.capabilities && typeof feature.capabilities === 'object'
      ? feature.capabilities
      : {};
    const declaredActions = declared.actions && typeof declared.actions === 'object'
      ? declared.actions
      : {};
    return Object.freeze({
      ...feature,
      openable: true,
      capabilities: Object.freeze({
        ...declared,
        inspectable: true,
        interactive: true,
        openable: true,
        actions: Object.freeze({
          ...declaredActions,
          inspect: true,
          open: true,
          close: true,
        }),
      }),
      interaction: Object.freeze({
        ...(feature.interaction || {}),
        initialOpen: false,
      }),
    });
  });
}

export function createLanzhouReferencePackage({ generatedArt = true } = {}) {
  const source = createLanzhouMapPackage(generatedArt ? createLanzhouGeneratedArtAssets() : {});
  return cleanMapPackagePresentation({
    ...source,
    features: applyLanzhouInteractionCapabilities(source.features),
    layerPlan: LANZHOU_LAYER_PLAN,
    reference: Object.freeze({
      ...LANZHOU_REFERENCE_META,
      note: 'Map-specific data/rendering only; interaction, destruction and Scene state belong to RPGmap Core.',
    }),
  });
}

export * from './manifest.js';
export * from './package.js';
export * from './presentation.js';
