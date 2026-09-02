import { describeActorSheet } from '../actor/index.js';

function entityActors(api) {
  const state = typeof api?.getState === 'function' ? api.getState() : null;
  const projected = state?.preferences?.entitySystem?.actors;
  if (Array.isArray(projected)) return projected;
  const canonical = state?.preferences?.worldV2?.actors;
  return Array.isArray(canonical) ? canonical : [];
}

function actorById(api, actorId) {
  const id = String(actorId || '').trim();
  if (!id) return null;
  return entityActors(api).find(actor => String(actor?.id || '') === id) || null;
}

export function actorSheetDescriptionFor(api, actorId) {
  const actor = actorById(api, actorId);
  if (!actor) return null;
  try {
    return describeActorSheet(actor, { ruleset: api?.ruleset }) || null;
  } catch {
    return null;
  }
}

export function defaultActorSheetTab(api, actorId) {
  const actor = actorById(api, actorId);
  if (!actor) return null;
  const described = actorSheetDescriptionFor(api, actorId);
  if (described?.defaultTab) return String(described.defaultTab);
  return ['monster', 'summon'].includes(String(actor.type || '')) ? 'combat' : 'overview';
}

export function installActorSheetOpenPolicy(api) {
  const entityApi = api?.entities;
  const openActor = entityApi?.openActor?.bind(entityApi);
  const openToken = entityApi?.openToken?.bind(entityApi);
  if (!openActor || !openToken) throw new Error('Actor sheet open policy requires Entity open APIs');

  const wrapped = {
    ...entityApi,
    openActor(actorId, tab = null) {
      return openActor(actorId, tab || defaultActorSheetTab(api, actorId));
    },
    openToken(tokenId, tab = null) {
      const token = api.tokens?.get?.(tokenId);
      return openToken(tokenId, tab || defaultActorSheetTab(api, token?.actorId));
    },
  };
  api.entities = wrapped;
  return wrapped;
}
