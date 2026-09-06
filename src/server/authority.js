import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';
import { mergeActorDelta } from '../token/actor.js';
import { deriveSceneState } from '../engine/state.js';
import {
  deriveVisionOccluders,
  isPathPreciselyVisible,
  sphereGroundRadiusMeters,
} from '../spatial/kernel.js';

export { canUserControlToken, projectStateForAudience } from '../vision/audience.js';
export { sphereGroundRadiusMeters } from '../spatial/kernel.js';

export const serverRuleset = infiniteHorrorRuleset;

export function motionPathPreciselyVisible({ motion, vision, mapPackage, scene } = {}) {
  if (String(motion?.tokenId || '') === String(vision?.tokenId || '')) {
    return Number(vision?.preciseRangeMeters ?? vision?.rangeMeters) > 0;
  }
  const points = [motion?.from, ...(motion?.waypoints || []), motion?.to].filter(Boolean);
  const lineOfSightEnabled = vision?.lineOfSightEnabled === true;
  const occluders = lineOfSightEnabled
    ? deriveVisionOccluders(mapPackage, scene, deriveSceneState(scene?.sceneEvents || []))
    : [];
  return isPathPreciselyVisible(points, vision, {
    metersPerUnit: mapPackage?.metersPerUnit || 1,
    lineOfSightEnabled,
    occluders,
  });
}

export function describeVisionForToken(state, tokenId) {
  const world = state?.preferences?.worldV2;
  const scene = world?.scenes?.find(item => String(item?.id ?? '') === String(world?.activeSceneId ?? ''));
  const token = scene?.tokens?.find(item => String(item?.id ?? '') === String(tokenId));
  const actor = token && world?.actors?.find(item => String(item?.id ?? '') === String(token.actorId));
  if (!token || !actor || token.placement !== 'map' || token.vision?.enabled === false) return null;
  const resolved = token.actorLink === false ? mergeActorDelta(actor, token.actorDelta) : actor;
  const described = serverRuleset.vision.describe(resolved, {
    token, scene, lighting: scene?.settings?.lighting || 'normal',
  });
  const legacyOverride = token.vision?.rangeOverrideMeters;
  const preciseOverride = token.vision?.preciseRangeOverrideMeters ?? legacyOverride;
  const vagueOverride = token.vision?.vagueRangeOverrideMeters ?? legacyOverride;
  const rangeMeters = preciseOverride === null || preciseOverride === undefined
    ? Number(described.rangeMeters) || 0
    : Number(preciseOverride) || 0;
  const vagueRangeMeters = vagueOverride === null || vagueOverride === undefined
    ? Math.max(rangeMeters, Number(described.vagueRangeMeters ?? rangeMeters) || 0)
    : Math.max(rangeMeters, Number(vagueOverride) || 0);
  if (vagueRangeMeters <= 0) return null;
  return {
    sceneId: String(scene.id), tokenId: String(token.id), actorId: String(actor.id),
    partyId: actor.partyId == null ? null : String(actor.partyId),
    x: Number(token.x), y: Number(token.y), elevationMeters: Number(token.elevationMeters) || 0, rangeMeters,
    preciseRangeMeters: rangeMeters, vagueRangeMeters,
    preciseGroundRangeMeters: sphereGroundRadiusMeters(rangeMeters, token.elevationMeters) ?? 0,
    vagueGroundRangeMeters: sphereGroundRadiusMeters(vagueRangeMeters, token.elevationMeters) ?? 0,
    senses: structuredClone(described.senses || {}), lighting: described.lighting || 'normal',
  };
}
