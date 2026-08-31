import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';
import { mergeActorDelta } from '../token/actor.js';

export { canUserControlToken, projectStateForAudience } from '../vision/audience.js';

export const serverRuleset = infiniteHorrorRuleset;

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
  const override = token.vision?.rangeOverrideMeters;
  const rangeMeters = override === null || override === undefined
    ? Number(described.rangeMeters) || 0
    : Number(override) || 0;
  const vagueRangeMeters = override === null || override === undefined
    ? Math.max(rangeMeters, Number(described.vagueRangeMeters ?? rangeMeters) || 0)
    : rangeMeters;
  if (vagueRangeMeters <= 0) return null;
  return {
    sceneId: String(scene.id), tokenId: String(token.id), actorId: String(actor.id),
    partyId: actor.partyId == null ? null : String(actor.partyId),
    x: Number(token.x), y: Number(token.y), rangeMeters,
    preciseRangeMeters: rangeMeters, vagueRangeMeters,
    senses: structuredClone(described.senses || {}), lighting: described.lighting || 'normal',
  };
}
