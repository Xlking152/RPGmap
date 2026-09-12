const EPSILON = 1e-9;
const NORMALIZED_VISION_OCCLUDERS = new WeakSet();

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSpatialPoint(value, fallbackElevationMeters = 0) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const elevationMeters = value?.elevationMeters == null
    ? number(fallbackElevationMeters)
    : Number(value.elevationMeters);
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || !Number.isFinite(elevationMeters) || elevationMeters < 0) return null;
  return Object.freeze({ x, y, elevationMeters });
}

export function distance3dMeters(from, to, metersPerUnit = 1) {
  const first = normalizeSpatialPoint(from);
  const second = normalizeSpatialPoint(to);
  if (!first || !second) return Number.POSITIVE_INFINITY;
  const scale = Number(metersPerUnit);
  const units = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.hypot(
    (second.x - first.x) * units,
    (second.y - first.y) * units,
    second.elevationMeters - first.elevationMeters,
  );
}

export function sphereGroundRadiusMeters(rangeMeters, elevationMeters = 0) {
  const range = Math.max(0, number(rangeMeters));
  const elevation = Math.max(0, number(elevationMeters));
  if (elevation >= range) return elevation === range ? 0 : null;
  return Math.sqrt(Math.max(0, range * range - elevation * elevation));
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function segmentIntersectionT(from, to, first, second) {
  const rx = to.x - from.x;
  const ry = to.y - from.y;
  const sx = second[0] - first[0];
  const sy = second[1] - first[1];
  const denominator = cross(rx, ry, sx, sy);
  if (Math.abs(denominator) <= EPSILON) return null;
  const qx = first[0] - from.x;
  const qy = first[1] - from.y;
  const t = cross(qx, qy, sx, sy) / denominator;
  const u = cross(qx, qy, rx, ry) / denominator;
  return t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON ? t : null;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[previous];
    const intersects = (y1 > point.y) !== (y2 > point.y)
      && point.x < ((x2 - x1) * (point.y - y1)) / ((y2 - y1) || EPSILON) + x1;
    if (intersects) inside = !inside;
  }
  return inside;
}

function occluderPolygon(value) {
  const source = value?.polygon ?? value?.blockingPolygon ?? value?.geometry?.points;
  if (!Array.isArray(source) || source.length < 3) return null;
  const polygon = source.map(point => [Number(point?.[0]), Number(point?.[1])]);
  return polygon.every(point => point.every(Number.isFinite)) ? polygon : null;
}

export function normalizeVisionOccluder(value) {
  if (NORMALIZED_VISION_OCCLUDERS.has(value)) return value;
  const polygon = occluderPolygon(value);
  const height = Number(value?.blockingHeightMeters ?? value?.heightMeters);
  if (!polygon || !Number.isFinite(height) || height < 0) return null;
  const normalized = Object.freeze({
    id: String(value?.id ?? value?.featureId ?? ''),
    featureId: value?.featureId == null ? null : String(value.featureId),
    polygon: Object.freeze(polygon.map(point => Object.freeze(point))),
    blockingHeightMeters: height,
    passableWhenOpen: value?.passableWhenOpen === true,
    passableWhenDestroyed: value?.passableWhenDestroyed !== false,
  });
  NORMALIZED_VISION_OCCLUDERS.add(normalized);
  return normalized;
}

export function deriveVisionOccluders(mapPackage, scene = null, derivedScene = null) {
  const declared = Array.isArray(mapPackage?.visionOccluders)
    ? mapPackage.visionOccluders
    : (mapPackage?.features || []).flatMap(feature => {
      const vision = feature?.capabilities?.vision;
      if (vision?.occluder !== true) return [];
      return [{
        ...vision,
        id: vision.id || feature.id,
        featureId: feature.id,
        polygon: vision.polygon || feature?.capabilities?.navigation?.blockingPolygon || feature?.geometry?.points,
      }];
    });
  const destroyed = new Set((derivedScene?.destroyedObjectIds || []).map(String));
  const states = scene?.featureStates && typeof scene.featureStates === 'object' ? scene.featureStates : {};
  return declared.flatMap(raw => {
    const occluder = normalizeVisionOccluder(raw);
    if (!occluder) return [];
    const featureId = String(occluder.featureId || occluder.id);
    if (occluder.passableWhenOpen && states[featureId]?.open === true) return [];
    if (occluder.passableWhenDestroyed && destroyed.has(featureId)) return [];
    return [occluder];
  });
}

