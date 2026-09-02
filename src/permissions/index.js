import { canPermission } from './model.js';

export * from './model.js';

function activeCombatTokenId(api) {
  const combat = api.getState?.()?.preferences?.combatSystem?.combat;
  if (combat?.state !== 'active' || !Array.isArray(combat.combatants) || !combat.combatants.length) return null;
  const index = Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0));
  return combat.combatants[index]?.tokenId == null ? null : String(combat.combatants[index].tokenId);
}

export function createPermissionSystem() {
  return Object.freeze({
    register(api) {
      api.permissions = Object.freeze({
        actorLevel(actorId) {
          const status = api.multiplayer?.getStatus?.() || {};
          if (status.connected !== true || status.session?.role === 'gm') return 'gm';
          return api.multiplayer?.getActorAccessLevel?.(actorId) || 'none';
        },
        can(action, context = {}) {
          const status = api.multiplayer?.getStatus?.() || {};
          const connected = status.connected === true;
          const role = connected ? status.session?.role || 'player' : 'gm';
          const token = context.token || (context.tokenId ? api.tokens?.get?.(context.tokenId) : null);
          const actorId = context.actor?.id || context.actorId || token?.actorId || null;
          const actor = context.actor || (actorId
            ? api.actors?.get?.(actorId)
              || api.world?.get?.()?.actors?.find(item => String(item?.id) === String(actorId))
            : null);
          const actorAccess = role === 'gm'
            ? 'owner'
            : api.multiplayer?.getActorAccessLevel?.(actorId) || 'none';
          return canPermission(action, {
            ...context,
            token,
            actor,
            actorAccess,
            role,
            userId: status.session?.userId || '',
            activeCombatTokenId: activeCombatTokenId(api),
            statusCapabilities: token ? api.status?.resolveCapabilities?.({ tokenId: token.id }) : null,
          });
        },
      });
    },
  });
}
