import { describeActorSheet } from '../actor/index.js';
import { actorSheetWindowKey, tokenSheetWindowKey } from './sheet-manager.js';

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

function worldStorageId(api) {
  return String(api?.world?.get?.()?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function localStorageFor(api) {
  try {
    return api?.map?.getContainer?.()?.ownerDocument?.defaultView?.localStorage || null;
  } catch {
    return null;
  }
}

function storedWindowTab(api, windowKey) {
  if (!windowKey) return null;
  const storage = localStorageFor(api);
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(`rpgmap.ui.actor-sheets.v1.${worldStorageId(api)}`);
    const parsed = JSON.parse(raw || '{}');
    if (parsed?.version !== 1 || !parsed.windows || typeof parsed.windows !== 'object') return null;
    const tab = String(parsed.windows?.[windowKey]?.tab || '').trim();
    return tab || null;
  } catch {
    return null;
  }
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

function actorOpenTab(api, actorId, explicitTab) {
  const requested = String(explicitTab || '').trim();
  if (requested) return requested;
  return storedWindowTab(api, actorSheetWindowKey(actorId)) || defaultActorSheetTab(api, actorId);
}

function tokenOpenTab(api, token, explicitTab) {
  const requested = String(explicitTab || '').trim();
  if (requested) return requested;
  const sceneId = String(api?.world?.get?.()?.activeSceneId || '').trim() || null;
  const key = tokenSheetWindowKey(sceneId, token?.id);
  return storedWindowTab(api, key) || defaultActorSheetTab(api, token?.actorId);
}

export function installActorSheetOpenPolicy(api) {
  const entityApi = api?.entities;
  const openActor = entityApi?.openActor?.bind(entityApi);
  const openToken = entityApi?.openToken?.bind(entityApi);
  if (!openActor || !openToken) throw new Error('Actor sheet open policy requires Entity open APIs');

  const wrapped = {
    ...entityApi,
    openActor(actorId, tab = null) {
      return openActor(actorId, actorOpenTab(api, actorId, tab));
    },
    openToken(tokenId, tab = null) {
      const token = api.tokens?.get?.(tokenId);
      return openToken(tokenId, tokenOpenTab(api, token, tab));
    },
  };
  api.entities = wrapped;
  return wrapped;
}
