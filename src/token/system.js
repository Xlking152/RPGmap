import {
  createSceneToken,
  getActiveSceneToken,
  listActiveSceneTokens,
  moveSceneToken,
  placeSceneTokenInFeature,
  removeSceneToken,
  updateSceneToken,
} from './model.js';
import { createInitialActorDelta, mergeActorDeltaPatch, resolveTokenActor } from './actor.js';
import { actorUsesIndependentInstances } from '../actor/classification.js';

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

      async function perform(operation, { source, render = true, kind = 'token' } = {}) {
        if (typeof api.world.performOperations !== 'function') return null;
        await api.world.performOperations([operation], { source, render, kind });
        return true;
      }

      api.tokens = {
        schemaVersion: 2,
        list() { return listActiveSceneTokens(api.world.get()); },
        get(tokenId) { return getActiveSceneToken(api.world.get(), tokenId); },
        resolveActor(tokenId) { return resolveTokenActor(api.world.get(), tokenId, { ruleset: api.ruleset }); },
        async create(options = {}) {
          const world = api.world.get();
          const actor = world.actors?.find(item => String(item?.id) === String(options.actorId));
          if (!actor) throw new Error(`Unknown Actor: ${options.actorId || '(missing)'}`);
          const prototype = object(actor.prototypeToken);
          const input = {
            ...options,
            diameterMeters: options.diameterMeters ?? prototype.diameterMeters ?? 1,
            showName: options.showName ?? prototype.showName ?? true,
          };
          const prepared = createSceneToken(world, input, { ruleset: api.ruleset });
          if (typeof api.world.performOperations !== 'function') {
            return commit(prepared, { source: 'token-v2:create', reason: 'token.create', render: true });
          }
          await api.world.performOperations([{
            type: 'token.create',
            payload: { sceneId: world.activeSceneId, token: prepared.token },
          }], { source: 'token-v2:create', render: true, kind: 'token' });
          return api.tokens.get(prepared.token.id);
        },
        async move(tokenId, point = {}) {
          const world = api.world.get();
          const prepared = moveSceneToken(world, tokenId, point, { ruleset: api.ruleset });
          if (!await perform({
            type: 'token.move',
            payload: {
              sceneId: world.activeSceneId, tokenId: String(tokenId), placement: 'map',
              x: prepared.token.x, y: prepared.token.y, featureId: null,
            },
          }, { source: 'token-v2:move' })) {
            return commit(prepared, { source: 'token-v2:move', reason: 'token.move', render: true });
          }
          return api.tokens.get(tokenId);
        },
        async placeInFeature(tokenId, featureId) {
          const world = api.world.get();
          const prepared = placeSceneTokenInFeature(world, tokenId, featureId, { ruleset: api.ruleset });
          if (!await perform({
            type: 'token.move',
            payload: {
              sceneId: world.activeSceneId, tokenId: String(tokenId), placement: 'feature',
              x: null, y: null, featureId: prepared.token.featureId,
            },
          }, { source: 'token-v2:place-feature' })) {
            return commit(prepared, { source: 'token-v2:place-feature', reason: 'token.place-feature', render: true });
          }
          return api.tokens.get(tokenId);
        },
        async update(tokenId, changes = {}, { render = true } = {}) {
          const world = api.world.get();
          const prepared = updateSceneToken(world, tokenId, changes, { ruleset: api.ruleset });
          if (!await perform({
            type: 'token.upsert',
            payload: { sceneId: world.activeSceneId, token: prepared.token },
          }, { source: 'token-v2:update', render })) {
            return commit(prepared, { source: 'token-v2:update', reason: 'token.update', render });
          }
          return api.tokens.get(tokenId);
        },
        async setActorLink(tokenId, actorLink, { clearDelta = false, render = true } = {}) {
          const current = getActiveSceneToken(api.world.get(), tokenId);
          if (!current) throw new Error(`Unknown Token: ${tokenId}`);
          const actor = api.world.get().actors?.find(item => String(item?.id) === String(current.actorId));
          if (actorUsesIndependentInstances(actor) && actorLink !== false) {
            const error = new Error(`${actor.type} Token instances cannot link runtime state to their Actor template`);
            error.code = 'instance_link_forbidden';
            throw error;
          }
          const linked = actorLink !== false;
          const changes = { actorLink: linked };
          if (clearDelta) changes.actorDelta = null;
          else if (!linked && !current.actorDelta) {
            changes.actorDelta = createInitialActorDelta(actor, { ruleset: api.ruleset });
          }
          return commit(updateSceneToken(api.world.get(), tokenId, changes, { ruleset: api.ruleset }), {
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
          const world = api.world.get();
          if (!await perform({
            type: 'token.actorDelta.replace',
            payload: { sceneId: world.activeSceneId, tokenId: String(tokenId), actorDelta },
          }, { source: 'token-v2:actor-delta', render })) {
            return commit(updateSceneToken(world, tokenId, { actorDelta }, { ruleset: api.ruleset }), {
              source: 'token-v2:actor-delta', reason: 'token.actor-delta', render,
            });
          }
          return api.tokens.get(tokenId);
        },
        async remove(tokenId) {
          const world = api.world.get();
          const prepared = removeSceneToken(world, tokenId);
          let removed;
          if (!await perform({
            type: 'token.delete',
            payload: { sceneId: world.activeSceneId, tokenId: String(tokenId) },
          }, { source: 'token-v2:remove' })) {
            removed = await commit(prepared, { source: 'token-v2:remove', reason: 'token.remove', render: true });
          } else removed = prepared.token;
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
