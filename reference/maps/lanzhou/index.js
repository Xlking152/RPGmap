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

function applyLanzhouCapabilities(features = [], navigation = {}) {
  const gatewayByFeatureId = new Map(
    (navigation.gateways || []).map((gateway) => [String(gateway.featureId), gateway]),
  );

  return features.map((feature) => {
    const declared = feature.capabilities && typeof feature.capabilities === 'object'
      ? feature.capabilities
      : {};
    const declaredActions = declared.actions && typeof declared.actions === 'object'
      ? declared.actions
      : {};
    const openable = OPENABLE_FEATURE_IDS.has(feature?.id);
    const gateway = gatewayByFeatureId.get(String(feature?.id));

    let navigationCapability = declared.navigation || null;
    if (feature.category === 'building') {
      navigationCapability = Object.freeze({ blocks: true });
    } else if (feature.category === 'wall') {
      navigationCapability = Object.freeze({
        blocks: true,
        passableWhenDestroyed: true,
        damageCreatesPassage: true,
      });
    }

    if (openable) {
      navigationCapability = Object.freeze({
        ...(navigationCapability || {}),
        blocks: true,
        passableWhenOpen: true,
        passableWhenDestroyed: true,
        passageTile: 'road',
        passagePolygon: gateway?.polygon || feature.geometry?.points || null,
      });
    }

    if (!openable && !navigationCapability) return feature;

    return Object.freeze({
      ...feature,
      ...(openable ? { openable: true } : {}),
      capabilities: Object.freeze({
        ...declared,
        ...(openable ? {
          inspectable: true,
          interactive: true,
          openable: true,
          actions: Object.freeze({
            ...declaredActions,
            inspect: true,
            open: true,
            close: true,
          }),
        } : {}),
        navigation: navigationCapability,
      }),
      ...(openable ? {
        interaction: Object.freeze({
          ...(feature.interaction || {}),
          initialOpen: false,
        }),
      } : {}),
    });
  });
}

export function createLanzhouReferencePackage({ generatedArt = true } = {}) {
  const source = createLanzhouMapPackage(generatedArt ? createLanzhouGeneratedArtAssets() : {});
  return cleanMapPackagePresentation({
    ...source,
    features: applyLanzhouCapabilities(source.features, source.navigation),
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
