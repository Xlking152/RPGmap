import { polygonDifference, polygonArea, normalizePolygonGeometry, GeometryClipError } from '../engine/geometry.js';
import { deriveSceneState } from '../engine/state.js';
import { isIndexableOccluderCollection, queryOccluders } from './index.js';
import { resolveEffectiveOcclusionShapes } from '../vision/occlusion-model.js';
import { effectiveFeatureOpen } from '../world/feature-states.js';
import { hasImmutableVisionData } from '../vision/immutable-data.js';

const EPSILON = 1e-9;
const NORMALIZED_VISION_OCCLUDERS = new WeakSet();
const OWNED_VISION_OCCLUDER_COLLECTIONS = new WeakSet();
const VERIFIED_OWNED_VISION_COLLECTIONS = new WeakSet();
const LIGHTING_CACHE = new WeakMap();
const IMMUTABLE_LIGHTS = new WeakSet();
const VISION_HOST_FILTERS = new WeakMap();
const SOLID_AREAS = new WeakMap();
const RING_RAY_DATA = new WeakMap();
const OCCLUDER_RAY_BOUNDS = new WeakMap();
const CLEAR_RAY = Object.freeze({ clear: true, code: 'ok' });
const INVALID_RAY = Object.freeze({ clear: false, code: 'spatial_point_invalid' });
const OCCLUSION_GEOMETRY_CACHE = new WeakMap();
const MAX_OCCLUSION_GEOMETRY_ENTRIES = 512;
const MAX_FEATURE_GEOMETRY_VERSIONS = 2;
const PURE_COORDINATE_TREES = new WeakSet();
const clonePristineCoordinates = structuredClone;
const normalizationPlatform = [
  [globalThis, 'Number'], [globalThis, 'String'], [Array, 'isArray'],
  [Number, 'isFinite'], [Number, 'isNaN'], [Object, 'freeze'],
  ...['map', 'every', 'some', 'slice', 'push', 'pop', 'splice', 'at', Symbol.iterator]
    .map(key => [Array.prototype, key]),
].map(([owner, key]) => ({ owner, key, value: owner[key] }));
const stockNormalization = normalizationPlatform.every(({ value }) =>
  typeof value === 'function' && Function.prototype.toString.call(value).includes('[native code]'));

function normalizationPlatformUnchanged() {
  if (!stockNormalization || structuredClone !== clonePristineCoordinates
    || !normalizationPlatform.every(({ owner, key, value }) => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === value;
    })) return false;
  // Geometry normalization tests these inherited shape names even on arrays.
  for (const owner of [Object.prototype, Array.prototype]) for (const key of [
    'shape', 'attackShape', 'type', 'id', 'featureId', 'shapeId', 'kind', 'polygon', 'blockingPolygon',
    'heightMeters', 'passableWhenOpen', 'passableWhenDestroyed', 'polygons',
  ]) {
    if (Object.hasOwn(owner, key)) return false;
  }
  return true;
}

function pureCoordinateTree(value) {
  if (!hasImmutableVisionData(value)) return false;
  if (PURE_COORDINATE_TREES.has(value)) return true;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
    const item = value[index];
    if (typeof item === 'number' ? !Number.isFinite(item) : !pureCoordinateTree(item)) return false;
  }
  // Frozen Proxy wrappers can still intercept .map. The platform clone proves
  // the actual coordinate-array identity before this WeakSet can accept it.
  try { clonePristineCoordinates(value); } catch { return false; }
  PURE_COORDINATE_TREES.add(value);
  return true;
}

function reusablePristineInput(raw, effectiveHeight) {
  if (!normalizationPlatformUnchanged()) return null;
  const polygon = raw.polygon ?? raw.blockingPolygon;
  if (!pureCoordinateTree(polygon) || (raw.polygons != null && !pureCoordinateTree(raw.polygons))) return null;
  const scalars = [raw.id, raw.featureId, raw.shapeId, raw.kind,
    effectiveHeight ?? raw.heightMeters, raw.passableWhenOpen, raw.passableWhenDestroyed];
  if (!scalars.every(value => value == null || ['string', 'number', 'boolean'].includes(typeof value))) return null;
  return [polygon, raw.polygons, ...scalars];
}

