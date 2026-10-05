import { normalizeOcclusionShapes, resolveEffectiveOcclusionShapes } from '../vision/occlusion-model.js';
import { assertFeatureVision, isPlainObject } from './feature-states.js';
import { deriveVisionOccluders } from '../spatial/kernel.js';

const clone = structuredClone;
const fail = (message, code = 'invalid_occlusion_configuration') => {
  throw Object.assign(new Error(message), { code });
};

export function occlusionMapReference(map = {}, scene = {}) {
  const manifest = map.manifest || {};
  return {
    id: String(scene.mapPackage?.id ?? map.mapId ?? map.id ?? manifest.mapId ?? manifest.id ?? 'default-map'),
    version: String(scene.mapPackage?.version ?? map.mapVersion ?? map.version ?? manifest.mapVersion ?? manifest.version ?? '1'),
    metersPerUnit: Number(map.metersPerUnit) || 1,
    width: Number(map.width) || 0,
    height: Number(map.height) || 0,
  };
}

// Resolve the host's authored geometry without doors cutting apertures or
// temporary open/destroyed runtime state hiding an otherwise valid host.
export function availableOcclusionHostIds(map = {}, scene = {}, configuration = null) {
  const authoredShapes = configuration?.occlusionShapes ?? scene.occlusionShapes ?? [];
  const records = { ...(scene.featureStates || {}) };
  if (configuration?.featureVision) {
    for (const [id, value] of Object.entries(records)) {
      if (Object.hasOwn(value || {}, 'vision')) {
        records[id] = { ...value };
        delete records[id].vision;
      }
    }
    for (const [id, vision] of Object.entries(configuration.featureVision))
      records[id] = { ...records[id], vision };
  }
  for (const [id, value] of Object.entries(records)) {
    // A temporary transparent tag or opened host does not erase the authored
    // building/wall capability; it may block again when the tag is restored.
    const vision = value?.vision?.occluder === false ? { ...value.vision } : null;
    if (vision) delete vision.occluder;
    if (vision || value?.open === true) records[id] = {
      ...value, ...(vision ? { vision } : {}), ...(value?.open === true ? { open: false } : {}),
    };
  }
  const withoutDoors = values => (values || []).filter(shape => shape.kind !== 'door');
  const blockers = deriveVisionOccluders({ ...map, occlusionShapes: withoutDoors(map.occlusionShapes) }, {
    ...scene, occlusionShapes: withoutDoors(authoredShapes), featureStates: records,
  });
  const available = new Set(blockers.filter(item => item.kind === 'building' || item.kind === 'wall')
    .flatMap(item => [item.id, item.shapeId, item.featureId].filter(Boolean).map(String)));
  // A door binding replaces its Feature's default blocker, even though door
  // geometry was omitted above to inspect the uncut hosts.
  for (const shape of resolveEffectiveOcclusionShapes(map, { occlusionShapes: authoredShapes }))
    if (shape.enabled && shape.kind === 'door' && shape.featureId) available.delete(String(shape.featureId));
  return available;
}

export function assertOcclusionReferences(shapes, map = {}, scene = {}, featureVision = null) {
  const effective = Array.isArray(map.features) ? resolveEffectiveOcclusionShapes(map, { occlusionShapes: shapes }) : shapes;
  const features = new Set((map.features || []).map(feature => String(feature.id)));
  for (const shape of shapes) {
    if (shape.featureId && Array.isArray(map.features) && !features.has(shape.featureId)) {
      fail(`Occlusion shape binds a missing Feature: ${shape.featureId}`, 'invalid_reference');
    }
  }
  const doors = effective.filter(shape => shape.hostShapeId && shape.enabled !== false);
  // Movement and Fog commits validate their Scene too. Maps without authored
  // door hosts do not need to reconstruct every building to validate an empty
  // collection; structural references above still run for every configuration.
  if (!doors.length) return shapes;
  const availableHosts = availableOcclusionHostIds(map, { ...scene, occlusionShapes: shapes },
    featureVision === null ? null : { occlusionShapes: shapes, featureVision });
  for (const shape of doors) {
    if (!availableHosts.has(shape.hostShapeId)) {
      fail(`Occlusion door requires an enabled building or wall blocker: ${shape.hostShapeId}`, 'invalid_reference');
    }
  }
  return shapes;
}

