export const LANZHOU_OPENABLE_FEATURE_IDS = Object.freeze([
  'yamen-gate',
  'gate-north',
  'gate-east',
  'gate-south',
  'gate-west',
  'jincheng-gatehouse',
]);

export const LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT = Object.freeze({
  building: 20,
  wall: 30,
  openable: 30,
});

const OPENABLE_FEATURE_IDS = new Set(LANZHOU_OPENABLE_FEATURE_IDS);

function finiteHeight(value) {
  const height = Number(value);
  return Number.isFinite(height) && height >= 0 ? height : null;
}

export function applyLanzhouCapabilities(features = [], navigation = {}) {
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
    const declaredNavigation = declared.navigation && typeof declared.navigation === 'object'
      ? declared.navigation
      : {};
    const declaredHeight = finiteHeight(declaredNavigation.blockingHeightFt);
    const openable = OPENABLE_FEATURE_IDS.has(feature?.id);
    const gateway = gatewayByFeatureId.get(String(feature?.id));

    let navigationCapability = declared.navigation || null;
    if (feature.category === 'building') {
      navigationCapability = Object.freeze({
        ...declaredNavigation,
        blocks: true,
        blockingHeightFt: declaredHeight ?? LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT.building,
      });
    } else if (feature.category === 'wall') {
      navigationCapability = Object.freeze({
        ...declaredNavigation,
        blocks: true,
        passableWhenDestroyed: true,
        damageCreatesPassage: true,
        blockingHeightFt: declaredHeight ?? LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT.wall,
      });
    }

    if (openable) {
      navigationCapability = Object.freeze({
        ...(navigationCapability || {}),
        blocks: true,
        passableWhenOpen: true,
        passableWhenDestroyed: true,
        blockingHeightFt: declaredHeight ?? LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT.openable,
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
