import {
  createSceneToken,
  getActiveSceneToken,
  listActiveSceneTokens,
  moveSceneToken,
  placeSceneTokenInFeature,
  removeSceneToken,
  updateSceneToken,
} from './model.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
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
        async remove(tokenId) {
          return commit(removeSceneToken(api.world.get(), tokenId), {
            source: 'token-v2:remove', reason: 'token.remove', render: true,
          });
        },
      };

      api.emit?.('tokens:ready', {
        schemaVersion: 2,
        count: api.tokens.list().length,
      });
    },
  });
}