export function exportOcclusionConfiguration(map, scene = {}) {
  const featureVision = {};
  for (const [featureId, state] of Object.entries(scene.featureStates || {})) {
    if (state?.vision && Object.keys(state.vision).length) featureVision[featureId] = clone(state.vision);
  }
  return {
    schemaVersion: 1,
    map: occlusionMapReference(map, scene),
    occlusionShapes: clone([...resolveEffectiveOcclusionShapes(map, scene)]),
    featureVision,
  };
}

export function normalizeOcclusionConfiguration(raw, map, scene = {}) {
  if (!isPlainObject(raw) || Number(raw.schemaVersion) !== 1) fail('Unsupported occlusion configuration schema');
  if (Object.keys(raw).some(key => !['schemaVersion', 'map', 'occlusionShapes', 'featureVision'].includes(key))) {
    fail('Occlusion configuration may contain only map metadata, shapes and Feature vision tags');
  }
  const expected = occlusionMapReference(map, scene);
  if (!isPlainObject(raw.map) || Object.keys(expected).some(key => key === 'id' || key === 'version'
    ? String(raw.map[key]) !== expected[key] : Number(raw.map[key]) !== expected[key])) {
    fail('Occlusion configuration map id, version, dimensions or scale do not match', 'occlusion_map_mismatch');
  }
  const shapes = [...normalizeOcclusionShapes(raw.occlusionShapes, { map })];
  if (!isPlainObject(raw.featureVision || {})) fail('Feature vision configuration must be an object');
  const known = new Set([...(map.features || []).map(feature => String(feature.id)),
    ...shapes.map(shape => shape.featureId || shape.id), ...(map.occlusionShapes || []).map(shape => shape.featureId || shape.id)]);
  const featureVision = {};
  for (const [featureId, value] of Object.entries(raw.featureVision || {})) {
    if (!featureId || featureId.length > 160 || ['__proto__', 'prototype', 'constructor'].includes(featureId)) fail('Invalid Feature vision identifier');
    if (Array.isArray(map.features) && !known.has(featureId)) fail(`Missing Feature vision target: ${featureId}`, 'invalid_reference');
    assertFeatureVision(value);
    const canonical = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
    if (Object.keys(canonical).length) featureVision[featureId] = clone(canonical);
  }
  assertOcclusionReferences(shapes, map, scene, featureVision);
  return { schemaVersion: 1, map: expected, occlusionShapes: shapes, featureVision };
}

// A drawn door participates in the same authoritative distance/lock checks as
// a map Feature, without declaring navigation or collision capabilities.
export function featureForOcclusionDoor(map, scene, featureId) {
  const shapes = new Map((map?.occlusionShapes || []).map(shape => [String(shape.id), shape]));
  for (const shape of scene?.occlusionShapes || []) shapes.set(String(shape.id), shape);
  const shape = [...shapes.values()].find(item => item.kind === 'door' && item.enabled !== false
    && String(item.featureId || item.id) === String(featureId));
  if (!shape) return null;
  const points = shape.points;
  const center = points.reduce((sum, point) => [sum[0] + Number(point[0]) / points.length,
    sum[1] + Number(point[1]) / points.length], [0, 0]);
  const original = map?.features?.find(feature => String(feature.id) === String(featureId));
  return { ...original, id: String(featureId), name: original?.name || '手绘门',
    geometry: { type: 'polygon', points }, center,
    capabilities: { openable: true, actions: { open: true, close: true } },
    occlusionHostId: shape.hostShapeId || null };
}