function mapGeometryCache(map) {
  if (!map || typeof map !== 'object') return null;
  let cache = OCCLUSION_GEOMETRY_CACHE.get(map);
  if (!cache) {
    cache = { entries: new Map(), features: new Map(), hits: 0, misses: 0, evictions: 0, failures: 0, normalizationHits: 0 };
    OCCLUSION_GEOMETRY_CACHE.set(map, cache);
  }
  return cache;
}

function removeGeometryEntry(cache, entry) {
  cache.entries.delete(entry);
  const versions = cache.features.get(entry.featureId);
  versions?.delete(entry.key);
  if (!versions?.size) cache.features.delete(entry.featureId);
  cache.evictions += 1;
}

function featureGeometryVersion(cache, featureId, key) {
  if (!cache) return { results: new Map() };
  let versions = cache.features.get(featureId);
  let entry = versions?.get(key);
  if (entry) {
    cache.hits += 1;
    cache.entries.delete(entry); cache.entries.set(entry, true);
    versions.delete(key); versions.set(key, entry);
    return entry;
  }
  cache.misses += 1;
  while (versions?.size >= MAX_FEATURE_GEOMETRY_VERSIONS) removeGeometryEntry(cache, versions.values().next().value);
  while (cache.entries.size >= MAX_OCCLUSION_GEOMETRY_ENTRIES) removeGeometryEntry(cache, cache.entries.keys().next().value);
  versions = cache.features.get(featureId);
  if (!versions) { versions = new Map(); cache.features.set(featureId, versions); }
  entry = { featureId, key, results: new Map() };
  versions.set(key, entry); cache.entries.set(entry, true);
  return entry;
}

/** Public geometry only: no permissions, sources, Actor data or visible targets. */
export function occlusionGeometryCacheStats(map) {
  const cache = map && OCCLUSION_GEOMETRY_CACHE.get(map);
  return Object.freeze({ entries: cache?.entries.size || 0, features: cache?.features.size || 0,
    maxEntries: MAX_OCCLUSION_GEOMETRY_ENTRIES, maxVersionsPerFeature: MAX_FEATURE_GEOMETRY_VERSIONS,
    largestFeatureVersions: cache ? Math.max(0, ...[...cache.features.values()].map(versions => versions.size)) : 0,
    hits: cache?.hits || 0, misses: cache?.misses || 0, evictions: cache?.evictions || 0, failures: cache?.failures || 0,
    normalizationHits: cache?.normalizationHits || 0 });
}

export function releaseOcclusionGeometryCache(map) { if (map && typeof map === 'object') OCCLUSION_GEOMETRY_CACHE.delete(map); }

function geometryFailure(error, featureId, occluderId, operation = error?.operation || 'difference') {
  const failure = new GeometryClipError(operation, error);
  failure.featureId = featureId;
  failure.occluderId = occluderId;
  failure.message = `遮挡几何计算失败：对象 ${featureId}（${occluderId}），${error.message}`;
  return failure;
}

function cachedGeometry(entry, slot, compute, fallback, { strictGeometry, cache, featureId, occluderId }) {
  let result = entry.results.get(slot);
  if (!result) {
    try { result = { value: compute(), error: null }; }
    catch (error) {
      result = { value: fallback, error: geometryFailure(error, featureId, occluderId) };
      if (cache) cache.failures += 1;
    }
    entry.results.set(slot, result);
  }
  // A conservative legacy result is marked with its error. It can never become
  // an accepted strict result merely because another caller warmed the cache.
  if (strictGeometry && result.error) throw result.error;
  return result.value;
}

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

function spatialPoint(value, fallbackElevationMeters = 0) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const elevationMeters = value?.elevationMeters == null
    ? number(fallbackElevationMeters)
    : Number(value.elevationMeters);
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || !Number.isFinite(elevationMeters) || elevationMeters < 0) return null;
  return { x, y, elevationMeters };
}

