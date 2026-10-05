const SHAPE_KINDS = new Set(['building', 'wall', 'door']);
const normalizedShapes = new WeakSet();
const normalizedCollections = new WeakSet();
export const MAX_OCCLUSION_SHAPES = 512;
export const MAX_OCCLUSION_POINTS = 2048;

function fail(message, code = 'invalid_occlusion_shape') {
  const error = new TypeError(message); error.code = code; throw error;
}
function identifier(value, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 160
    || ['__proto__', 'constructor', 'prototype'].includes(value)) fail(`${label} must be a valid ID`);
  return value.trim();
}
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(a, b, p) {
  return Math.abs(cross(a, b, p)) <= 1e-9 && p[0] >= Math.min(a[0], b[0]) - 1e-9
    && p[0] <= Math.max(a[0], b[0]) + 1e-9 && p[1] >= Math.min(a[1], b[1]) - 1e-9
    && p[1] <= Math.max(a[1], b[1]) + 1e-9;
}
function intersects(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Strict shared validation for MapPackage defaults, Scene operations and editor imports. */
export function normalizeOcclusionShape(raw, options = {}) {
  if (normalizedShapes.has(raw) && !options.map) return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Occlusion shape must be an object');
  const id = identifier(raw.id, 'shape.id');
  if (!SHAPE_KINDS.has(raw.kind)) fail(`Unsupported occlusion shape kind: ${raw.kind}`);
  const values = raw.points;
  if (!Array.isArray(values) || values.length < 3 || values.length > MAX_OCCLUSION_POINTS)
    fail(`Shape ${id} requires 3-${MAX_OCCLUSION_POINTS} points`);
  const points = values.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(value => typeof value === 'number' && Number.isFinite(value)))
      fail(`Shape ${id} point ${index} must contain two finite coordinates`);
    return [...point];
  });
  if (points.length > 3 && points[0].every((value, i) => value === points.at(-1)[i])) points.pop();
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (a[0] === b[0] && a[1] === b[1]) fail(`Shape ${id} has a duplicate edge point`);
    area += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (intersects(a, b, points[j], points[(j + 1) % points.length])) fail(`Shape ${id} is self-intersecting`);
    }
  }
  if (Math.abs(area) < 1e-9) fail(`Shape ${id} has zero area`);
  const height = raw.blockingHeightMeters ?? null;
  if (height !== null && (typeof height !== 'number' || !Number.isFinite(height) || height < 0))
    fail(`Shape ${id} has an invalid blocking height`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') fail(`Shape ${id} enabled must be boolean`);
  const featureId = identifier(raw.featureId, 'shape.featureId', true);
  const hostShapeId = identifier(raw.hostShapeId, 'shape.hostShapeId', true);
  if (raw.kind === 'door' && !hostShapeId) fail(`Door ${id} requires a building or wall host`, 'invalid_reference');
  if (hostShapeId && (raw.kind !== 'door' || hostShapeId === id)) fail(`Shape ${id} has an invalid door host`);
  if (options.map && points.some(([x, y]) => x < 0 || y < 0 || x > options.map.width || y > options.map.height))
    fail(`Shape ${id} is outside map bounds`, 'occlusion_shape_out_of_bounds');
  const result = Object.freeze({ id, kind: raw.kind, points: Object.freeze(points.map(Object.freeze)),
    featureId, hostShapeId, blockingHeightMeters: height, enabled: raw.enabled !== false });
  normalizedShapes.add(result);
  return result;
}

export function normalizeOcclusionShapes(raw = [], options = {}) {
  if (raw === null || raw === undefined) raw = [];
  if (!Array.isArray(raw) || raw.length > (options.maxShapes ?? MAX_OCCLUSION_SHAPES))
    fail(`Occlusion shapes must be an array of at most ${options.maxShapes ?? MAX_OCCLUSION_SHAPES} entries`, 'occlusion_shape_limit');
  if (normalizedCollections.has(raw) && !options.map) return raw;
  const shapes = raw.map(value => normalizeOcclusionShape(value, options));
  if (new Set(shapes.map(shape => shape.id)).size !== shapes.length) fail('Occlusion shape IDs must be unique');
  const result = Object.freeze(shapes);
  normalizedCollections.add(result);
  return result;
}

/** Scene records with matching IDs replace map defaults; disabled records remain explicit overrides. */
export function resolveEffectiveOcclusionShapes(map = null, scene = {}) {
  const records = new Map(normalizeOcclusionShapes(map?.occlusionShapes).map(shape => [shape.id, shape]));
  for (const shape of normalizeOcclusionShapes(scene?.occlusionShapes)) records.set(shape.id, shape);
  if (records.size > MAX_OCCLUSION_SHAPES) fail('Combined occlusion shape limit exceeded', 'occlusion_shape_limit');
  const features = new Set((map?.features || []).map(feature => String(feature.id)));
  const bindings = new Set();
  for (const shape of records.values()) {
    // Unknown external MapPackages retain the bounds-only runtime fallback.
    // Scene geometry can still be used, but unavailable map references cannot
    // be checked here. Authoring validation always supplies the loaded map.
    if (map && shape.featureId && !features.has(shape.featureId)) fail(`Shape ${shape.id} references an unknown Feature`, 'invalid_reference');
    if (features.has(shape.id) && shape.featureId !== shape.id) fail(`Shape ${shape.id} collides with a Feature ID`);
    if (shape.enabled && shape.featureId) {
      if (bindings.has(shape.featureId)) fail(`Multiple occlusion shapes bind Feature ${shape.featureId}`);
      bindings.add(shape.featureId);
    }
    if (map && shape.hostShapeId && !records.has(shape.hostShapeId) && !features.has(shape.hostShapeId))
      fail(`Door ${shape.id} references an unknown host`, 'invalid_reference');
    const host = records.get(shape.hostShapeId);
    if (host?.kind === 'door') fail(`Door ${shape.id} cannot use another door as its host`);
  }
  return Object.freeze([...records.values()]);
}
