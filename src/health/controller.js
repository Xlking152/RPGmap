import { EntityStore } from '../entities/store.js';
import { applyDamageToActor, applyHealingToActor, resolveActorHealth, setActorHealthMode } from './actor.js';

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
          if (!actor) return null;
          const state = setActorHealthMode(actor, mode);
          store.persist();
          return state;
        },
        applyDamageToTokenIds(tokenIds, damage) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const targets = uniqueActorsForTokens(store, tokenIds);
          const results = targets.map(({ tokenId, actor }) => ({
            tokenId,
            actorId: actor.id,
            actorName: actor.name,
            ...applyDamageToActor(actor, damage),
          }));
          if (results.length) store.persist();
          return results;
        },
        applyHealingToTokenIds(tokenIds, healing) {
          const store = new EntityStore(api);
          store.load({ migrateLegacy: false, dropMarkers: false });
          const targets = uniqueActorsForTokens(store, tokenIds);
          const results = targets.map(({ tokenId, actor }) => ({
            tokenId,
            actorId: actor.id,
            actorName: actor.name,
            ...applyHealingToActor(actor, healing),
          }));
          if (results.length) store.persist();
          return results;
        },
      };
      api.health = healthApi;
    },
  };
}
