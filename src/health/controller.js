import { deriveActorDocument, performActorOperation } from '../actor/index.js';
import { EntityStore } from '../entities/store.js';
import { createActorDelta } from '../token/actor.js';

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

function persistSyntheticActor(target) {
  if (!target?.synthetic) return;
  target.token.actorDelta = createActorDelta(target.baseActor, target.actor);
}

export function createHealthController() {
  return {
    register(api) {
      function persistHealth(store, actorIds = [], tokenIds = []) {
        store.persist({ source: 'health', immediate: true });
        api.emit?.('health:change', {
          actorIds: [...new Set(actorIds.map(String))],
          tokenIds: [...new Set(tokenIds.map(String))],
        });
      }

      function canEditActor(actorId) {
        const capabilities = api.multiplayer?.getCapabilities?.();
        return !capabilities || capabilities.canEditActor?.(actorId) !== false;
      }

      function controllableTargets(targets) {
        return targets.filter(({ actor }) => canEditActor(actor.id));
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
        setMode(actorId, mode) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const actor = store.actor(actorId);
          if (!actor || !canEditActor(actor.id)) return null;
          const context = store.actorContext(actor);
          const result = runHealthOperation(actor, { type: 'health.set-mode', mode }, context);
          if (result.changed) persistHealth(store, [actor.id]);
          return result.value || resolveActorHealth(actor, context);
        },
        performActorOperation(actorId, operation) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const actor = store.actor(actorId);
          if (!actor || !canEditActor(actor.id)) return null;
          const context = store.actorContext(actor);
          const before = resolveActorHealth(actor, context);
          const result = runHealthOperation(actor, { type: 'health.runtime', operation }, context);
          if (result.changed) persistHealth(store, [actor.id]);
          return {
            before,
            after: result.value || before,
            changed: Boolean(result.changed),
            blocked: result.blocked || null,
          };
        },
        applyDamageToTokenIds(tokenIds, damage) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const targets = controllableTargets(healthTargetsForTokens(store, api, tokenIds));
          const results = targets.map(target => {
            const context = store.actorContext(target.actor);
            const operation = runHealthOperation(target.actor, {
              type: 'health.damage',
              amount: damage?.amount,
              damageType: damage?.type,
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
            persistSyntheticActor(target);
            return result;
          });
          if (results.length) persistHealth(
            store,
            results.map(result => result.actorId),
            results.map(result => result.tokenId),
          );
          return results;
        },
        applyHealingToTokenIds(tokenIds, healing) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const targets = controllableTargets(healthTargetsForTokens(store, api, tokenIds));
          const results = targets.map(target => {
            const context = store.actorContext(target.actor);
            const operation = runHealthOperation(target.actor, {
              type: 'health.healing',
              amount: healing?.amount,
              damageType: healing?.type,
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
            persistSyntheticActor(target);
            return result;
          });
          if (results.length) persistHealth(
            store,
            results.map(result => result.actorId),
            results.map(result => result.tokenId),
          );
          return results;
        },
      };
      api.health = healthApi;
    },
  };
}
