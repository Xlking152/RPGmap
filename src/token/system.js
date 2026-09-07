import {
  createSceneToken,
  getActiveSceneToken,
  moveSceneToken,
  placeSceneTokenInFeature,
  removeSceneToken,
  updateSceneToken,
} from './model.js';
import { createInitialActorDelta, mergeActorDeltaPatch, resolveTokenActorDocuments } from './actor.js';
import { actorUsesIndependentInstances } from '../actor/classification.js';

const clone = value => structuredClone(value);

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

      let readWorld = null;
      let readTokens = [];
      let tokensById = new Map();
      let actorsById = new Map();
      const eventBackedReads = typeof api.on === 'function';

      function refreshReadModel(state = null) {
        readWorld = state?.preferences?.worldV2 || api.world.get();
        const scenes = Array.isArray(readWorld?.scenes) ? readWorld.scenes : [];
        const scene = scenes.find(item => String(item?.id ?? '') === String(readWorld?.activeSceneId ?? ''));
        readTokens = Array.isArray(scene?.tokens) ? scene.tokens : [];
        tokensById = new Map(readTokens.map(token => [String(token?.id ?? ''), token]));
        actorsById = new Map((readWorld?.actors || []).map(actor => [String(actor?.id ?? ''), actor]));
      }

      refreshReadModel();

      function ensureReadModel() {
        if (!eventBackedReads) refreshReadModel();
      }

      function applyReadDocument(event) {
        const address = event?.detail?.document;
        if (!address || !['Actor', 'Token'].includes(address.type)) return;
        const value = event.detail.action === 'delete' ? null : api.documents?.get?.(address);
        if (address.type === 'Actor') {
          if (value) actorsById.set(String(address.id), value);
          else actorsById.delete(String(address.id));
          return;
        }
        if (String(address.parent?.id || '') !== String(readWorld?.activeSceneId || '')) return;
        const id = String(address.id);
        const index = readTokens.findIndex(token => String(token?.id) === id);
        if (!value) {
          tokensById.delete(id);
          if (index >= 0) readTokens = [...readTokens.slice(0, index), ...readTokens.slice(index + 1)];
        } else {
          tokensById.set(id, value);
          readTokens = index < 0
            ? [...readTokens, value]
            : [...readTokens.slice(0, index), value, ...readTokens.slice(index + 1)];
        }
      }

      async function commit(result, { source, reason = source, render = true } = {}) {
        await api.world.commit(result.world, { source, reason, render });
        refreshReadModel();
        return clone(result.token);
      }

      async function perform(operation, { source, render = true, kind = 'token' } = {}) {
        if (typeof api.world.performOperations !== 'function') return null;
        await api.world.performOperations([operation], { source, render, kind });
        refreshReadModel();
        return true;
      }

      api.tokens = {
        schemaVersion: 2,
        getActiveSceneId() { return String(readWorld?.activeSceneId || ''); },
        getActor(actorId) { ensureReadModel(); return clone(actorsById.get(String(actorId)) || null); },
        list() { ensureReadModel(); return clone(readTokens); },
        get(tokenId) { ensureReadModel(); return clone(tokensById.get(String(tokenId)) || null); },
        resolveActor(tokenId) {
          ensureReadModel();
          const token = tokensById.get(String(tokenId));
          if (!token) throw new Error(`Unknown Token: ${tokenId}`);
          const actor = actorsById.get(String(token.actorId));
          return resolveTokenActorDocuments(actor, token, { ruleset: api.ruleset });
        },
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
          refreshReadModel();
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
        async reposition(tokenId, point = {}) {
          const status = api.multiplayer?.getStatus?.();
          const role = status?.session?.role || status?.role || 'offline';
          if (!['gm', 'offline'].includes(role)) {
            const error = new Error('Only the GM can reposition Tokens');
            error.code = 'token_reposition_gm_only';
            throw error;
          }
          const world = api.world.get();
          if (!await perform({ type: 'token.reposition', payload: {
            sceneId: world.activeSceneId, tokenId: String(tokenId), placement: 'map', x: point.x, y: point.y,
          } }, { source: 'token:reposition' })) throw new Error('Reposition requires World operations');
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

      for (const eventName of ['state:commit', 'state:import', 'scene:activate']) {
        api.on?.(eventName, event => refreshReadModel(event?.detail?.state || null));
      }
      for (const eventName of ['document:create', 'document:update', 'document:delete', 'document:move']) {
        api.on?.(eventName, applyReadDocument);
      }

      api.emit?.('tokens:ready', {
        schemaVersion: 2,
        count: api.tokens.list().length,
      });
    },
  });
}
