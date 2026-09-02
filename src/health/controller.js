import { deriveActorDocument, performActorOperation } from '../actor/index.js';
import { EntityStore } from '../entities/store.js';

function uniqueIds(values = []) {
  return [...new Set(values.filter(value => value !== null && value !== undefined).map(String))];
}

function resolveActorHealth(actor, context) {
  return deriveActorDocument(actor, context)?.health || null;
}

function runHealthOperation(actor, operation, context) {
  return performActorOperation(actor, operation, context);
}

function healthTargetsForTokens(store, api, tokenIds = []) {
  const result = [];
  for (const requestedId of tokenIds.map(String)) {
    const token = store.token(requestedId);
    if (!token) continue;

    if (token.actorLink === false && api.tokens?.resolveActor) {
      const resolved = api.tokens.resolveActor(token.id);
      if (!resolved?.actor) continue;
      result.push({
        tokenId: String(token.id),
        token,
        actor: resolved.actor,
        baseActor: resolved.baseActor,
        synthetic: true,
      });
      continue;
    }

    const actor = store.actor(token.actorId);
    if (!actor) continue;
    result.push({ tokenId: String(token.id), token, actor, baseActor: actor, synthetic: false });
  }
  return result;
}

function worldOperationForTarget(target, operation, sceneId) {
  return {
    type: 'actor.runtime.perform',
    payload: {
      sceneId: String(sceneId),
      tokenId: String(target.tokenId),
      operation,
    },
  };
}

function worldOperationForActor(actorId, operation, sceneId) {
  return {
    type: 'actor.runtime.perform',
    payload: { sceneId: String(sceneId), actorId: String(actorId), operation },
  };
}

function healthTargetForSubject(store, api, actorId, tokenId = null) {
  if (tokenId) {
    const target = healthTargetsForTokens(store, api, [tokenId])[0] || null;
    if (!target || (actorId && String(target.baseActor?.id || target.actor?.id) !== String(actorId))) return null;
    return target;
  }
  const actor = store.actor(actorId);
  return actor ? { actor, baseActor: actor, tokenId: null, synthetic: false } : null;
}