export function normalizeSpatialPoint(value, fallbackElevationMeters = 0) {
  const point = spatialPoint(value, fallbackElevationMeters);
  return point ? Object.freeze(point) : null;
}

export function distance3dMeters(from, to, metersPerUnit = 1) {
  const x1 = Number(from?.x), y1 = Number(from?.y), z1 = from?.elevationMeters == null ? 0 : Number(from.elevationMeters);
  const x2 = Number(to?.x), y2 = Number(to?.y), z2 = to?.elevationMeters == null ? 0 : Number(to.elevationMeters);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(z1) || z1 < 0
    || !Number.isFinite(x2) || !Number.isFinite(y2) || !Number.isFinite(z2) || z2 < 0) return Number.POSITIVE_INFINITY;
  const scale = Number(metersPerUnit);
  const units = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.hypot(
    (x2 - x1) * units,
    (y2 - y1) * units,
    z2 - z1,
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
  let data = RING_RAY_DATA.get(polygon);
  if (!data) {
    // All callers use normalized, privately frozen rings. Retain the exact
    // subtraction and multiply/divide order of the original point test.
    data = new Float64Array(polygon.length * 6);
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index++) {
      const first = polygon[index], second = polygon[previous], offset = index * 6;
      data[offset] = first[0]; data[offset + 1] = first[1];
      data[offset + 2] = second[0]; data[offset + 3] = second[1];
      data[offset + 4] = second[0] - first[0]; data[offset + 5] = second[1] - first[1];
    }
    RING_RAY_DATA.set(polygon, data);
  }
  let inside = false;
  for (let index = 0; index < data.length; index += 6) {
    const intersects = (data[index + 1] > point.y) !== (data[index + 3] > point.y)
      && point.x < (data[index + 4] * (point.y - data[index + 1])) / (data[index + 5] || EPSILON) + data[index];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInSolid(point, polygons) {
  for (const rings of polygons) {
    if (!pointInPolygon(point, rings[0])) continue;
    let inHole = false;
    for (let index = 1; index < rings.length; index += 1) {
      if (pointInPolygon(point, rings[index])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

function occluderPolygon(value) {
  const source = value?.polygon ?? value?.blockingPolygon ?? value?.geometry?.points;
  if (!Array.isArray(source) || source.length < 3) return null;
  const polygon = source.map(point => [Number(point?.[0]), Number(point?.[1])]);
  return polygon.every(point => point.every(Number.isFinite)) ? polygon : null;
}

export function normalizeVisionOccluder(value) {
  if (NORMALIZED_VISION_OCCLUDERS.has(value)) return value;
  let polygon = occluderPolygon(value);
  const rawHeight = value?.blockingHeightMeters ?? value?.heightMeters;
  const height = rawHeight == null || rawHeight === 'unbounded' ? Infinity : Number(rawHeight);
  if (!polygon || Number.isNaN(height) || height < 0) return null;
  let polygons;
  try {
    const base = normalizePolygonGeometry(polygon);
    if (!base.length) return null;
    polygon = base[0][0].slice(0, -1);
    polygons = normalizePolygonGeometry(value.polygons ?? [[polygon]]);
  } catch { return null; }
  if (!polygons.length) return null;
  const regions = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length) return null;
    const region = rings.map(ring => occluderPolygon({ polygon: ring.slice(0, -1) }));
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

export function deriveVisionOccluders(mapPackage, scene = null, derivedScene = null, options = {}) {
  const features = new Map((mapPackage?.features || []).map(feature => [String(feature.id), feature]));
  const shapes = resolveEffectiveOcclusionShapes(mapPackage, scene);
  const bindings = new Map(shapes.filter(shape => shape.enabled && shape.featureId).map(shape => [shape.featureId, shape]));
  const destroyed = new Set((derivedScene?.destroyedObjectIds || []).map(String));
  const states = scene?.featureStates && typeof scene.featureStates === 'object' ? scene.featureStates : {};
  const entries = new Map();
  const aliases = new Map();
  const doors = [];
  const legacy = Array.isArray(mapPackage?.visionOccluders) ? mapPackage.visionOccluders : null;
  const legacyIds = legacy && new Set(legacy.flatMap(raw => [raw.id, raw.featureId]
    .filter(value => value != null).map(String)));
  const declaredFeatures = [...features.values()].flatMap(feature => {
    const vision = feature?.capabilities?.vision;
    const binding = bindings.get(String(feature.id));
    if (legacy && (states[feature.id]?.vision?.occluder !== true
      || legacyIds.has(String(vision?.id || feature.id)) || legacyIds.has(String(feature.id)))) return [];
    if (states[feature.id]?.vision?.occluder !== true && !binding && vision?.occluder !== true) return [];
    const navigation = feature?.capabilities?.navigation || {};
    return [{ ...vision, id: vision?.id || feature.id, featureId: feature.id,
      kind: feature.capabilities?.openable ? 'door' : feature.category === 'building' ? 'building' : 'wall',
      polygon: vision?.polygon || navigation.blockingPolygon || feature?.geometry?.points,
      blockingHeightMeters: vision && Object.hasOwn(vision, 'blockingHeightMeters') ? vision.blockingHeightMeters : navigation.blockingHeightMeters,
      passableWhenOpen: vision?.passableWhenOpen ?? navigation.passableWhenOpen,
      passableWhenDestroyed: vision?.passableWhenDestroyed !== false }];
  });
  // Legacy packages may declare only some blockers, or an empty collection.
  // Keep their geometry and ordering, while allowing an explicit Scene tag to
  // add a previously undeclared Feature. Existing legacy IDs and bindings win;
  // their duplicate-entry behavior remains handled by the original Map below.
  const declared = legacy ? [...legacy, ...declaredFeatures] : declaredFeatures;
  const rawEntries = [];
  for (const raw of declared) {
    const feature = features.get(String(raw.featureId || raw.id));
    const binding = bindings.get(String(raw.featureId || raw.id));
    if (binding) continue;
    rawEntries.push({ ...raw, kind: raw.kind || (feature?.capabilities?.openable ? 'door' : feature?.category === 'building' ? 'building' : 'wall') });
  }
  for (const shape of shapes) {
    if (!shape.enabled) continue;
    const feature = features.get(shape.featureId);
    const vision = feature?.capabilities?.vision;
    rawEntries.push({ id: shape.featureId || shape.id, featureId: shape.featureId, shapeId: shape.id,
      kind: shape.kind, polygon: shape.points, hostShapeId: shape.hostShapeId,
      blockingHeightMeters: shape.blockingHeightMeters,
      passableWhenOpen: shape.kind === 'door' || vision?.passableWhenOpen === true,
      passableWhenDestroyed: vision?.passableWhenDestroyed !== false });
  }
  const allAliases = new Map();
  for (const raw of rawEntries) for (const id of [raw.id, raw.featureId, raw.shapeId]) {
    if (id != null) allAliases.set(String(id), String(raw.featureId || raw.id));
  }
  const selected = options.featureIds ? new Set(Array.from(options.featureIds, String)) : null;
  if (selected) {
    // Door apertures and their host are one geometric dependency. Keep unrelated
    // old damage out of a new single-object preflight (especially restoration).
    let changed = true;
    while (changed) {
      changed = false;
      for (const raw of rawEntries) {
        const featureId = String(raw.featureId || raw.id);
        const matched = [raw.id, raw.featureId, raw.shapeId].some(id => selected.has(String(id)));
        const hostId = allAliases.get(String(raw.hostShapeId)) || String(raw.hostShapeId || '');
        if (matched || raw.hostShapeId && (selected.has(featureId) || selected.has(hostId))) {
          for (const id of [featureId, raw.hostShapeId ? hostId : null]) if (id && !selected.has(id)) {
            selected.add(id); changed = true;
          }
        }
      }
    }
  }
  const hits = new Map();
  for (const hit of derivedScene?.clipHits || []) {
    const id = String(hit.featureId);
    if (!hits.has(id)) hits.set(id, []);
    hits.get(id).push(hit.polygon);
  }
  const rawByFeature = new Map();
  const aperturesByHost = new Map();
  for (const raw of rawEntries) {
    const id = String(raw.featureId || raw.id);
    if (!rawByFeature.has(id)) rawByFeature.set(id, []);
    rawByFeature.get(id).push(raw);
    if (raw.hostShapeId) {
      const hostId = allAliases.get(String(raw.hostShapeId)) || String(raw.hostShapeId);
      if (!aperturesByHost.has(hostId)) aperturesByHost.set(hostId, []);
      aperturesByHost.get(hostId).push({ raw, state: states[id] || {}, hits: hits.get(id) || [],
        destroyed: destroyed.has(id), feature: features.get(id)?.capabilities });
    }
  }
  const scale = Number.isFinite(Number(mapPackage?.metersPerUnit)) && Number(mapPackage.metersPerUnit) > 0
    ? Number(mapPackage.metersPerUnit) : 1;
  const cache = mapGeometryCache(mapPackage);
  const versions = new Map();
  const versionFor = featureId => {
    if (!versions.has(featureId)) {
      const feature = features.get(featureId), state = states[featureId] || {};
      const key = JSON.stringify([scale, rawByFeature.get(featureId), feature?.geometry, feature?.capabilities,
        feature?.interaction?.initialState?.open, feature?.interaction?.initialOpen, feature?.initialOpen,
        state.vision, state.custom, state.open, destroyed.has(featureId), hits.get(featureId) || [],
        aperturesByHost.get(featureId) || []]);
      versions.set(featureId, featureGeometryVersion(cache, featureId, key));
    }
    return versions.get(featureId);
  };
  const solidSlots = new Map();
  for (const raw of rawEntries) {
    const featureId = String(raw.featureId || raw.id);
    if (selected && !selected.has(featureId)) continue;
    const index = solidSlots.get(featureId) || 0;
    solidSlots.set(featureId, index + 1);
    const feature = features.get(featureId), state = states[featureId] || {}, vision = state.vision || {};
    const effectiveHeight = vision.blockingHeightMeters ?? state.custom?.blockingHeightMeters ?? raw.blockingHeightMeters;
    // These are constructor-owned raw records. Only previously proved frozen
    // coordinate trees and primitive parameters can reuse pristine geometry;
    // public mutable/extended inputs retain every normalization and coercion.
    const pristineRefs = reusablePristineInput(raw, effectiveHeight);
    let pristine = null;
    if (pristineRefs) for (const previous of cache?.features.get(featureId)?.values() || []) {
      const candidate = previous.normalizations?.get(index);
      if (candidate && pristineRefs.every((value, offset) => Object.is(value, candidate.refs[offset]))) {
        pristine = candidate; cache.normalizationHits++; break;
      }
    }
    const occluder = pristine?.value || normalizeVisionOccluder({ ...raw, blockingHeightMeters: effectiveHeight });
    if (!occluder) {
      if (options.strictGeometry) throw geometryFailure(new Error('Invalid blocker polygon or height'), featureId, String(raw.id));
      continue;
    }
    const open = effectiveFeatureOpen(state, feature);
    if (raw.hostShapeId) doors.push({ ...occluder, hostShapeId: raw.hostShapeId });
    // Turning off a door leaves its aperture in the host, as before.
    if (vision.occluder === false || occluder.passableWhenDestroyed && destroyed.has(featureId)) continue;
    const version = versionFor(featureId);
    if (pristineRefs) {
      version.normalizations ||= new Map();
      version.normalizations.set(index, pristine || { refs: pristineRefs, value: occluder });
    }
    const prepared = cachedGeometry(version, `solid:${index}`, () => {
      let polygons = occluder.polygons;
      if (occluder.passableWhenDestroyed) for (const polygon of hits.get(featureId) || []) {
        polygons = polygonDifference(polygons, polygon, { metersPerUnit: scale });
      }
      if (!polygons.length) return null;
      const value = normalizeVisionOccluder({ ...occluder, polygons });
      if (!value) throw new Error('Clipping produced an invalid blocker polygon');
      return value;
    }, occluder, { ...options, cache, featureId, occluderId: occluder.id });
    if (!prepared) continue;
    if (!(occluder.passableWhenOpen && open)) entries.set(occluder.id, prepared);
    if (raw.shapeId) aliases.set(raw.shapeId, occluder.id);
    if (raw.featureId) aliases.set(raw.featureId, occluder.id);
  }
  // A door always cuts its aperture from the host. A closed door contributes
  // its own blocker, so its height and destruction remain independent.
  const apertureSlots = new Map();
  for (const door of doors) {
    const hostId = aliases.get(door.hostShapeId) || door.hostShapeId;
    const host = entries.get(hostId);
    if (!host || host.kind === 'door') continue;
    const featureId = String(host.featureId || host.id);
    const index = apertureSlots.get(featureId) || 0;
    apertureSlots.set(featureId, index + 1);
    const prepared = cachedGeometry(versionFor(featureId), `aperture:${index}`, () => {
      let polygons = host.polygons;
      for (const aperture of door.polygons) polygons = polygonDifference(polygons, [aperture], { metersPerUnit: scale });
      if (!polygons.length) return null;
      const value = normalizeVisionOccluder({ ...host, polygons });
      if (!value) throw new Error('Door clipping produced an invalid host polygon');
      return value;
    }, host, { ...options, cache, featureId, occluderId: host.id });
    if (prepared) entries.set(hostId, prepared);
    else entries.delete(hostId);
  }
  const collection = [...entries.values()];
  OWNED_VISION_OCCLUDER_COLLECTIONS.add(collection);
  return collection;
}

// A receipt belongs only to the constructor's actual array and normalized
// own-data records. Frozen public lookalikes and Proxy wrappers cannot mint it.
// The public derivation remains mutable until its context owner freezes it.
export function isOwnedVisionOccluderCollection(value) {
  if (!OWNED_VISION_OCCLUDER_COLLECTIONS.has(value)) return false;
  if (VERIFIED_OWNED_VISION_COLLECTIONS.has(value)) return true;
  if (!Object.isFrozen(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
      || !NORMALIZED_VISION_OCCLUDERS.has(descriptor.value)) return false;
  }
  VERIFIED_OWNED_VISION_COLLECTIONS.add(value);
  return true;
}

/** New damage must pass this shared preflight before any authoritative commit. */
export function validateSceneOcclusionGeometry(map, scene = {}, options = {}) {
  deriveVisionOccluders(map, scene, deriveSceneState(scene.sceneEvents || []), { ...options, strictGeometry: true });
  return true;
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
  // Use the same ID order on the host and every browser, independent of locale.
  candidates.sort((a, b) => a.area - b.area || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  return inspectSpatialRay(spatialPoint(from), spatialPoint(to), {
    from, occluders, metersPerUnit, excludedFeatureIds, applySourceHostExemption,
  });
}

function inspectSpatialRay(start, end, { from, occluders, metersPerUnit, excludedFeatureIds = [], applySourceHostExemption }) {
  if (!start || !end) return INVALID_RAY;
  const excluded = excludedFeatureIds.length ? new Set(excludedFeatureIds.map(String)) : null;
  const scale = Number.isFinite(Number(metersPerUnit)) && Number(metersPerUnit) > 0 ? Number(metersPerUnit) : 1;
  const rayBounds = [
    Math.min(start.x, end.x), Math.min(start.y, end.y),
    Math.max(start.x, end.x), Math.max(start.y, end.y),
  ];
  const visualOccluders = applySourceHostExemption ? visionOccludersForSource(from, occluders, metersPerUnit) : occluders;
  for (const raw of queryOccluders(visualOccluders, rayBounds)) {
    const occluder = normalizeVisionOccluder(raw);
    if (!occluder || excluded?.has(String(occluder.featureId || occluder.id))) continue;
    let bounds = OCCLUDER_RAY_BOUNDS.get(occluder);
    if (!bounds) {
      bounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (const point of occluder.polygon) {
        bounds[0] = Math.min(bounds[0], point[0]); bounds[1] = Math.min(bounds[1], point[1]);
        bounds[2] = Math.max(bounds[2], point[0]); bounds[3] = Math.max(bounds[3], point[1]);
      }
      OCCLUDER_RAY_BOUNDS.set(occluder, bounds);
    }
    if (bounds[2] < rayBounds[0] || bounds[0] > rayBounds[2]
      || bounds[3] < rayBounds[1] || bounds[1] > rayBounds[3]) continue;
    // Ring crossings partition the ray into intervals wholly inside or outside
    // the remaining solid. Hole boundaries alone must not block a clear ray.
    // Most rays cross zero, one or two distinct edges. Keep those crossings
    // in scalars; holes/concave fragments with more crossings retain sorting.
    // Equal crossings only form zero-width intervals in the reference path.
    let firstCrossing, secondCrossing, intersections = null;
    for (const rings of occluder.polygons) for (const ring of rings) {
      for (let index = 0; index < ring.length; index += 1) {
        const t = segmentIntersectionT(start, end, ring[index], ring[(index + 1) % ring.length]);
        if (t == null || t <= 0 || t >= 1) continue;
        if (firstCrossing === undefined) firstCrossing = t;
        else if (t !== firstCrossing && secondCrossing === undefined) secondCrossing = t;
        else if (t !== firstCrossing && t !== secondCrossing) {
          intersections ||= [0, firstCrossing, secondCrossing, 1];
          intersections.push(t);
        }
      }
    }
    intersections?.sort((left, right) => left - right);
    const lower = secondCrossing === undefined ? firstCrossing : Math.min(firstCrossing, secondCrossing);
    const upper = secondCrossing === undefined ? firstCrossing : Math.max(firstCrossing, secondCrossing);
    const intervals = intersections ? intersections.length - 1
      : firstCrossing === undefined ? 1 : secondCrossing === undefined ? 2 : 3;
    let blockedAt;
    const slope = end.elevationMeters - start.elevationMeters;
    const point = { x: 0, y: 0 };
    for (let index = 0; index < intervals; index += 1) {
      const first = intersections ? intersections[index] : index === 0 ? 0 : index === 1 ? lower : upper;
      const last = intersections ? intersections[index + 1] : index === intervals - 1 ? 1 : index === 0 ? lower : upper;
      if (last - first <= EPSILON) continue;
      const middle = (first + last) / 2;
      point.x = start.x + (end.x - start.x) * middle;
      point.y = start.y + (end.y - start.y) * middle;
      if (!pointInSolid(point, occluder.polygons)) continue;
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
  return CLEAR_RAY;
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
  sourceOccluders = null,
  metersPerUnit = 1,
  lineOfSightEnabled = false,
  lineOfSightCache = null,
} = {}) {
  const source = spatialPoint(vision, vision?.elevationMeters);
  const destination = spatialPoint(target, target?.elevationMeters);
  if (!source || !destination) return 'none';
  const distance = distance3dMeters(source, destination, metersPerUnit);
  let level = distance <= Math.max(0, number(vision?.preciseRangeMeters ?? vision?.rangeMeters)) ? 'precise'
    : distance <= Math.max(0, number(vision?.vagueRangeMeters)) ? 'vague' : 'none';
  if (level === 'none') return level;
  if (lineOfSightEnabled) {
    // Only the internal Audience caller supplies this bounded, recipient-owned
    // cache, after proving source/geometry/scale and immutable target identity.
    // Illumination and perception ranges are still evaluated on every call.
    let clear = lineOfSightCache?.entries.get(target);
    if (clear === undefined) {
      clear = inspectSpatialRay(source, destination, { from: sourceOccluders ? source : { ...vision, ...source },
        occluders: sourceOccluders || occluders, metersPerUnit,
        applySourceHostExemption: sourceOccluders === null }).clear;
      if (lineOfSightCache && lineOfSightCache.count < 1024) {
        lineOfSightCache.entries.set(target, clear); lineOfSightCache.count += 1;
      }
    }
    if (!clear) return 'none';
  }
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
