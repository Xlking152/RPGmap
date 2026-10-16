import { createLanzhouGeneratedArtAssets } from './assets.js';
import { applyLanzhouCapabilities } from './capabilities.js';
import {
  LANZHOU_FEATURE_TAXONOMY,
  LANZHOU_LAYER_PLAN,
  LANZHOU_REFERENCE_META,
} from './manifest.js';
import { createLanzhouMapPackage } from './package.js';
import { cleanMapPackagePresentation } from './presentation.js';

export function createLanzhouReferencePackage({ generatedArt = true } = {}) {
  const source = createLanzhouMapPackage(generatedArt ? createLanzhouGeneratedArtAssets() : {});
  const cachedSvg = source.svg;
  return cleanMapPackagePresentation({
    ...source,
    // createLanzhouMapPackage already materializes the static SVG once. Reuse it
    // during Core startup instead of regenerating the same ~200 KB map markup.
    createSvg: () => cachedSvg,
    features: applyLanzhouCapabilities(source.features, source.navigation),
    layerPlan: LANZHOU_LAYER_PLAN,
    featureTaxonomy: LANZHOU_FEATURE_TAXONOMY,
    reference: Object.freeze({
      ...LANZHOU_REFERENCE_META,
      note: 'Map-specific data/rendering only; interaction, destruction and Scene state belong to RPGmap Core.',
    }),
  });
}

export * from './capabilities.js';
export * from './manifest.js';
export * from './package.js';
export * from './presentation.js';
