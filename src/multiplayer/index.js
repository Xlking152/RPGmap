import { createMultiplayerController } from './controller.js';
import { createActorOwnershipUi } from './actor-ownership-ui.js';

export { multiplayerSocketUrl, isLocalHost, sanitizeMultiplayerName, normalizeRequestedRole } from './protocol.js';
export { createMultiplayerController } from './controller.js';
export { createActorOwnershipUi, actorOwnershipRows, buildActorOwnershipChanges, submitActorOwnershipChanges } from './actor-ownership-ui.js';
export { createMultiplayerSessionStorage } from './session.js';
export { createOperationQueue } from './operation-queue.js';
export { hasWorldOperationRevisionGap, shouldApplyOwnServerSnapshot } from './revision.js';
export { createOperationId, parseTransportMessage, sendTransportMessage } from './transport.js';

export function createMultiplayerSystem(options = {}) {
  const controller = createMultiplayerController(options);
  const actorOwnershipUi = createActorOwnershipUi(options);
  return {
    register(api) {
      controller.register(api);
      const multiplayer = api.multiplayer;
      if (!multiplayer || typeof multiplayer !== 'object') return;

      // The controller owns the canonical Token-first permission rule.  Do not
      // overwrite it with Actor ownership: NPC/monster/summon instances may be
      // controlled through token.controllerUserIds while remaining unlinked
      // from their template Actor.
      if (typeof multiplayer.canControlToken !== 'function') {
        multiplayer.canControlToken = tokenId => {
          const token = api.tokens?.get?.(tokenId);
          if (!token) return false;
          const status = multiplayer.getStatus?.();
          if (!status?.connected || status?.session?.role === 'gm') return true;
          const userId = String(status?.session?.userId || '');
          if ((token.controllerUserIds || []).map(String).includes(userId)) return true;
          return multiplayer.canControlActor?.(token.actorId) === true;
        };
      }

      actorOwnershipUi.register(api);
    },
  };
}
