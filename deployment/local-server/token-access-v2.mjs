import { validatePlayerWorldPush as validateLegacyPlayerWorldPush } from './access-control.mjs';
import { resolveStatusCapabilitiesForCharacter } from './status-operations.mjs';

function activeScene(state) {
  const world = state?.preferences?.worldV2;
  if (!world || typeof world !== 'object' || !Array.isArray(world.scenes)) return null;
  return world.scenes.find(scene => String(scene?.id ?? '') === String(world.activeSceneId ?? '')) || null;
}

function placement(token) {
  if (!token) return null;
  return token.placement === 'feature'
    ? { placement: 'feature', featureId: token.featureId == null ? null : String(token.featureId) }
    : { placement: 'map', x: Number(token.x), y: Number(token.y) };
}

function same(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function movedWorldTokenIds(before, next) {
  const beforeScene = activeScene(before);
  const nextScene = activeScene(next);
  if (!beforeScene || !nextScene || String(beforeScene.id) !== String(nextScene.id)) return [];
  const nextTokens = new Map((nextScene.tokens || []).map(token => [String(token?.id ?? ''), token]));
  return (beforeScene.tokens || []).flatMap(token => {
    const id = String(token?.id ?? '');
    if (!id) return [];
    const other = nextTokens.get(id);
    return other && !same(placement(token), placement(other)) ? [id] : [];
  });
}

/**
 * World V2 authorization wrapper.
 *
 * The mature access-control module still handles Actor ownership, combat-turn,
 * chat and GM-only structure rules. This additional gate removes its last
 * security dependency on the legacy Character location mirror: movement is
 * detected directly from active Scene Token placement and status capabilities
 * are resolved by canonical token.id.
 */
export function validatePlayerWorldPush(options = {}) {
  const result = validateLegacyPlayerWorldPush(options);
  if (!result?.ok) return result;

  for (const tokenId of movedWorldTokenIds(options.before, options.next)) {
    // The legacy-named resolver already resolves token.id first-class; keeping
    // that low-level alias isolated here avoids exposing Character terminology
    // to the server entrypoint or modern client runtime.
    const capabilities = resolveStatusCapabilitiesForCharacter(options.before, tokenId);
    if (capabilities.canMove === false) {
      const reason = capabilities.reasons?.length ? `（${capabilities.reasons.join('、')}）` : '';
      return {
        ok: false,
        code: 'status_movement_forbidden',
        message: `该 Token 当前状态禁止移动${reason}`,
        tokenId,
      };
    }
  }
  return result;
}
