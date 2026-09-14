import { deriveSceneState } from '../engine/state.js';
import {
  deriveVisionOccluders,
  inspectLineOfSight,
} from '../spatial/kernel.js';

function polygonForFeature(feature) {
  const polygon = feature?.capabilities?.navigation?.blockingPolygon
    || feature?.geometry?.points;
  return Array.isArray(polygon) && polygon.length >= 3 ? polygon : [];
}

function closestPointOnSegment(point, first, second) {
  const dx = Number(second[0]) - Number(first[0]);
  const dy = Number(second[1]) - Number(first[1]);
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return { x: Number(first[0]), y: Number(first[1]) };
  const t = Math.max(0, Math.min(1, ((point.x - Number(first[0])) * dx + (point.y - Number(first[1])) * dy) / lengthSquared));
  return { x: Number(first[0]) + t * dx, y: Number(first[1]) + t * dy };
}

function nearestPointOnPolygon(point, polygon) {
  if (polygon.length < 3) return null;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[previous];
    if ((Number(y1) > point.y) !== (Number(y2) > point.y)
      && point.x < ((Number(x2) - Number(x1)) * (point.y - Number(y1)) / ((Number(y2) - Number(y1)) || 1e-12)) + Number(x1)) inside = !inside;
  }
  let nearest = null;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const candidate = closestPointOnSegment(point, polygon[index], polygon[(index + 1) % polygon.length]);
    const candidateDistance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
    if (candidateDistance < distance) {
      distance = candidateDistance;
      nearest = candidate;
    }
  }
  if (!nearest) return null;
  return { point: nearest, distance: inside ? 0 : distance };
}

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
  if (!scene || !feature || !mapPackage) return failure('door_target_invalid');
  if (!['open', 'close'].includes(String(action))) return failure('door_action_invalid');
  const isGm = ['gm', 'offline'].includes(String(source.role || '').toLowerCase());
  if (!isGm && !token) return failure('door_actor_required');
  if (!isGm && token.placement !== 'map') return failure('door_actor_not_on_map');
  const openable = feature.capabilities?.openable === true
    || feature.capabilities?.actions?.open === true
    || feature.capabilities?.actions?.close === true;
  if (!openable) return failure('door_not_openable');
  const state = scene.featureStates?.[String(feature.id)] || {};
  const derived = deriveSceneState(scene.sceneEvents || []);
  if ((derived.destroyedObjectIds || []).map(String).includes(String(feature.id))) return failure('door_destroyed');
  if (!isGm && (state.locked === true || feature.interaction?.locked === true)) return failure('door_locked');
  if (!isGm) {
    const visibility = feature.visibility || {};
    if (feature.hidden === true || visibility.mode === 'gm') return failure('door_not_visible');
  }
  const currentlyOpen = state.open === true
    || (state.open === undefined && (feature.interaction?.initialOpen === true
      || feature.interaction?.initialState?.open === true));
  if ((action === 'open') === currentlyOpen) return failure('door_state_conflict');
  const fallbackTarget = pointForFeature(feature);
  const polygon = polygonForFeature(feature);
  const actorPoint = !isGm
    ? { x: Number(token.x), y: Number(token.y), elevationMeters: Number(token.elevationMeters) || 0 }
    : null;
  const nearest = actorPoint ? nearestPointOnPolygon(actorPoint, polygon) : null;
  const target = nearest?.point
    ? { ...nearest.point, elevationMeters: fallbackTarget?.elevationMeters || 0 }
    : fallbackTarget;
  if (!target && !isGm) return failure('door_position_missing');
  if (isGm) return Object.freeze({ valid: true, code: 'ok', distanceMeters: 0, rangeMeters: 0, target });
  const rangeMeters = Math.max(0, Number(scene.settings?.defaultDoorInteractionRangeMeters) || 2);
  const metersPerUnit = Math.max(0.000001, Number(mapPackage.metersPerUnit) || 1);
  const nearestDistanceUnits = nearest?.distance ?? (fallbackTarget
    ? Math.hypot(actorPoint.x - fallbackTarget.x, actorPoint.y - fallbackTarget.y)
    : Number.POSITIVE_INFINITY);
  const diameterMeters = Math.max(0, Number(token.diameterMeters) || 0);
  const distanceMeters = Math.max(0, nearestDistanceUnits - diameterMeters / (2 * metersPerUnit)) * metersPerUnit;
  if (!Number.isFinite(distanceMeters) || distanceMeters > rangeMeters + 1e-9) {
    return failure('door_out_of_range', `Door is ${distanceMeters.toFixed(2)} m away`);
  }
  if (!isGm) {
    const occluders = deriveVisionOccluders(mapPackage, scene, derived);
    const sight = inspectLineOfSight({
      from: actorPoint, to: target, occluders, metersPerUnit,
      excludedFeatureIds: [String(feature.id)],
    });
    if (!sight.clear) return failure('door_line_of_sight_blocked');
  }
  return Object.freeze({ valid: true, code: 'ok', distanceMeters, rangeMeters, target });
}
