import { mergeActorDelta } from '../token/actor.js';
import { normalizeFogState } from './fog.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ids(value) {
  return new Set((Array.isArray(value) ? value : []).map(item => String(item ?? '')).filter(Boolean));
}

function ownershipLevel(user, actorId) {
  return String(user?.ownership?.[String(actorId)] || 'none');
}

function activeScene(world) {
  return (world?.scenes || []).find(scene => String(scene?.id ?? '') === String(world?.activeSceneId ?? '')) || null;
}

function actorMap(world) {
  return new Map((world?.actors || []).map(actor => [String(actor?.id ?? ''), actor]));
}

function tokenControlled(token, actor, context) {
  if (context.role === 'gm') return true;
  if (!context.userId) return false;
  if (ids(token?.controllerUserIds).has(context.userId)) return true;
  return actor?.type === 'pc' && ownershipLevel(context.user, actor.id) === 'owner';
}

function viewerParties(world, context) {
  const parties = new Set();
  const actors = actorMap(world);
  for (const actor of world?.actors || []) {
    if (['pc', 'summon'].includes(String(actor?.type || ''))
      && ownershipLevel(context.user, actor.id) === 'owner' && actor.partyId) {
      parties.add(String(actor.partyId));
    }
  }
  for (const scene of world?.scenes || []) {
    for (const token of scene.tokens || []) {
      const actor = actors.get(String(token.actorId));
      if (['pc', 'summon'].includes(String(actor?.type || ''))
        && actor?.partyId && tokenControlled(token, actor, context)) {
        parties.add(String(actor.partyId));
      }
    }
  }
  return parties;
}

function visibleByPolicy(entity, actor, context, parties) {
  const visibility = plainObject(entity?.visibility) ? entity.visibility : { mode: 'public', userIds: [] };
  if (visibility.mode === 'gm') return false;
  if (tokenControlled(entity, actor, context)) return true;
  if (ids(visibility.userIds).has(context.userId)) return true;
  if (visibility.mode === 'users') return false;
  if (visibility.mode === 'party') return Boolean(actor?.partyId && parties.has(String(actor.partyId)));
  return visibility.mode === 'public';
}

function effectsForToken(token, actor) {
  const deltaEffects = token?.actorLink === false && Array.isArray(token?.actorDelta?.effects)
    ? token.actorDelta.effects
    : actor?.effects;
  return [...(Array.isArray(deltaEffects) ? deltaEffects : []), ...(Array.isArray(token?.effects) ? token.effects : [])];
}

function tokenInvisible(token, actor, definitions) {
  return effectsForToken(token, actor).some(effect => {
    if (effect?.enabled === false) return false;
    return definitions.get(String(effect?.definitionId ?? ''))?.capabilities?.visibility === 'invisible';
  });
}

function tokenVisionPrecision(token, actor, definitions) {
  return effectsForToken(token, actor).some(effect => effect?.enabled !== false
    && definitions.get(String(effect?.definitionId ?? ''))?.capabilities?.visionPrecision === 'vague')
    ? 'vague'
    : 'precise';
}

function authorizedForPrivateData(token, actor, context, parties) {
  return tokenControlled(token, actor, context)
    || ids(token?.visibility?.userIds).has(context.userId)
    || Boolean((actor?.type === 'pc' || actor?.type === 'summon')
      && actor?.partyId && parties.has(String(actor.partyId)));
}

function currentVision(world, context, actors) {
  const scene = activeScene(world);
  const token = scene?.tokens?.find(item => String(item?.id ?? '') === String(context.visionSourceTokenId ?? '')) || null;
  const actor = token ? actors.get(String(token.actorId)) : null;
  if (!token || !actor || token.placement !== 'map' || !tokenControlled(token, actor, context)) return null;
  const resolved = token.actorLink === false ? mergeActorDelta(actor, token.actorDelta) : actor;
  const description = context.ruleset?.vision?.describe?.(resolved, {
    token, user: context.user, scene, lighting: scene?.settings?.lighting || 'normal',
  }) || {};
  const legacyOverride = token.vision?.rangeOverrideMeters;
  const preciseOverride = token.vision?.preciseRangeOverrideMeters ?? legacyOverride;
  const vagueOverride = token.vision?.vagueRangeOverrideMeters ?? legacyOverride;
  const preciseRangeMeters = preciseOverride === null || preciseOverride === undefined
    ? Number(description.preciseRangeMeters ?? description.rangeMeters) || 0
    : Number(preciseOverride) || 0;
  const vagueRangeMeters = vagueOverride === null || vagueOverride === undefined
    ? Math.max(preciseRangeMeters, Number(description.vagueRangeMeters ?? preciseRangeMeters) || 0)
    : Math.max(preciseRangeMeters, Number(vagueOverride) || 0);
  const definitions = new Map((world.statusDefinitions || []).map(item => [String(item?.id ?? ''), item]));
  const effectivePreciseRangeMeters = tokenVisionPrecision(token, actor, definitions) === 'vague'
    ? 0
    : preciseRangeMeters;
  if (token.vision?.enabled === false || vagueRangeMeters <= 0) return null;
  return {
    tokenId: String(token.id), x: Number(token.x), y: Number(token.y),
    rangeMeters: effectivePreciseRangeMeters,
    preciseRangeMeters: effectivePreciseRangeMeters,
    vagueRangeMeters: Math.max(effectivePreciseRangeMeters, vagueRangeMeters),
    senses: clone(description.senses || {}), lighting: description.lighting || 'normal',
  };
}