export function inspectLineOfSight({
  from,
  to,
  occluders = [],
  metersPerUnit = 1,
  excludedFeatureIds = [],
} = {}) {
  const start = normalizeSpatialPoint(from);
  const end = normalizeSpatialPoint(to);
  if (!start || !end) return Object.freeze({ clear: false, code: 'spatial_point_invalid' });
  const excluded = new Set(excludedFeatureIds.map(String));
  const scale = Number.isFinite(Number(metersPerUnit)) && Number(metersPerUnit) > 0 ? Number(metersPerUnit) : 1;
  const rayBounds = [
    Math.min(start.x, end.x), Math.min(start.y, end.y),
    Math.max(start.x, end.x), Math.max(start.y, end.y),
  ];
  for (const raw of occluders) {
    const occluder = normalizeVisionOccluder(raw);
    if (!occluder || excluded.has(String(occluder.featureId || occluder.id))) continue;
    const polygon = occluder.polygon;
    if (polygon.every(point => point[0] < rayBounds[0])
      || polygon.every(point => point[0] > rayBounds[2])
      || polygon.every(point => point[1] < rayBounds[1])
      || polygon.every(point => point[1] > rayBounds[3])) continue;
    const intersections = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const t = segmentIntersectionT(start, end, polygon[index], polygon[(index + 1) % polygon.length]);
      if (t != null && t > EPSILON && t < 1 - EPSILON) intersections.push(t);
    }
    if (pointInPolygon(start, polygon)) intersections.push(EPSILON);
    if (pointInPolygon(end, polygon)) intersections.push(1 - EPSILON);
    const blockedAt = intersections.sort((left, right) => left - right).find(t => {
      const elevation = start.elevationMeters + (end.elevationMeters - start.elevationMeters) * t;
      return elevation <= occluder.blockingHeightMeters + EPSILON;
    });
    if (blockedAt !== undefined) {
      return Object.freeze({
        clear: false,
        code: 'line_of_sight_blocked',
        occluderId: occluder.id,
        featureId: occluder.featureId,
        distanceMeters: distance3dMeters(start, {
          x: start.x + (end.x - start.x) * blockedAt,
          y: start.y + (end.y - start.y) * blockedAt,
          elevationMeters: start.elevationMeters + (end.elevationMeters - start.elevationMeters) * blockedAt,
        }, scale),
      });
    }
  }
  return Object.freeze({ clear: true, code: 'ok' });
}

export function resolveLineOfSightEnabled(scene, userOverride = null) {
  if (typeof userOverride === 'boolean') return userOverride;
  return scene?.settings?.lineOfSightEnabled === true;
}

export function lightContributionAtPoint(point, lights = [], {
  occluders = [],
  metersPerUnit = 1,
} = {}) {
  let brightest = 0;
  for (const light of lights) {
    if (light?.enabled === false) continue;
    const range = Math.max(0, number(light?.rangeMeters));
    if (!range) continue;
    const distance = distance3dMeters(light, point, metersPerUnit);
    if (distance > range) continue;
    if (light?.occlusion !== 'none'
      && !inspectLineOfSight({ from: light, to: point, occluders, metersPerUnit }).clear) continue;
    brightest = Math.max(brightest, Math.max(0, 1 - distance / range) * Math.max(0, number(light?.intensity, 1)));
  }
  return Math.min(1, brightest);
}

