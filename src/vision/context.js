import { deriveSceneState } from '../engine/state.js';
import { deriveVisionOccluders, deriveSceneLightSources, releaseOcclusionGeometryCache } from '../spatial/kernel.js';

const contexts = new WeakMap();
const explorationContexts = new WeakMap();
const immutableValues = new WeakSet();
let version = 0;
function immutable(value) {
  if (!value || typeof value !== 'object') return true;
  if (immutableValues.has(value)) return true;
  if (!Object.isFrozen(value) || !Object.values(value).every(immutable)) return false;
  immutableValues.add(value);
  return true;
}
// Two scene geometries per map; no Actor permissions or audience results live here.
export function sceneVisionContext(map, scene = {}) {
  let entries = contexts.get(map);
  if (!entries) { entries = new Map(); contexts.set(map, entries); }
  const geometryRefs = [scene.id, scene.featureStates, scene.sceneEvents, scene.occlusionShapes,
    map.features, map.visionOccluders, map.occlusionShapes, map.metersPerUnit];
  // Loaded MapPackages are static inputs. Their field identities still qualify
  // reuse, while only mutable Scene data requires content checks on every call.
  const immutableGeometry = geometryRefs.slice(0, 4).every(immutable);
  let value = immutableGeometry ? [...entries.values()].find(entry => entry.geometryRefs
    && geometryRefs.every((reference, index) => reference === entry.geometryRefs[index])) : null;
  const key = value ? null : JSON.stringify([scene.id, scene.featureStates || {}, scene.sceneEvents || [], scene.occlusionShapes || [],
    map.features, map.visionOccluders, map.occlusionShapes, map.metersPerUnit]);
  value ||= entries.get(key);
  const hit = Boolean(value);
  if (!value) {
    value = { geometryVersion: ++version,
      occluders: Object.freeze(deriveVisionOccluders(map, scene, deriveSceneState(scene.sceneEvents || []))) };
    entries.set(key, value);
    if (entries.size > 2) entries.delete(entries.keys().next().value);
  }
  value.geometryRefs = immutableGeometry ? geometryRefs : null;
  const lightRefs = [scene.tokens, map.lights];
  const immutableLighting = lightRefs.every(immutable);
  if (!immutableLighting || !value.lightRefs || !lightRefs.every((reference, index) => reference === value.lightRefs[index])) {
    const lights = deriveSceneLightSources(map, scene);
    const lightKey = JSON.stringify(lights);
    if (lightKey !== value.lightKey) Object.assign(value, { lightKey, lights: Object.freeze(lights), lightVersion: ++version });
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
  contexts.delete(map); explorationContexts.delete(map); releaseOcclusionGeometryCache(map);
}
