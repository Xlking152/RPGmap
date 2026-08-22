import { createLanzhouGeneratedArtAssets } from './assets.js';
import { LANZHOU_LAYER_PLAN, LANZHOU_REFERENCE_META } from './manifest.js';
import { createLanzhouMapPackage } from './package.js';
import { cleanMapPackagePresentation } from './presentation.js';

export function createLanzhouReferencePackage({ generatedArt = true } = {}) {
  const source = createLanzhouMapPackage(generatedArt ? createLanzhouGeneratedArtAssets() : {});
  return cleanMapPackagePresentation({
    ...source,
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