export function normalizeLightSource(value) {
  const point = normalizeSpatialPoint(value);
  const rangeMeters = Math.max(0, number(value?.rangeMeters));
  if (!point || rangeMeters <= 0 || value?.enabled === false) return null;
  return Object.freeze({
    ...point,
    id: String(value?.id ?? ''),
    rangeMeters,
    intensity: Math.max(0, Math.min(4, number(value?.intensity, 1))),
    color: /^#[0-9a-f]{6}$/i.test(String(value?.color || '')) ? String(value.color) : '#fff3c4',
    occlusion: value?.occlusion === 'none' ? 'none' : 'scene',
  });
}

export function deriveSceneLightSources(mapPackage, scene = null) {
  const declared = Array.isArray(mapPackage?.lights) ? mapPackage.lights : [];
  const tokenLights = (Array.isArray(scene?.tokens) ? scene.tokens : []).flatMap(token => {
    if (token?.placement !== 'map' || token?.light?.enabled !== true) return [];
    return [{
      ...token.light,
      id: `token-light:${String(token.id || '')}`,
      x: Number(token.x),
      y: Number(token.y),
      elevationMeters: (Number(token.elevationMeters) || 0) + (Number(token.light.elevationOffsetMeters) || 0),
    }];
  });
  return [...declared, ...tokenLights].flatMap(value => normalizeLightSource(value) || []);
}

export function resolveLightingAtPoint(point, ambient = 'normal', lights = [], options = {}) {
  const base = ['normal', 'dim', 'dark'].includes(String(ambient)) ? String(ambient) : 'normal';
  if (base === 'normal') return Object.freeze({ level: 'normal', contribution: 1, source: 'ambient' });
  const contribution = lightContributionAtPoint(point, lights, options);
  if (contribution >= 0.5) return Object.freeze({ level: 'normal', contribution, source: 'light' });
  if (base === 'dim' || contribution > 0) return Object.freeze({ level: 'dim', contribution, source: contribution > 0 ? 'light' : 'ambient' });
  return Object.freeze({ level: 'dark', contribution: 0, source: 'ambient' });
}

export function perceptionLevelAtPoint({
  vision,
  target,
  ambient = 'normal',
  lights = [],
  occluders = [],
  metersPerUnit = 1,
  lineOfSightEnabled = false,
} = {}) {
  const source = normalizeSpatialPoint(vision, vision?.elevationMeters);
  const destination = normalizeSpatialPoint(target, target?.elevationMeters);
  if (!source || !destination) return 'none';
  const distance = distance3dMeters(source, destination, metersPerUnit);
  let level = distance <= Math.max(0, number(vision?.preciseRangeMeters ?? vision?.rangeMeters)) ? 'precise'
    : distance <= Math.max(0, number(vision?.vagueRangeMeters)) ? 'vague' : 'none';
  if (level === 'none') return level;
  if (lineOfSightEnabled && !inspectLineOfSight({ from: source, to: destination, occluders, metersPerUnit }).clear) return 'none';
  if (level === 'precise') {
    const lighting = resolveLightingAtPoint(destination, ambient, lights, { occluders, metersPerUnit });
    const senses = vision?.senses || {};
    if ((lighting.level === 'dim' && senses.lowLightVision !== true)
      || (lighting.level === 'dark' && senses.darkvision !== true)) level = 'vague';
  }
  return level;
}

export function isPathPreciselyVisible(points, vision, options = {}) {
  if (!vision || !Array.isArray(points) || !points.length) return false;
  const source = normalizeSpatialPoint(vision, vision.elevationMeters);
  if (!source) return false;
  return points.every(point => perceptionLevelAtPoint({
    vision: source === vision ? vision : { ...vision, ...source },
    target: point,
    ambient: options.ambient || vision.lighting || 'normal',
    lights: options.lights || [],
    occluders: options.occluders || [],
    metersPerUnit: options.metersPerUnit,
    lineOfSightEnabled: options.lineOfSightEnabled === true,
  }) === 'precise');
}
