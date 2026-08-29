import { deriveActorDocument, performActorOperation } from '../actor/index.js';
import { EntityStore } from '../entities/store.js';
import { createActorDelta } from '../token/actor.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

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
  const seen = new Set();
  const result = [];
  for (const requestedId of tokenIds.map(String)) {
    const token = store.token(requestedId);
    if (!token) continue;

    if (token.actorLink === false && api.tokens?.resolveActor) {
      const resolved = api.tokens.resolveActor(token.id);
      const key = `token:${token.id}`;
      if (!resolved?.actor || seen.has(key)) continue;
      seen.add(key);
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
    const key = `actor:${actor?.id ?? ''}`;
    if (!actor || seen.has(key)) continue;
    seen.add(key);
    result.push({ tokenId: String(token.id), token, actor, baseActor: actor, synthetic: false });
  }
  return result;
}

function worldOperationForTarget(target) {
  if (target.synthetic) {
    return {
      type: 'token.actorDelta.replace',
      payload: {
        tokenId: String(target.tokenId),
        actorDelta: createActorDelta(target.baseActor, target.actor),
      },
    };
  }
  return {
    type: 'actor.upsert',
    payload: { actor: clone(target.actor) },
  };
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
        const capabilities = api.multiplayer?.getCapabilities?.();
        return !capabilities || capabilities.canEditActor?.(actorId) !== false;
      }

      function controllableTargets(targets) {
        return targets.filter(({ actor }) => canEditActor(actor.id));
      }

      async function mutateTokenHealth(tokenIds, payload, operationType) {
        const store = new EntityStore(api);
        store.load({ migrateLegacy: false, dropMarkers: false });
        const targets = controllableTargets(healthTargetsForTokens(store, api, tokenIds));
        const operations = [];
        const changedTargets = [];
        const results = targets.map(target => {
          const context = store.actorContext(target.actor);
          const operation = runHealthOperation(target.actor, {
            type: operationType,
            amount: payload?.amount,
            damageType: payload?.type,
          }, context);
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
            operations.push(worldOperationForTarget(target));
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
        async setMode(actorId, mode) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const actor = store.actor(actorId);
          if (!actor || !canEditActor(actor.id)) return null;
          const context = store.actorContext(actor);
          const result = runHealthOperation(actor, { type: 'health.set-mode', mode }, context);
          if (result.changed) {
            await commitHealthOperations([worldOperationForTarget({ actor, synthetic: false })], {
              actorIds: [actor.id],
              source: 'health:mode',
            });
          }
          return result.value || resolveActorHealth(actor, context);
        },
        async performActorOperation(actorId, operation) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const actor = store.actor(actorId);
          if (!actor || !canEditActor(actor.id)) return null;
          const context = store.actorContext(actor);
          const before = resolveActorHealth(actor, context);
          const result = runHealthOperation(actor, { type: 'health.runtime', operation }, context);
          if (result.changed) {
            await commitHealthOperations([worldOperationForTarget({ actor, synthetic: false })], {
              actorIds: [actor.id],
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
