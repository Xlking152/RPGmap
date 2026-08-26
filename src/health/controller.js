import { EntityStore } from '../entities/store.js';
import { applyDamageToActor, applyHealingToActor, resolveActorHealth, setActorHealthMode, setActorWounds } from './actor.js';

function uniqueActorsForTokens(store, tokenIds = []) {
  const seen = new Set();
  const result = [];
  for (const tokenId of tokenIds.map(String)) {
    const token = store.token(tokenId);
    if (!token) continue;
    const actor = store.actor(token.actorId);
    if (!actor || seen.has(String(actor.id))) continue;
    seen.add(String(actor.id));
    result.push({ tokenId, token, actor });
  }
  return result;
}

export function createHealthController() {
  return {
    register(api) {
      function persistHealth(store, actorIds = []) {
        // In LAN mode this emits state:commit immediately, so the multiplayer
        // client pushes the updated World instead of waiting for the browser
        // storage debounce. Persist locally as well before reporting success.
        store.persist({ source: 'health', immediate: true });
        api.emit?.('health:change', { actorIds: actorIds.map(String) });
      }

      function canEditActor(actorId) {
        const capabilities = api.multiplayer?.getCapabilities?.();
        return !capabilities || capabilities.canEditActor?.(actorId) !== false;
      }

      function controllableActors(targets) {
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
          const targets = controllableActors(uniqueActorsForTokens(store, tokenIds));
          const results = targets.map(({ tokenId, actor }) => ({
            tokenId,
            actorId: actor.id,
            actorName: actor.name,
            ...applyDamageToActor(actor, damage),
          }));
          if (results.length) persistHealth(store, results.map(result => result.actorId));
          return results;
        },
        applyHealingToTokenIds(tokenIds, healing) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const targets = controllableActors(uniqueActorsForTokens(store, tokenIds));
          const results = targets.map(({ tokenId, actor }) => ({
            tokenId,
            actorId: actor.id,
            actorName: actor.name,
            ...applyHealingToActor(actor, healing),
          }));
          if (results.length) persistHealth(store, results.map(result => result.actorId));
          return results;
        },
      };
      api.health = healthApi;
    },
  };
}
