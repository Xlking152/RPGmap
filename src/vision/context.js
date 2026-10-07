import { deriveSceneState } from '../engine/state.js';
import { deriveVisionOccluders, deriveSceneLightSources, releaseOcclusionGeometryCache } from '../spatial/kernel.js';
import { isImmutableVisionData as immutable } from './immutable-data.js';

const contexts = new WeakMap();
const mapGeometrySignatures = new WeakMap();
const explorationContexts = new WeakMap();
let version = 0;
function mapGeometrySignature(map, refs) {
  const reusable = refs.every(reference => immutable(reference));
  const previous = reusable && mapGeometrySignatures.get(map);
  if (previous && refs.every((reference, index) => reference === previous.refs[index])) return previous.key;
  const key = JSON.stringify(refs);
  if (reusable) mapGeometrySignatures.set(map, { refs, key });
  else mapGeometrySignatures.delete(map);
  return key;
}
// Two scene geometries per map; no Actor permissions or audience results live here.
export function sceneVisionContext(map, scene = {}) {
  let entries = contexts.get(map);
  if (!entries) { entries = new Map(); contexts.set(map, entries); }
  const mapRefs = [map.features, map.visionOccluders, map.occlusionShapes, map.metersPerUnit];
  const mapKey = mapGeometrySignature(map, mapRefs);
  const geometryRefs = [scene.id, scene.featureStates, scene.sceneEvents, scene.occlusionShapes];
  const immutableGeometry = geometryRefs.every(reference => immutable(reference));
  let value = immutableGeometry ? [...entries.values()].find(entry => entry.geometryRefs
    && entry.mapKey === mapKey && geometryRefs.every((reference, index) => reference === entry.geometryRefs[index])) : null;
  // Keep the large static signature out of the Scene serialization. Mutable
  // public inputs still get content checks, including deeply mutable map data.
  const key = value ? null : JSON.stringify([scene.id, scene.featureStates || {}, scene.sceneEvents || [], scene.occlusionShapes || []]);
  value ||= entries.get(key);
  if (value?.mapKey !== mapKey) value = null;
  const hit = Boolean(value);
  if (!value) {
    value = { mapKey, geometryVersion: ++version,
      occluders: Object.freeze(deriveVisionOccluders(map, scene, deriveSceneState(scene.sceneEvents || []))) };
    entries.set(key, value);
    if (entries.size > 2) entries.delete(entries.keys().next().value);
  }
  value.geometryRefs = immutableGeometry ? geometryRefs : null;
  const lightRefs = [scene.tokens, map.lights];
  const immutableLighting = lightRefs.every(reference => immutable(reference));
  if (!immutableLighting || !value.lightRefs || !lightRefs.every((reference, index) => reference === value.lightRefs[index])) {
    // Most moves replace a non-luminous Token. Keep only the exact immutable
    // light-bearing documents, in their original order; no per-Token temporary
    // arrays or light normalization are needed when those inputs are unchanged.
    const lightTokens = immutableLighting ? (Array.isArray(scene.tokens) ? scene.tokens : [])
      .filter(token => token?.placement === 'map' && token?.light?.enabled === true) : null;
    const sameLightInputs = lightTokens && value.lightRefs && value.lightRefs[1] === map.lights
      && value.lightTokens?.length === lightTokens.length
      && lightTokens.every((token, index) => token === value.lightTokens[index]);
    if (!sameLightInputs) {
      const lights = deriveSceneLightSources(map, scene);
      const lightKey = JSON.stringify(lights);
      if (lightKey !== value.lightKey) Object.assign(value, { lightKey, lights: Object.freeze(lights), lightVersion: ++version });
    }
    value.lightTokens = lightTokens;
    value.lightRefs = immutableLighting ? lightRefs : null;
  }
  return { geometryVersion: value.geometryVersion, occluders: value.occluders,
    lightKey: value.lightKey, lights: value.lights, lightVersion: value.lightVersion,
    cacheHit: hit, cacheSize: entries.size };
}
// Persisted exploration uses the same public geometry/light snapshot, with
// unbounded height represented as null so JSON round-trips preserve its rule.
// Retain only two derived versions per map; jobs keep their accepted snapshot.
export function sceneExplorationContext(map, scene = {}, spatial = sceneVisionContext(map, scene)) {
  let entries = explorationContexts.get(map);
  if (!entries) { entries = new Map(); explorationContexts.set(map, entries); }
  const ambient = scene.settings?.lighting || 'normal';
  const key = JSON.stringify([spatial.geometryVersion, spatial.lightVersion, ambient,
    map.id, map.version, map.width, map.height, map.metersPerUnit || 1]);
  let context = entries.get(key);
  if (!context) {
    context = Object.freeze({
      map: Object.freeze({ id: map.id, version: map.version, width: map.width, height: map.height,
        metersPerUnit: map.metersPerUnit || 1 }),
      occluders: Object.freeze(spatial.occluders.map(occluder => Object.freeze({ ...occluder,
        blockingHeightMeters: Number.isFinite(occluder.blockingHeightMeters) ? occluder.blockingHeightMeters : null }))),
      lights: spatial.lights, ambient,
    });
    entries.set(key, context);
    if (entries.size > 2) entries.delete(entries.keys().next().value);
  }
  return context;
}

export function releaseVisionContexts(map) {
  contexts.delete(map); mapGeometrySignatures.delete(map); explorationContexts.delete(map); releaseOcclusionGeometryCache(map);
}
