import { EntityStore } from '../entities/store.js';
import { createActorDelta } from '../token/actor.js';
import { applyDamageToActor, applyHealingToActor, resolveActorHealth, setActorHealthMode, setActorWounds } from './actor.js';

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
        // In LAN mode this emits state:commit immediately, so the multiplayer
        // client pushes the updated World instead of waiting for the browser
        // storage debounce. Persist locally as well before reporting success.
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
          return actor ? resolveActorHealth(actor) : null;
        },
        resolveToken(tokenId) {
          if (api.tokens?.resolveActor) {
            try {
              const resolved = api.tokens.resolveActor(tokenId);
              if (resolved?.actor) return resolveActorHealth(resolved.actor);
            } catch {}
          }
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const actor = store.actorForToken(tokenId);
          return actor ? resolveActorHealth(actor) : null;
        },
        setMode(actorId, mode) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const actor = store.actor(actorId);
          if (!actor || !canEditActor(actor.id)) return null;
          const state = setActorHealthMode(actor, mode);
          persistHealth(store, [actor.id]);
          return state;
        },
        setWounds(actorId, wounds) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const actor = store.actor(actorId);
          if (!actor || !canEditActor(actor.id)) return null;
          const result = setActorWounds(actor, wounds);
          if (!result.changed) return result;
          persistHealth(store, [actor.id]);
          return result;
        },
        applyDamageToTokenIds(tokenIds, damage) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const targets = controllableTargets(healthTargetsForTokens(store, api, tokenIds));
          const results = targets.map(target => {
            const result = {
              tokenId: target.tokenId,
              actorId: target.actor.id,
              actorName: target.actor.name,
              synthetic: target.synthetic,
              ...applyDamageToActor(target.actor, damage),
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
            const result = {
              tokenId: target.tokenId,
              actorId: target.actor.id,
              actorName: target.actor.name,
              synthetic: target.synthetic,
              ...applyHealingToActor(target.actor, healing),
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
