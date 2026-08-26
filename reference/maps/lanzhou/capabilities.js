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
const GATE_BARRIER_OVERLAP_METERS = 45;

function finiteHeight(value) {
  const height = Number(value);
  return Number.isFinite(height) && height >= 0 ? height : null;
}

function distance(a, b) {
  return Math.hypot(Number(b[0]) - Number(a[0]), Number(b[1]) - Number(a[1]));
}

function normalizedVector(a, b) {
  const dx = Number(b[0]) - Number(a[0]);
  const dy = Number(b[1]) - Number(a[1]);
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 0) return null;
  return [dx / length, dy / length];
}

function featureCenter(feature, points) {
  if (Array.isArray(feature?.center) && feature.center.length >= 2) {
    return [Number(feature.center[0]), Number(feature.center[1])];
  }
  const sum = points.reduce((result, point) => [result[0] + Number(point[0]), result[1] + Number(point[1])], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

/**
 * Lanzhou city/pass gates are rendered as gatehouses, while the wall opening
 * reserved around several gates is wider than the visible Feature rectangle.
 * The closed Navigation blocker therefore needs its own cross-opening barrier
 * polygon; otherwise a 10 m A* cell can slip around the left/right edge of a
 * closed gatehouse. This is map content geometry, not a Core gate special-case.
 */
function gateBlockingPolygon(feature) {
  const points = feature?.geometry?.points;
  if (!Array.isArray(points) || points.length < 4) return feature?.geometry?.points || null;
  const widthAxis = normalizedVector(points[0], points[1]);
  const depthAxis = normalizedVector(points[1], points[2]);
  if (!widthAxis || !depthAxis) return points;

  const center = featureCenter(feature, points);
  const visibleWidth = distance(points[0], points[1]);
  const visibleDepth = distance(points[1], points[2]);
  const barrierWidth = visibleWidth + GATE_BARRIER_OVERLAP_METERS * 2;
  const barrierDepth = Math.max(24, Math.min(40, visibleDepth * 0.28));
  const halfWidth = barrierWidth / 2;
  const halfDepth = barrierDepth / 2;

  return Object.freeze([
    Object.freeze([
      center[0] - widthAxis[0] * halfWidth - depthAxis[0] * halfDepth,
      center[1] - widthAxis[1] * halfWidth - depthAxis[1] * halfDepth,
    ]),
    Object.freeze([
      center[0] + widthAxis[0] * halfWidth - depthAxis[0] * halfDepth,
      center[1] + widthAxis[1] * halfWidth - depthAxis[1] * halfDepth,
    ]),
    Object.freeze([
      center[0] + widthAxis[0] * halfWidth + depthAxis[0] * halfDepth,
      center[1] + widthAxis[1] * halfWidth + depthAxis[1] * halfDepth,
    ]),
    Object.freeze([
      center[0] - widthAxis[0] * halfWidth + depthAxis[0] * halfDepth,
      center[1] - widthAxis[1] * halfWidth + depthAxis[1] * halfDepth,
    ]),
  ]);
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
        collisionGroup: 'structure',
        blockingHeightFt: declaredHeight ?? LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT.building,
      });
    } else if (feature.category === 'wall') {
      navigationCapability = Object.freeze({
        ...declaredNavigation,
        blocks: true,
        collisionGroup: 'structure',
        passableWhenDestroyed: true,
        damageCreatesPassage: true,
        blockingHeightFt: declaredHeight ?? LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT.wall,
      });
    }

    if (openable) {
      navigationCapability = Object.freeze({
        ...(navigationCapability || {}),
        blocks: true,
        collisionGroup: 'structure',
        passableWhenOpen: true,
        passableWhenDestroyed: true,
        blockingHeightFt: declaredHeight ?? LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT.openable,
        blockingPolygon: declaredNavigation.blockingPolygon || gateBlockingPolygon(feature),
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
