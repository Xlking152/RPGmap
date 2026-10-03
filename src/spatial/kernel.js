import { polygonDifference, polygonArea } from '../engine/geometry.js';
import { isIndexableOccluderCollection, queryOccluders } from './index.js';
import { resolveEffectiveOcclusionShapes } from '../vision/occlusion-model.js';

const EPSILON = 1e-9;
const NORMALIZED_VISION_OCCLUDERS = new WeakSet();
const LIGHTING_CACHE = new WeakMap();
const IMMUTABLE_LIGHTS = new WeakSet();
const VISION_HOST_FILTERS = new WeakMap();
const SOLID_AREAS = new WeakMap();
const NORMALIZED_SPATIAL_POINTS = new WeakSet();
const IMMUTABLE_SPATIAL_POINTS = new WeakMap();

function immutableLights(lights) {
  if (!Array.isArray(lights) || !Object.isFrozen(lights)) return false;
  if (IMMUTABLE_LIGHTS.has(lights)) return true;
  if (!lights.every(light => light && Object.isFrozen(light))) return false;
  IMMUTABLE_LIGHTS.add(lights);
  return true;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSpatialPoint(value, fallbackElevationMeters = 0) {
  if (NORMALIZED_SPATIAL_POINTS.has(value)) return value;
  const cached = IMMUTABLE_SPATIAL_POINTS.get(value);
  if (cached) return cached;
  const x = Number(value?.x);
  const y = Number(value?.y);
  const elevationMeters = value?.elevationMeters == null
    ? number(fallbackElevationMeters)
    : Number(value.elevationMeters);
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || !Number.isFinite(elevationMeters) || elevationMeters < 0) return null;
  const point = Object.freeze({ x, y, elevationMeters });
  NORMALIZED_SPATIAL_POINTS.add(point);
  // Only own immutable coordinates can be reused. Frozen wrappers with
  // getters, inherited coordinates or a caller-dependent height stay fresh.
  if (value && Object.isFrozen(value) && ['x', 'y', 'elevationMeters'].every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && Object.hasOwn(field, 'value') && Number.isFinite(field.value);
  })) IMMUTABLE_SPATIAL_POINTS.set(value, point);
  return point;
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
  const rawHeight = value?.blockingHeightMeters ?? value?.heightMeters;
  const height = rawHeight == null || rawHeight === 'unbounded' ? Infinity : Number(rawHeight);
  if (!polygon || Number.isNaN(height) || height < 0) return null;
  const polygons = value.polygons ?? [[polygon]];
  if (!Array.isArray(polygons)) return null;
  const regions = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length) return null;
    const region = rings.map(ring => occluderPolygon({ polygon: ring }));
    if (region.some(ring => !ring)) return null;
    regions.push(Object.freeze(region.map(ring => Object.freeze(ring.map(point => Object.freeze(point))))));
  }
  const normalized = Object.freeze({
    id: String(value?.id ?? value?.featureId ?? ''),
    featureId: value?.featureId == null ? null : String(value.featureId),
    shapeId: value?.shapeId == null ? null : String(value.shapeId),
    kind: value?.kind === 'building' || value?.kind === 'door' ? value.kind : 'wall',
    polygon: Object.freeze(polygon.map(point => Object.freeze(point))),
    polygons: Object.freeze(regions),
    blockingHeightMeters: height,
    passableWhenOpen: value?.passableWhenOpen === true,
    passableWhenDestroyed: value?.passableWhenDestroyed !== false,
  });
  NORMALIZED_VISION_OCCLUDERS.add(normalized);
  return normalized;
}

