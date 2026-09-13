import { deriveSceneState } from '../engine/state.js';
import {
  deriveVisionOccluders,
  distance3dMeters,
  inspectLineOfSight,
} from '../spatial/kernel.js';

function pointForFeature(feature) {
  const point = Array.isArray(feature?.entrance) && feature.entrance.length >= 2
    ? feature.entrance
    : feature?.center;
  return Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
    ? { x: Number(point[0]), y: Number(point[1]), elevationMeters: 0 }
    : null;
}

function failure(code, reason = code) {
  return Object.freeze({ valid: false, code, reason });
}

export function validateDoorInteraction({ scene, token, feature, mapPackage, action, source = {} } = {}) {
  if (!scene || !token || !feature || !mapPackage) return failure('door_target_invalid');
  if (!['open', 'close'].includes(String(action))) return failure('door_action_invalid');
  if (token.placement !== 'map') return failure('door_actor_not_on_map');
  const openable = feature.capabilities?.openable === true
    || feature.capabilities?.actions?.open === true
    || feature.capabilities?.actions?.close === true;
  if (!openable) return failure('door_not_openable');
  const state = scene.featureStates?.[String(feature.id)] || {};
  const derived = deriveSceneState(scene.sceneEvents || []);
  if ((derived.destroyedObjectIds || []).map(String).includes(String(feature.id))) return failure('door_destroyed');
  if (state.locked === true || feature.interaction?.locked === true) return failure('door_locked');
  if (String(source.role || '') !== 'gm') {
    const visibility = feature.visibility || {};
    if (feature.hidden === true || visibility.mode === 'gm') return failure('door_not_visible');
  }
  const currentlyOpen = state.open === true
    || (state.open === undefined && (feature.interaction?.initialOpen === true
      || feature.interaction?.initialState?.open === true));
  if ((action === 'open') === currentlyOpen) return failure('door_state_conflict');
  const target = pointForFeature(feature);
  if (!target) return failure('door_position_missing');
  const rangeMeters = Math.max(0, Number(scene.settings?.defaultDoorInteractionRangeMeters) || 2);
  const metersPerUnit = Math.max(0.000001, Number(mapPackage.metersPerUnit) || 1);
  const actorPoint = {
    x: Number(token.x), y: Number(token.y), elevationMeters: Number(token.elevationMeters) || 0,
  };
  const distanceMeters = distance3dMeters(actorPoint, target, metersPerUnit);
  if (!Number.isFinite(distanceMeters) || distanceMeters > rangeMeters + 1e-9) {
    return failure('door_out_of_range', `Door is ${distanceMeters.toFixed(2)} m away`);
  }
  if (scene.settings?.lineOfSightEnabled === true) {
    const occluders = deriveVisionOccluders(mapPackage, scene, derived);
    const sight = inspectLineOfSight({
      from: actorPoint, to: target, occluders, metersPerUnit,
      excludedFeatureIds: [String(feature.id)],
    });
    if (!sight.clear) return failure('door_line_of_sight_blocked');
  }
  return Object.freeze({ valid: true, code: 'ok', distanceMeters, rangeMeters, target });
}
