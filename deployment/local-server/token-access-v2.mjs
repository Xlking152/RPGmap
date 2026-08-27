import {
  OWNERSHIP,
  currentCombatActorId,
  ownershipLevel,
  validatePlayerWorldPush as validateLegacyPlayerWorldPush,
} from './access-control-legacy.mjs';
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

function tokenMap(scene) {
  return new Map((Array.isArray(scene?.tokens) ? scene.tokens : [])
    .filter(token => token?.id != null)
    .map(token => [String(token.id), token]));
}

function canonicalTokenStructureMatches(before, next) {
  const beforeScene = activeScene(before);
  const nextScene = activeScene(next);
  if (!beforeScene || !nextScene || String(beforeScene.id) !== String(nextScene.id)) return true;
  const beforeTokens = tokenMap(beforeScene);
  const nextTokens = tokenMap(nextScene);
  if (beforeTokens.size !== nextTokens.size) return false;
  for (const [tokenId, token] of beforeTokens) {
    const other = nextTokens.get(tokenId);
    if (!other) return false;
    if (String(token.actorId ?? '') !== String(other.actorId ?? '')) return false;
    if ((token.actorLink !== false) !== (other.actorLink !== false)) return false;
  }
  return true;
}

export function movedWorldTokenIds(before, next) {
  const beforeScene = activeScene(before);
  const nextScene = activeScene(next);
  if (!beforeScene || !nextScene || String(beforeScene.id) !== String(nextScene.id)) return [];
  const nextTokens = tokenMap(nextScene);
  return (beforeScene.tokens || []).flatMap(token => {
    const id = String(token?.id ?? '');
    if (!id) return [];
    const other = nextTokens.get(id);
    return other && !same(placement(token), placement(other)) ? [id] : [];
  });
}

function legacyValidationView(before, next, movedTokenIds) {
  if (!movedTokenIds.length) return next;
  const copy = structuredClone(next);
  const beforeTokens = tokenMap(activeScene(before));
  const scene = activeScene(copy);
  if (!scene) return copy;
  const moved = new Set(movedTokenIds.map(String));
  scene.tokens = (scene.tokens || []).map(token => {
    if (!moved.has(String(token?.id ?? ''))) return token;
    const original = beforeTokens.get(String(token.id));
    if (!original) return token;
    return {
      ...token,
      placement: original.placement,
      x: original.x ?? null,
      y: original.y ?? null,
      featureId: original.featureId ?? null,
    };
  });
  return copy;
}

/**
 * World V2 authorization wrapper.
 *
 * The V1 validator remains responsible for Actor data, chat, combat and the
 * GM-only World/Scene structure. Canonical Scene Token placement is removed
 * from that compatibility comparison and authorized here directly by token.id
 * -> actorId ownership, combat turn and authoritative movement capabilities.
 */
export function validatePlayerWorldPush(options = {}) {
  const movedTokenIds = movedWorldTokenIds(options.before, options.next);

  if (!canonicalTokenStructureMatches(options.before, options.next)) {
    return {
      ok: false,
      code: 'world_scope_forbidden',
      message: 'Player 不能新增、删除或重新绑定 Scene Token',
    };
  }

  const legacyNext = legacyValidationView(options.before, options.next, movedTokenIds);
  const result = validateLegacyPlayerWorldPush({ ...options, next: legacyNext });
  if (!result?.ok) return result;

  const beforeTokens = tokenMap(activeScene(options.before));
  const activeCombatActorId = currentCombatActorId(options.before);
  for (const tokenId of movedTokenIds) {
    const token = beforeTokens.get(String(tokenId));
    const actorId = token?.actorId == null ? null : String(token.actorId);
    if (!actorId || ownershipLevel(options.user, actorId) !== OWNERSHIP.OWNER) {
      return {
        ok: false,
        code: 'actor_not_owned',
        message: '你没有该 Token 所属 Actor 的 OWNER 权限',
        tokenId,
        actorId,
      };
    }
    if (activeCombatActorId && String(activeCombatActorId) !== actorId) {
      return {
        ok: false,
        code: 'combat_turn_locked',
        message: '战斗中只能移动当前回合 Actor 的 Token',
        tokenId,
        actorId,
      };
    }

    // The low-level status resolver accepts canonical token.id. Its historical
    // function name remains contained in this server-only migration boundary.
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