function detectionLevel(token, vision, metersPerUnit) {
  if (!vision || token?.placement !== 'map') return 'none';
  const distance = Math.hypot(Number(token.x) - vision.x, Number(token.y) - vision.y) * metersPerUnit;
  if (distance <= vision.preciseRangeMeters) return 'precise';
  if (distance <= vision.vagueRangeMeters) return 'vague';
  return 'none';
}

function restrictedActor(actor) {
  return {
    id: String(actor.id),
    name: String(actor.name || 'Unknown'),
    img: typeof actor.img === 'string' ? actor.img : null,
    type: ['pc', 'monster', 'npc', 'summon', 'other'].includes(String(actor.type)) ? String(actor.type) : 'other',
    partyId: null,
    prototypeToken: {
      texture: { src: typeof actor.img === 'string' ? actor.img : null },
      showName: actor.prototypeToken?.showName !== false,
    },
    system: {},
    effects: [],
    audienceRestricted: true,
  };
}

function actorPlacementGranted(actor, context) {
  const grants = context.user?.placementGrants || {};
  return (Array.isArray(grants.actorIds) && grants.actorIds.map(String).includes(String(actor.id)))
    || (Array.isArray(grants.actorTypes) && grants.actorTypes.map(String).includes(String(actor.type)));
}

function restrictedToken(token, {
  level = 'precise', vision = null, metersPerUnit = 1, opaqueIdFor = null,
} = {}) {
  const vague = level === 'vague';
  const opaque = typeof opaqueIdFor === 'function'
    ? opaqueIdFor
    : (kind, value) => `audience-${kind}-${String(value)}`;
  const vagueId = opaque('token', token.id);
  const vagueActorId = opaque('actor', token.id);
  const actorLink = vague ? true : token.actorLink !== false;
  const quantize = value => Math.round(Number(value) * metersPerUnit / 5) * 5 / metersPerUnit;
  return {
    id: vague ? vagueId : String(token.id),
    actorId: vague ? vagueActorId : String(token.actorId),
    actorLink,
    actorDelta: actorLink ? null : { system: {}, effects: [] },
    placement: token.placement === 'feature' ? 'feature' : 'map',
    x: token.placement === 'map' ? (vague ? quantize(token.x) : Number(token.x)) : null,
    y: token.placement === 'map' ? (vague ? quantize(token.y) : Number(token.y)) : null,
    featureId: token.placement === 'feature' ? String(token.featureId || '') || null : null,
    texture: vague ? { src: null } : clone(token.texture || { src: null }),
    color: vague ? '#7b8587' : token.color == null ? null : String(token.color),
    diameterMeters: Number(token.diameterMeters) || 1,
    rotation: Number(token.rotation) || 0,
    elevationFt: Number(token.elevationFt) || 0,
    locked: token.locked === true,
    showName: vague ? false : token.showName !== false,
    effects: [],
    controllerUserIds: [],
    visibility: { mode: 'public', userIds: [] },
    vision: {
      enabled: false,
      preciseRangeOverrideMeters: null,
      vagueRangeOverrideMeters: null,
      overrideUserIds: [],
    },
    audienceRestricted: true,
    audienceVisibility: vague ? 'vague' : 'precise',
    ...(vague ? { approximateDirection: Math.atan2(Number(token.y) - vision.y, Number(token.x) - vision.x) } : {}),
  };
}