export function createHealthController() {
  return {
    register(api) {
      async function commitHealthOperations(operations, {
        actorIds = [],
        tokenIds = [],
        source = 'health',
      } = {}) {
        if (!operations.length) return null;
        if (typeof api.world?.performOperations !== 'function') {
          const error = new Error('Health writes require World V2 operations');
          error.code = 'world_operation_required';
          throw error;
        }
        const result = await api.world.performOperations(operations, {
          source,
          render: false,
          kind: 'health',
        });
        api.emit?.('health:change', {
          actorIds: uniqueIds(actorIds),
          tokenIds: uniqueIds(tokenIds),
          canonical: true,
        });
        return result;
      }

      function canEditActor(actorId) {
        if (api.permissions?.can) return api.permissions.can('actor.edit', { actorId });
        const capabilities = api.multiplayer?.getCapabilities?.();
        return !capabilities || capabilities.canEditActor?.(actorId) !== false;
      }

      function canControlToken(tokenId, actorId) {
        if (api.permissions?.can) return api.permissions.can('token.editHealth', { tokenId, actorId });
        const multiplayer = api.multiplayer;
        if (!multiplayer?.getStatus?.()?.connected) return true;
        if (typeof multiplayer.canControlToken === 'function') return multiplayer.canControlToken(tokenId) === true;
        return canEditActor(actorId);
      }

      function controllableTargets(targets) {
        return targets.filter(({ tokenId, actor }) => canControlToken(tokenId, actor.id));
      }

      async function mutateTokenHealth(tokenIds, payload, operationType) {
        const store = new EntityStore(api);
        store.load({ migrateLegacy: false, dropMarkers: false });
        const targets = controllableTargets(healthTargetsForTokens(store, api, tokenIds));
        const operations = [];
        const changedTargets = [];
        const results = targets.map(target => {
          const context = store.actorContext(target.actor);
          const runtimeOperation = {
            type: operationType,
            amount: payload?.amount,
            damageType: payload?.type,
          };
          const operation = runHealthOperation(target.actor, runtimeOperation, context);
          const result = {
            tokenId: target.tokenId,
            actorId: target.actor.id,
            actorName: target.actor.name,
            synthetic: target.synthetic,
            before: operation.before || null,
            after: operation.value || resolveActorHealth(target.actor, context),
            applied: operation.applied || 0,
            overflow: operation.overflow || 0,
            blocked: operation.blocked || null,
          };
          if (operation.changed) {
            operations.push(worldOperationForTarget(target, runtimeOperation, api.world.get().activeSceneId));
            changedTargets.push(target);
          }
          return result;
        });

        if (operations.length) {
          await commitHealthOperations(operations, {
            actorIds: changedTargets.map(target => target.actor.id),
            tokenIds: changedTargets.map(target => target.tokenId),
            source: operationType === 'health.damage' ? 'health:damage' : 'health:healing',
          });
        }
        return results;
      }

      const healthApi = {
        resolveActor(actorId) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const actor = store.actor(actorId);
          return actor ? resolveActorHealth(actor, store.actorContext(actor)) : null;
        },
        resolveToken(tokenId) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          if (api.tokens?.resolveActor) {
            try {
              const resolved = api.tokens.resolveActor(tokenId);
              if (resolved?.actor) return resolveActorHealth(resolved.actor, store.actorContext(resolved.actor));
            } catch {}
          }
          const actor = store.actorForToken(tokenId);
          return actor ? resolveActorHealth(actor, store.actorContext(actor)) : null;
        },
        async setMode(actorId, mode, { tokenId = null } = {}) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const target = healthTargetForSubject(store, api, actorId, tokenId);
          if (!target) return null;
          const { actor } = target;
          const editable = target.tokenId
            ? canControlToken(target.tokenId, target.baseActor?.id || actor.id)
            : canEditActor(actor.id);
          if (!editable) return null;
          const context = store.actorContext(actor);
          const result = runHealthOperation(actor, { type: 'health.set-mode', mode }, context);
          if (result.changed) {
            const worldOperation = target.tokenId
              ? worldOperationForTarget(target, { type: 'health.set-mode', mode }, api.world.get().activeSceneId)
              : worldOperationForActor(actor.id, { type: 'health.set-mode', mode }, api.world.get().activeSceneId);
            await commitHealthOperations([worldOperation], {
              actorIds: [actor.id],
              tokenIds: target.tokenId ? [target.tokenId] : [],
              source: 'health:mode',
            });
          }
          return result.value || resolveActorHealth(actor, context);
        },
        async performActorOperation(actorId, operation, { tokenId = null } = {}) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const target = healthTargetForSubject(store, api, actorId, tokenId);
          if (!target) return null;
          const { actor } = target;
          const editable = target.tokenId
            ? canControlToken(target.tokenId, target.baseActor?.id || actor.id)
            : canEditActor(actor.id);
          if (!editable) return null;
          const context = store.actorContext(actor);
          const before = resolveActorHealth(actor, context);
          const result = runHealthOperation(actor, { type: 'health.runtime', operation }, context);
          if (result.changed) {
            const worldOperation = target.tokenId
              ? worldOperationForTarget(target, { type: 'health.runtime', operation }, api.world.get().activeSceneId)
              : worldOperationForActor(actor.id, { type: 'health.runtime', operation }, api.world.get().activeSceneId);
            await commitHealthOperations([worldOperation], {
              actorIds: [actor.id],
              tokenIds: target.tokenId ? [target.tokenId] : [],
              source: 'health:runtime',
            });
          }
          return {
            before,
            after: result.value || before,
            changed: Boolean(result.changed),
            blocked: result.blocked || null,
          };
        },
        async applyDamageToTokenIds(tokenIds, damage) {
          return mutateTokenHealth(tokenIds, damage, 'health.damage');
        },
        async applyHealingToTokenIds(tokenIds, healing) {
          return mutateTokenHealth(tokenIds, healing, 'health.healing');
        },
      };
      api.health = healthApi;
    },
  };
}