export function deriveVisionOccluders(mapPackage, scene = null, derivedScene = null) {
  const features = new Map((mapPackage?.features || []).map(feature => [String(feature.id), feature]));
  const shapes = resolveEffectiveOcclusionShapes(mapPackage, scene);
  const bindings = new Map(shapes.filter(shape => shape.enabled && shape.featureId).map(shape => [shape.featureId, shape]));
  const destroyed = new Set((derivedScene?.destroyedObjectIds || []).map(String));
  const states = scene?.featureStates && typeof scene.featureStates === 'object' ? scene.featureStates : {};
  const entries = new Map();
  const aliases = new Map();
  const doors = [];
  const add = raw => {
    const featureId = String(raw.featureId || raw.id);
    const feature = features.get(featureId);
    const state = states[featureId] || {};
    const vision = state.vision || {};
    const effectiveHeight = vision.blockingHeightMeters ?? state.custom?.blockingHeightMeters ?? raw.blockingHeightMeters;
    const occluder = normalizeVisionOccluder({ ...raw, blockingHeightMeters: effectiveHeight });
    if (!occluder) return;
    const open = typeof state.open === 'boolean' ? state.open
      : Boolean(feature?.interaction?.initialState?.open ?? feature?.interaction?.initialOpen ?? feature?.initialOpen);
    if (raw.hostShapeId) doors.push({ ...occluder, hostShapeId: raw.hostShapeId });
    // Turning off a door's blocker makes its existing aperture transparent;
    // it must not fill the opening with the host's original solid wall.
    if (vision.occluder === false) return;
    if (occluder.passableWhenDestroyed && destroyed.has(featureId)) return;
    let polygons = occluder.polygons;
    if (occluder.passableWhenDestroyed) for (const hit of derivedScene?.clipHits || []) {
      if (String(hit.featureId) === featureId) polygons = polygonDifference(polygons, hit.polygon);
    }
    if (!polygons.length) return;
    const prepared = normalizeVisionOccluder({ ...occluder, polygons });
    if (!(occluder.passableWhenOpen && open)) entries.set(occluder.id, prepared);
    if (raw.shapeId) aliases.set(raw.shapeId, occluder.id);
    if (raw.featureId) aliases.set(raw.featureId, occluder.id);
  };
  const legacy = Array.isArray(mapPackage?.visionOccluders) ? mapPackage.visionOccluders : null;
  const declared = legacy || [...features.values()].flatMap(feature => {
    const vision = feature?.capabilities?.vision;
    const binding = bindings.get(String(feature.id));
    if (states[feature.id]?.vision?.occluder !== true && !binding && vision?.occluder !== true) return [];
    const navigation = feature?.capabilities?.navigation || {};
    return [{ ...vision, id: vision?.id || feature.id, featureId: feature.id,
      kind: feature.capabilities?.openable ? 'door' : feature.category === 'building' ? 'building' : 'wall',
      polygon: vision?.polygon || navigation.blockingPolygon || feature?.geometry?.points,
      blockingHeightMeters: vision && Object.hasOwn(vision, 'blockingHeightMeters') ? vision.blockingHeightMeters : navigation.blockingHeightMeters,
      passableWhenOpen: vision?.passableWhenOpen ?? navigation.passableWhenOpen,
      passableWhenDestroyed: vision?.passableWhenDestroyed !== false }];
  });
  for (const raw of declared) {
    const feature = features.get(String(raw.featureId || raw.id));
    const binding = bindings.get(String(raw.featureId || raw.id));
    if (binding) continue;
    add({ ...raw, kind: raw.kind || (feature?.capabilities?.openable ? 'door' : feature?.category === 'building' ? 'building' : 'wall') });
  }
  for (const shape of shapes) {
    if (!shape.enabled) continue;
    const feature = features.get(shape.featureId);
    const vision = feature?.capabilities?.vision;
    add({ id: shape.featureId || shape.id, featureId: shape.featureId, shapeId: shape.id,
      kind: shape.kind, polygon: shape.points, hostShapeId: shape.hostShapeId,
      blockingHeightMeters: shape.blockingHeightMeters,
      passableWhenOpen: shape.kind === 'door' || vision?.passableWhenOpen === true,
      passableWhenDestroyed: vision?.passableWhenDestroyed !== false });
  }
  // A door always cuts its aperture from the host. A closed door contributes
  // its own blocker, so its height and destruction remain independent.
  for (const door of doors) {
    const hostId = aliases.get(door.hostShapeId) || door.hostShapeId;
    const host = entries.get(hostId);
    if (!host || host.kind === 'door') continue;
    let polygons = host.polygons;
    for (const aperture of door.polygons) polygons = polygonDifference(polygons, [aperture]);
    if (polygons.length) entries.set(hostId, normalizeVisionOccluder({ ...host, polygons }));
    else entries.delete(hostId);
  }
  return [...entries.values()];
}

function distanceToEdge(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - a[0] - t * dx, point.y - a[1] - t * dy);
}

/** Host exclusion is derived from the source position, never a supplied exclusion ID. */
export function resolveSourceHostOccluderId(source, occluders = [], metersPerUnit = 1) {
  if (source?.placement === 'feature' || !(source?.tokenId || source?.allowHostExemption === true)) return null;
  const point = normalizeSpatialPoint(source);
  if (!point) return null;
  const epsilon = 1e-7 / Math.max(1e-6, number(metersPerUnit, 1));
  const candidates = [];
  for (const raw of queryOccluders(occluders, [point.x, point.y, point.x, point.y])) {
    const obstacle = normalizeVisionOccluder(raw);
    if (!obstacle || obstacle.kind !== 'building' || point.elevationMeters > obstacle.blockingHeightMeters) continue;
    const inside = obstacle.polygons.some(([outer, ...holes]) => pointInPolygon(point, outer)
      && !holes.some(hole => pointInPolygon(point, hole))
      && [outer, ...holes].every(ring => ring.every((a, i) => distanceToEdge(point, a, ring[(i + 1) % ring.length]) > epsilon)));
    if (inside) {
      if (!SOLID_AREAS.has(obstacle)) SOLID_AREAS.set(obstacle, polygonArea(obstacle.polygons));
      candidates.push({ id: obstacle.id, area: SOLID_AREAS.get(obstacle) });
    }
  }
  candidates.sort((a, b) => a.area - b.area || a.id.localeCompare(b.id));
  return candidates[0]?.id || null;
}

