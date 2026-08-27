import { resolveStatuses } from '../status/model.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function contextValue(context, tokenId) {
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    return tokenId == null ? { ...context } : { ...context, tokenId };
  }
  return context == null ? (tokenId == null ? {} : { tokenId }) : {
    actorId: context,
    ...(tokenId == null ? {} : { tokenId }),
  };
}

function tokenIdentity(context) {
  return context?.tokenId ?? context?.characterId ?? context?.token?.id ?? context?.token?.characterId ?? null;
}

function syntheticStatusState(api, context) {
  const tokenId = tokenIdentity(context);
  if (tokenId == null || typeof api.tokens?.resolveActor !== 'function') return null;

  let resolved;
  try { resolved = api.tokens.resolveActor(tokenId); }
  catch { return null; }
  if (!resolved?.synthetic || !resolved.actor) return null;

  const raw = api.getState?.()?.preferences?.entitySystem;
  if (!raw || typeof raw !== 'object') return null;
  const state = clone(raw);
  const index = (state.actors || []).findIndex(actor => String(actor?.id) === String(resolved.actor.id));
  if (index < 0) return null;

  // Only the resolution view is replaced. The persisted World Actor remains
  // the Base Actor; mutations still go through the normal Status operation
  // protocol until a dedicated Synthetic-Actor status write operation lands.
  state.actors[index] = clone(resolved.actor);
  return state;
}

export function createTokenStatusBridgeSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.status || api.status.syntheticActorAware === true) return;
      const baseResolve = api.status.resolve?.bind(api.status);
      if (typeof baseResolve !== 'function') return;

      function resolve(context = {}, tokenId = null) {
        const target = contextValue(context, tokenId);
        const synthetic = syntheticStatusState(api, target);
        return synthetic ? resolveStatuses(synthetic, target) : baseResolve(context, tokenId);
      }

      api.status.resolve = resolve;
      api.status.resolveStatuses = resolve;
      api.status.resolveToken = tokenId => resolve({ tokenId });
      api.status.resolveCapabilities = (context = {}, tokenId = null) => resolve(context, tokenId).capabilities;
      api.status.has = (context = {}, definitionId = null) => {
        const target = contextValue(context);
        const id = String(definitionId ?? target.definitionId ?? target.statusId ?? '');
        if (!id) return false;
        return resolve(target).statuses.some(status => status.enabled !== false
          && String(status.definitionId || status.statusId || status.id) === id);
      };
      api.status.syntheticActorAware = true;

      api.emit?.('status:synthetic-ready', { enabled: true });
    },
  });
}