function vagueActor(token, opaqueIdFor) {
  return {
    id: opaqueIdFor('actor', token.id),
    name: '模糊轮廓', img: null, type: 'other', partyId: null,
    prototypeToken: { texture: { src: null }, showName: false },
    system: {}, effects: [], audienceRestricted: true, audienceVisibility: 'vague',
  };
}

function referencesHiddenEntity(value, hiddenActorIds, hiddenTokenIds, depth = 0) {
  if (depth > 5 || value == null) return false;
  if (Array.isArray(value)) return value.some(item => referencesHiddenEntity(item, hiddenActorIds, hiddenTokenIds, depth + 1));
  if (!plainObject(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (/tokenid$/i.test(key) && hiddenTokenIds.has(String(item))) return true;
    if (/actorid$/i.test(key) && hiddenActorIds.has(String(item))) return true;
    if (referencesHiddenEntity(item, hiddenActorIds, hiddenTokenIds, depth + 1)) return true;
  }
  return false;
}

function projectMarker(marker, context, parties) {
  const mode = String(marker?.visibility?.mode || 'public');
  if (mode === 'gm') return null;
  if (ids(marker?.controllerUserIds).has(context.userId)) return clone(marker);
  if (ids(marker?.visibility?.userIds).has(context.userId)) return clone(marker);
  if (mode === 'public' || (mode === 'party' && marker?.partyId && parties.has(String(marker.partyId)))) {
    const projected = clone(marker);
    projected.controllerUserIds = [];
    projected.visibility = { mode, userIds: [] };
    return projected;
  }
  return null;
}

export function projectStateForAudience(rawState, rawContext = {}) {
  const state = clone(rawState);
  if (!state) return state;
  const localOpaqueIds = new Map();
  const localOpaqueIdFor = (kind, rawId) => {
    const key = `${String(kind)}:${String(rawId)}`;
    if (!localOpaqueIds.has(key)) {
      const suffix = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localOpaqueIds.set(key, `audience-${String(kind)}-${suffix}`);
    }
    return localOpaqueIds.get(key);
  };
  const context = {
    ...rawContext,
    userId: rawContext.userId == null ? '' : String(rawContext.userId),
    opaqueIdFor: typeof rawContext.opaqueIdFor === 'function'
      ? rawContext.opaqueIdFor
      : localOpaqueIdFor,
  };
  const world = state?.preferences?.worldV2;
  if (!plainObject(world)) return state;
  const actors = actorMap(world);
  if (context.role === 'gm') {
    const vision = currentVision(world, context, actors);
    if (vision) {
      const source = activeScene(world)?.tokens?.find(token => String(token.id) === vision.tokenId);
      const actor = source ? actors.get(String(source.actorId)) : null;
      state.preferences.audienceVision = {
        schemaVersion: 1, source: vision,
        partyIds: actor?.partyId ? [String(actor.partyId)] : [],
        gmPreview: true,
      };
    } else if (state.preferences) delete state.preferences.audienceVision;
    return state;
  }
  const parties = viewerParties(world, context);
  const definitions = new Map((world.statusDefinitions || []).map(item => [String(item?.id ?? ''), item]));
  const vision = currentVision(world, context, actors);
  const metersPerUnit = Math.max(0.000001, Number(context.mapMetrics?.metersPerUnit) || 1);
  const visibleTokenIds = new Set();
  const privateActorIds = new Set();
  const referencedActorIds = new Set();
  const restrictedActorIds = new Set();
  const restrictedTokenIds = new Set();
  const vagueActors = [];

  for (const scene of world.scenes || []) {
    const isActive = String(scene.id) === String(world.activeSceneId);
    const sceneVisibleTokenIds = new Set();
    scene.tokens = (scene.tokens || []).flatMap(rawToken => {
      const actor = actors.get(String(rawToken.actorId));
      if (!actor || !visibleByPolicy(rawToken, actor, context, parties)) return [];
      const authorized = authorizedForPrivateData(rawToken, actor, context, parties);
      if (tokenInvisible(rawToken, actor, definitions) && !authorized) return [];
      const hostile = !authorized;
      const level = hostile && isActive ? detectionLevel(rawToken, vision, metersPerUnit) : 'precise';
      if (hostile && (!isActive || level === 'none')) return [];
      let token = clone(rawToken);
      if (authorized) {
        visibleTokenIds.add(String(token.id));
        sceneVisibleTokenIds.add(String(token.id));
        referencedActorIds.add(String(actor.id));
        privateActorIds.add(String(actor.id));
        if (tokenInvisible(rawToken, actor, definitions)) token.audienceVisibility = 'allied-invisible';
      } else if (level === 'vague') {
        token = restrictedToken(rawToken, {
          level, vision, metersPerUnit, opaqueIdFor: context.opaqueIdFor,
        });
        vagueActors.push(vagueActor(rawToken, context.opaqueIdFor));
      } else {
        visibleTokenIds.add(String(token.id));
        sceneVisibleTokenIds.add(String(token.id));
        referencedActorIds.add(String(actor.id));
        token = restrictedToken(rawToken, { level, vision, metersPerUnit });
        restrictedActorIds.add(String(actor.id));
        restrictedTokenIds.add(String(token.id));
      }
      return [token];
    });
    scene.markers = (scene.markers || []).flatMap(marker => projectMarker(marker, context, parties) || []);
    scene.attackAreas = (scene.attackAreas || []).filter(area => area?.anchor?.type !== 'token'
      || sceneVisibleTokenIds.has(String(area.anchor.tokenId)));
    const fog = normalizeFogState(scene.fog);
    fog.exploredByParty = Object.fromEntries(Object.entries(fog.exploredByParty)
      .filter(([partyId]) => parties.has(String(partyId))));
    scene.fog = fog;
  }

  const hiddenActorIds = new Set();
  world.actors = (world.actors || []).flatMap(actor => {
    const actorId = String(actor.id);
    const access = ownershipLevel(context.user, actorId);
    const owned = access === 'owner';
    const observed = access === 'observer';
    const limited = access === 'limited';
    const allied = Boolean((actor.type === 'pc' || actor.type === 'summon')
      && actor.partyId && parties.has(String(actor.partyId)));
    const placementGranted = actorPlacementGranted(actor, context);
    if (!referencedActorIds.has(actorId) && !owned && !observed && !limited && !allied && !placementGranted) {
      hiddenActorIds.add(actorId);
      return [];
    }
    if (privateActorIds.has(actorId) || owned || observed || allied) return [clone(actor)];
    restrictedActorIds.add(actorId);
    return [restrictedActor(actor)];
  });
  world.actors.push(...vagueActors);
  const hiddenTokenIds = new Set();
  for (const scene of rawState?.preferences?.worldV2?.scenes || []) {
    for (const token of scene.tokens || []) if (!visibleTokenIds.has(String(token.id))) hiddenTokenIds.add(String(token.id));
  }
  restrictedActorIds.forEach(id => hiddenActorIds.add(id));
  restrictedTokenIds.forEach(id => hiddenTokenIds.add(id));
  for (const scene of world.scenes || []) {
    scene.sceneEvents = (scene.sceneEvents || []).filter(event =>
      !referencesHiddenEntity(event, hiddenActorIds, hiddenTokenIds));
    scene.attackAreas = (scene.attackAreas || []).filter(area =>
      !referencesHiddenEntity(area, hiddenActorIds, hiddenTokenIds));
  }
  const active = activeScene(world);
  state.preferences.entitySystem = {
    ...(plainObject(state.preferences.entitySystem) ? state.preferences.entitySystem : {}),
    actors: clone(world.actors),
    tokens: clone(active?.tokens || []),
    statusDefinitions: clone(world.statusDefinitions || []),
  };
  const combat = state.preferences?.combatSystem?.combat;
  if (plainObject(combat)) {
    combat.combatants = (combat.combatants || []).filter(item => visibleTokenIds.has(String(item?.tokenId ?? '')));
    if (!combat.combatants.length) state.preferences.combatSystem.combat = null;
    else combat.turnIndex = Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0));
  }
  const chat = state.preferences?.chatSystem;
  if (plainObject(chat)) {
    chat.messages = (chat.messages || []).filter(message => !referencesHiddenEntity(message.data, hiddenActorIds, hiddenTokenIds));
  }
  state.preferences.audienceVision = {
    schemaVersion: 1,
    source: vision,
    partyIds: [...parties],
  };
  state.markers = clone(active?.markers || []);
  state.attackAreas = clone(active?.attackAreas || []);
  state.audienceProjection = true;
  return state;
}

export function canUserControlToken(state, tokenId, { user, userId } = {}) {
  const world = state?.preferences?.worldV2;
  const scene = activeScene(world);
  const token = scene?.tokens?.find(item => String(item?.id ?? '') === String(tokenId));
  const actor = token ? actorMap(world).get(String(token.actorId)) : null;
  return Boolean(token && actor && tokenControlled(token, actor, { user, userId: String(userId ?? '') }));
}