export function visionOccludersForSource(source, occluders = [], metersPerUnit = 1) {
  const hostId = resolveSourceHostOccluderId(source, occluders, metersPerUnit);
  if (!hostId) return occluders;
  if (!isIndexableOccluderCollection(occluders)) return Object.freeze(occluders.filter(occluder => String(occluder?.id) !== hostId));
  let entries = VISION_HOST_FILTERS.get(occluders);
  if (!entries) { entries = new Map(); VISION_HOST_FILTERS.set(occluders, entries); }
  if (!entries.has(hostId)) {
    if (entries.size >= 512) entries.delete(entries.keys().next().value);
    entries.set(hostId, Object.freeze(occluders.filter(occluder => String(occluder.id) !== hostId)));
  }
  return entries.get(hostId);
}

// X-ray changes perception only: it bypasses solid Feature occlusion without
// changing range, lighting, movement, or collision rules.
export function visionIgnoresOcclusion(vision) {
  return vision?.senses?.xrayVision === true;
}

export function inspectLineOfSight({
  from,
  to,
  occluders = [],
  metersPerUnit = 1,
  excludedFeatureIds = [],
  applySourceHostExemption = false,
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
  const visualOccluders = applySourceHostExemption ? visionOccludersForSource(from, occluders, metersPerUnit) : occluders;
  for (const raw of queryOccluders(visualOccluders, rayBounds)) {
    const occluder = normalizeVisionOccluder(raw);
    if (!occluder || excluded.has(String(occluder.featureId || occluder.id))) continue;
    const polygon = occluder.polygon;
    if (polygon.every(point => point[0] < rayBounds[0])
      || polygon.every(point => point[0] > rayBounds[2])
      || polygon.every(point => point[1] < rayBounds[1])
      || polygon.every(point => point[1] > rayBounds[3])) continue;
    // Ring crossings partition the ray into intervals wholly inside or outside
    // the remaining solid. Hole boundaries alone must not block a clear ray.
    const intersections = [0, 1];
    for (const rings of occluder.polygons) for (const ring of rings) {
      for (let index = 0; index < ring.length; index += 1) {
        const t = segmentIntersectionT(start, end, ring[index], ring[(index + 1) % ring.length]);
        if (t != null && t > 0 && t < 1) intersections.push(t);
      }
    }
    intersections.sort((left, right) => left - right);
    let blockedAt;
    const slope = end.elevationMeters - start.elevationMeters;
    for (let index = 1; index < intersections.length; index += 1) {
      const first = intersections[index - 1], last = intersections[index];
      if (last - first <= EPSILON) continue;
      const middle = (first + last) / 2;
      const point = { x: start.x + (end.x - start.x) * middle, y: start.y + (end.y - start.y) * middle };
      if (!occluder.polygons.some(([outer, ...holes]) => pointInPolygon(point, outer)
        && !holes.some(hole => pointInPolygon(point, hole)))) continue;
      if (start.elevationMeters + slope * first <= occluder.blockingHeightMeters + EPSILON) blockedAt = first;
      else if (slope < 0 && start.elevationMeters + slope * last <= occluder.blockingHeightMeters + EPSILON) {
        blockedAt = (occluder.blockingHeightMeters - start.elevationMeters) / slope;
      }
      if (blockedAt !== undefined) break;
    }
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

export function resolveLineOfSightEnabled() {
  // Feature occlusion is part of character perception in v2.4.5. The legacy
  // Scene/User switches remain readable for save compatibility but cannot
  // disable the authoritative visibility rule.
  return true;
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
  let cache, key;
  if (immutableLights(lights) && isIndexableOccluderCollection(options.occluders)) {
    let byGeometry = LIGHTING_CACHE.get(lights);
    if (!byGeometry) { byGeometry = new WeakMap(); LIGHTING_CACHE.set(lights, byGeometry); }
    cache = byGeometry.get(options.occluders);
    if (!cache) { cache = new Map(); byGeometry.set(options.occluders, cache); }
    key = `${point.x}:${point.y}:${point.elevationMeters || 0}:${options.metersPerUnit || 1}:${base}`;
    if (cache.has(key)) return cache.get(key);
  }
  const contribution = lightContributionAtPoint(point, lights, options);
  const result = Object.freeze(contribution >= 0.5 ? { level: 'normal', contribution, source: 'light' }
    : base === 'dim' || contribution > 0 ? { level: 'dim', contribution, source: contribution > 0 ? 'light' : 'ambient' }
    : { level: 'dark', contribution: 0, source: 'ambient' });
  if (cache && cache.size < 32768) cache.set(key, result);
  return result;
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
  if (lineOfSightEnabled && !inspectLineOfSight({ from: IMMUTABLE_SPATIAL_POINTS.has(vision) ? vision : { ...vision, ...source }, to: destination, occluders, metersPerUnit,
    applySourceHostExemption: true }).clear) return 'none';
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
