import { deriveSceneState } from '../engine/state.js';
import { deriveVisionOccluders, deriveSceneLightSources } from '../spatial/kernel.js';

const contexts = new WeakMap();
let version = 0;
// Two scene geometries per map; no Actor permissions or audience results live here.
export function sceneVisionContext(map, scene = {}) {
  let entries = contexts.get(map);
  if (!entries) { entries = new Map(); contexts.set(map, entries); }
  const key = JSON.stringify([scene.id, scene.featureStates || {}, scene.sceneEvents || []]);
  let value = entries.get(key);
  const hit = Boolean(value);
  if (!value) {
    value = { geometryVersion: ++version,
      occluders: Object.freeze(deriveVisionOccluders(map, scene, deriveSceneState(scene.sceneEvents || []))) };
    entries.set(key, value);
    if (entries.size > 2) entries.delete(entries.keys().next().value);
  }
  const lights = deriveSceneLightSources(map, scene);
  const lightKey = JSON.stringify(lights);
  if (lightKey !== value.lightKey) Object.assign(value, { lightKey, lights: Object.freeze(lights), lightVersion: ++version });
  return { ...value, cacheHit: hit, cacheSize: entries.size };
}
export function releaseVisionContexts(map) { contexts.delete(map); }
