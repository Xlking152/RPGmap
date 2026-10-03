import { deriveSceneState } from '../engine/state.js';
import { deriveVisionOccluders, deriveSceneLightSources } from '../spatial/kernel.js';

const contexts = new WeakMap();
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
  const geometryRefs = [scene.id, scene.featureStates, scene.sceneEvents, scene.occlusionShapes];
  const immutableGeometry = geometryRefs.every(immutable);
  let value = immutableGeometry ? [...entries.values()].find(entry => entry.geometryRefs
    && geometryRefs.every((reference, index) => reference === entry.geometryRefs[index])) : null;
  const key = value ? null : JSON.stringify([scene.id, scene.featureStates || {}, scene.sceneEvents || [], scene.occlusionShapes || []]);
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
export function releaseVisionContexts(map) { contexts.delete(map); }
