import {
  createSceneToken,
  getActiveSceneToken,
  listActiveSceneTokens,
  moveSceneToken,
  placeSceneTokenInFeature,
  removeSceneToken,
  updateSceneToken,
} from './model.js';
import { mergeActorDeltaPatch, resolveTokenActor } from './actor.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function createTokenRuntimeSystem() {
  return Object.freeze({
    register(api) {
      if (!api || api.tokens) return;
      if (!api.world?.get || !api.world?.commit) {
        throw new Error('Token Runtime V2 requires World V2 with api.world.get() and api.world.commit()');
      }

      async function commit(result, { source, reason = source, render = true } = {}) {
        await api.world.commit(result.world, { source, reason, render });
        return clone(result.token);
      }

      api.tokens = {
        schemaVersion: 2,
        list() { return listActiveSceneTokens(api.world.get()); },
        get(tokenId) { return getActiveSceneToken(api.world.get(), tokenId); },
        resolveActor(tokenId) { return resolveTokenActor(api.world.get(), tokenId); },
        async create(options = {}) {
          return commit(createSceneToken(api.world.get(), options), {
            source: 'token-v2:create', reason: 'token.create', render: true,
          });
        },
        async move(tokenId, point = {}) {
          return commit(moveSceneToken(api.world.get(), tokenId, point), {
            source: 'token-v2:move', reason: 'token.move', render: true,
          });
        },
        async placeInFeature(tokenId, featureId) {
          return commit(placeSceneTokenInFeature(api.world.get(), tokenId, featureId), {
            source: 'token-v2:place-feature', reason: 'token.place-feature', render: true,
          });
        },
        async update(tokenId, changes = {}, { render = true } = {}) {
          return commit(updateSceneToken(api.world.get(), tokenId, changes), {
            source: 'token-v2:update', reason: 'token.update', render,
          });
        },
        async setActorLink(tokenId, actorLink, { clearDelta = false, render = true } = {}) {
          const current = getActiveSceneToken(api.world.get(), tokenId);
          if (!current) throw new Error(`Unknown Token: ${tokenId}`);
          const linked = actorLink !== false;
          const changes = { actorLink: linked };
          if (clearDelta) changes.actorDelta = null;
          else if (!linked && !current.actorDelta) changes.actorDelta = {};
          return commit(updateSceneToken(api.world.get(), tokenId, changes), {
            source: 'token-v2:actor-link', reason: 'token.actor-link', render,
          });
        },
        async updateActorDelta(tokenId, patch = {}, { replace = false, render = true } = {}) {
          const current = getActiveSceneToken(api.world.get(), tokenId);
          if (!current) throw new Error(`Unknown Token: ${tokenId}`);
          if (current.actorLink !== false) {
            const error = new Error(`Token ${tokenId} is linked to Actor ${current.actorId}; update the World Actor instead`);
            error.code = 'token_actor_linked';
            throw error;
          }
          const actorDelta = replace
            ? clone(object(patch))
            : mergeActorDeltaPatch(current.actorDelta, patch);
          return commit(updateSceneToken(api.world.get(), tokenId, { actorDelta }), {
            source: 'token-v2:actor-delta', reason: 'token.actor-delta', render,
          });
        },
        async remove(tokenId) {
          const removed = await commit(removeSceneToken(api.world.get(), tokenId), {
            source: 'token-v2:remove', reason: 'token.remove', render: true,
          });
          api.emit?.('token:delete', {
            id: removed.id,
            tokenId: removed.id,
            actorId: removed.actorId,
            token: clone(removed),
          });
          return removed;
        },
      };

      api.emit?.('tokens:ready', {
        schemaVersion: 2,
        count: api.tokens.list().length,
      });
    },
  });
}
