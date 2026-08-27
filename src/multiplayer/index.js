import { createMultiplayerController } from './controller.js';

export { multiplayerSocketUrl, isLocalHost, sanitizeMultiplayerName, normalizeRequestedRole } from './protocol.js';
export { createMultiplayerController } from './controller.js';

export function createMultiplayerSystem(options = {}) {
  const controller = createMultiplayerController(options);
  return {
    register(api) {
      controller.register(api);
      const multiplayer = api.multiplayer;
      if (!multiplayer || typeof multiplayer !== 'object') return;
      multiplayer.canControlToken = tokenId => {
        const token = api.tokens?.get?.(tokenId);
        if (!token) return false;
        const status = multiplayer.getStatus?.();
        if (status?.session?.role === 'gm') return true;
        return multiplayer.canControlActor?.(token.actorId) !== false;
      };
      // Character control was a Token-id alias. Modern systems must use the
      // canonical Token API so this compatibility entrypoint is retired here.
      delete multiplayer.canControlCharacter;
    },
  };
}
