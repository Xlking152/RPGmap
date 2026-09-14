import { createMultiplayerController } from './controller.js';
import { createActorOwnershipUi } from './actor-ownership-ui.js';

export { multiplayerSocketUrl, isLocalHost, sanitizeMultiplayerName, normalizeRequestedRole } from './protocol.js';
export { createMultiplayerController } from './controller.js';
export { createActorOwnershipUi, actorOwnershipRows, buildActorOwnershipChanges, submitActorOwnershipChanges } from './actor-ownership-ui.js';
export { createMultiplayerSessionStorage } from './session.js';
export { createOperationQueue } from './operation-queue.js';
export { hasWorldOperationRevisionGap, shouldApplyOwnServerSnapshot } from './revision.js';
export { createOperationId, parseTransportMessage, sendTransportMessage } from './transport.js';

export function installVisionSourceRequestQueue(multiplayer) {
  if (!multiplayer || typeof multiplayer !== 'object') return multiplayer;
  const originalSetVisionSource = multiplayer.setVisionSource;
  if (typeof originalSetVisionSource !== 'function' || originalSetVisionSource.__rpgmapVisionQueue === true) return multiplayer;

  let activeRequest = null;
  const queuedRequests = [];

  const pump = () => {
    if (activeRequest || !queuedRequests.length) return;
    const request = queuedRequests.shift();
    activeRequest = request;
    Promise.resolve()
      .then(() => originalSetVisionSource.call(multiplayer, request.tokenId))
      .then(
        result => {
          if (activeRequest === request) activeRequest = null;
          request.resolve(result);
          pump();
        },
        error => {
          if (activeRequest === request) activeRequest = null;
          request.reject(error);
          pump();
        },
      );
  };

  const queuedSetVisionSource = (tokenId = null) => {
    const value = tokenId == null ? null : String(tokenId);
    if (activeRequest?.tokenId === value) return activeRequest.promise;
    const duplicate = queuedRequests.find(request => request.tokenId === value);
    if (duplicate) return duplicate.promise;

    // A null request is generated automatically when the currently confirmed
    // source disappears. If the user has already selected another Token and
    // that request is still awaiting ACK, clearing here would race the newer
    // selection and incorrectly erase it after the ACK arrives.
    const latestIntent = queuedRequests.at(-1) || activeRequest;
    if (value === null && latestIntent?.tokenId != null) return latestIntent.promise;

    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    queuedRequests.push({ tokenId: value, promise, resolve, reject });
    pump();
    return promise;
  };

  Object.defineProperty(queuedSetVisionSource, '__rpgmapVisionQueue', { value: true });
  multiplayer.setVisionSource = queuedSetVisionSource;
  return multiplayer;
}

export function createMultiplayerSystem(options = {}) {
  const controller = createMultiplayerController(options);
  const actorOwnershipUi = createActorOwnershipUi(options);
  return {
    register(api) {
      controller.register(api);
      const multiplayer = api.multiplayer;
      if (!multiplayer || typeof multiplayer !== 'object') return;

      installVisionSourceRequestQueue(multiplayer);

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
