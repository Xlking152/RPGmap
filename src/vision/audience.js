import { mergeActorDelta } from '../token/actor.js';
import { normalizeFogState } from './fog.js';
import { normalizeActorPublicProfile } from '../actor/public-profile.js';
import { canPlaceActorTemplate } from '../permissions/model.js';
import { sceneVisionContext } from './context.js';
import {
  deriveSceneLightSources,
  perceptionLevelAtPoint,
  sphereGroundRadiusMeters,
  visionIgnoresOcclusion,
  visionOccludersForSource,
} from '../spatial/kernel.js';
import { journalVisibleToAudience } from '../journal/model.js';

const clone = structuredClone;
const projectionAudiences = new WeakMap();
const vagueActorDocuments = new WeakSet();
const audienceKey = context => JSON.stringify([context.role, context.userId,
  context.user?.ownership || {}, context.user?.placementGrants || {}, context.user?.disabled === true]);

// Audience projection is executed once per connected session for every
// authoritative commit. Cloning the complete World here made a one-Token
// move proportional to the entire 500-Token fixture before projection even
// began. Build a copy-on-write shell instead; every branch mutated below is
// replaced before it is changed, while selected output documents are cloned
// at the point they enter the projection.
function projectionShell(rawState) {
  if (!rawState) return rawState;
  const rawPreferences = plainObject(rawState.preferences) ? rawState.preferences : {};
  const rawWorld = plainObject(rawPreferences.worldV2) ? rawPreferences.worldV2 : null;
  const preferences = { ...rawPreferences };
  if (rawWorld) {
    preferences.worldV2 = {
      ...rawWorld,
      actors: Array.isArray(rawWorld.actors) ? rawWorld.actors : [],
      statusDefinitions: Array.isArray(rawWorld.statusDefinitions) ? rawWorld.statusDefinitions : [],
      scenes: (Array.isArray(rawWorld.scenes) ? rawWorld.scenes : []).map(scene => ({
        ...scene,
        tokens: Array.isArray(scene?.tokens) ? scene.tokens : [],
        markers: Array.isArray(scene?.markers) ? scene.markers : [],
        attackAreas: Array.isArray(scene?.attackAreas) ? scene.attackAreas : [],
        sceneEvents: Array.isArray(scene?.sceneEvents) ? scene.sceneEvents : [],
      })),
    };
  }
  if (plainObject(rawPreferences.combatSystem)) {
    preferences.combatSystem = {
      ...rawPreferences.combatSystem,
      combat: plainObject(rawPreferences.combatSystem.combat)
        ? { ...rawPreferences.combatSystem.combat, combatants: clone(rawPreferences.combatSystem.combat.combatants || []) }
        : rawPreferences.combatSystem.combat,
    };
  }
  if (plainObject(rawPreferences.chatSystem)) {
    preferences.chatSystem = {
      ...rawPreferences.chatSystem,
      messages: Array.isArray(rawPreferences.chatSystem.messages) ? rawPreferences.chatSystem.messages : [],
    };
  }
  return { ...rawState, preferences };
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasId(value, target) {
  return Array.isArray(value) && Boolean(target) && value.some(item => String(item ?? '') === target);
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
  if (hasId(token?.controllerUserIds, context.userId)) return true;
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

function explicitVisibilityGranted(entity, context) {
  if (String(entity?.visibility?.mode || 'public') === 'gm') return false;
  return hasId(entity?.visibility?.userIds, context.userId);
}

function visibleByPolicy(entity, actor, context, parties, controlled) {
  const visibility = plainObject(entity?.visibility) ? entity.visibility : { mode: 'public', userIds: [] };
  if (visibility.mode === 'gm') return false;
  if (controlled) return true;
  if (explicitVisibilityGranted(entity, context)) return true;
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

function authorizedForPrivateData(actor, parties, controlled) {
  return controlled
    || Boolean((actor?.type === 'pc' || actor?.type === 'summon')
      && actor?.partyId && parties.has(String(actor.partyId)));
}

function currentVision(world, context, actors) {
  const scene = activeScene(world);
  const token = scene?.tokens?.find(item => String(item?.id ?? '') === String(context.visionSourceTokenId ?? '')) || null;
  const actor = token ? actors.get(String(token.actorId)) : null;
  if (!token || !actor || token.placement !== 'map' || !tokenControlled(token, actor, context)) return null;
  const resolved = token.actorLink === false ? mergeActorDelta(actor, token.actorDelta) : actor;
  const description = (context.describeVision || context.ruleset?.vision?.describe)?.(resolved, {
    token, user: context.user, scene, lighting: 'normal',
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
  return Object.freeze({
    tokenId: String(token.id), x: Number(token.x), y: Number(token.y),
    elevationMeters: Number(token.elevationMeters) || 0,
    rangeMeters: effectivePreciseRangeMeters,
    preciseRangeMeters: effectivePreciseRangeMeters,
    vagueRangeMeters: Math.max(effectivePreciseRangeMeters, vagueRangeMeters),
    preciseGroundRangeMeters: sphereGroundRadiusMeters(effectivePreciseRangeMeters, token.elevationMeters) ?? 0,
    vagueGroundRangeMeters: sphereGroundRadiusMeters(
      Math.max(effectivePreciseRangeMeters, vagueRangeMeters), token.elevationMeters,
    ) ?? 0,
    lineOfSightEnabled: true,
    senses: clone(description.senses || {}),
    lighting: scene?.settings?.lighting || 'normal',
  });
}

function detectionLevel(token, vision, metersPerUnit, {
  lineOfSightEnabled = false, occluders = [], sourceOccluders = null, lights = [], ambient = 'normal',
} = {}) {
  if (!vision || token?.placement !== 'map') return 'none';
  return perceptionLevelAtPoint({
    vision, target: token, ambient, lights, occluders, sourceOccluders, metersPerUnit, lineOfSightEnabled,
  });
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
    publicProfile: normalizeActorPublicProfile(actor.publicProfile, { preserveUnknown: false }),
    audienceRestricted: true,
  };
}

function publicStatusesForToken(token, actor, definitions) {
  const profile = normalizeActorPublicProfile(actor?.publicProfile, { preserveUnknown: false });
  const allowed = new Set(profile.visibleStatusDefinitionIds);
  if (!allowed.size) return [];
  return effectsForToken(token, actor).flatMap(effect => {
    if (effect?.enabled === false) return [];
    const definition = definitions.get(String(effect?.definitionId ?? ''));
    if (!definition || !allowed.has(String(definition.id))) return [];
    return [{
      name: String(definition.name || definition.label || '状态').slice(0, 120),
      icon: String(definition.icon || 'circle-dot').slice(0, 80),
      color: /^#[0-9a-f]{6}$/i.test(String(definition.color || '')) ? String(definition.color) : '#64748b',
      category: ['buff', 'debuff', 'neutral'].includes(String(definition.category)) ? String(definition.category) : 'neutral',
      stacks: Math.max(1, Math.min(99, Math.floor(Number(effect.stacks) || 1))),
    }];
  });
}

function actorPlacementGranted(actor, context) {
  const grants = context.user?.placementGrants || {};
  return canPlaceActorTemplate(actor, grants);
}

function restrictedToken(token, {
  level = 'precise', vision = null, metersPerUnit = 1, opaqueIdFor = null,
  actor = null, definitions = new Map(),
} = {}) {
  const vague = level === 'vague';
  const opaque = typeof opaqueIdFor === 'function'
    ? opaqueIdFor
    : (kind, value) => `audience-${kind}-${String(value)}`;
  const vagueId = vague ? opaque('token', token.id) : null;
  const vagueActorId = vague ? opaque('actor', token.id) : null;
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
    elevationMeters: Number(token.elevationMeters) || 0,
    light: vague || token.light?.enabled !== true ? {
      enabled: false, rangeMeters: 0, intensity: 0, color: '#fff3c4', elevationOffsetMeters: 0, occlusion: 'scene',
    } : {
      enabled: true,
      rangeMeters: Math.max(0, Number(token.light.rangeMeters) || 0),
      intensity: Math.max(0, Math.min(4, Number(token.light.intensity) || 0)),
      color: /^#[0-9a-f]{6}$/i.test(String(token.light.color || '')) ? String(token.light.color) : '#fff3c4',
      elevationOffsetMeters: Math.max(0, Number(token.light.elevationOffsetMeters) || 0),
      occlusion: token.light.occlusion === 'none' ? 'none' : 'scene',
    },
    locked: token.locked === true,
    showName: vague ? false : token.showName !== false,
    effects: [],
    publicStatuses: vague || !actor ? [] : publicStatusesForToken(token, actor, definitions),
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
  const actor = {
    id: opaqueIdFor('actor', token.id),
    name: '模糊轮廓', img: null, type: 'other', partyId: null,
    prototypeToken: { texture: { src: null }, showName: false },
    system: {}, effects: [], audienceRestricted: true, audienceVisibility: 'vague',
  };
  vagueActorDocuments.add(actor);
  return actor;
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
  if (hasId(marker?.controllerUserIds, context.userId)) return clone(marker);
  if (hasId(marker?.visibility?.userIds, context.userId)) return clone(marker);
  if (mode === 'public' || (mode === 'party' && marker?.partyId && parties.has(String(marker.partyId)))) {
    const projected = clone(marker);
    projected.controllerUserIds = [];
    projected.visibility = { mode, userIds: [] };
    return projected;
  }
  return null;
}

export function projectStateForAudience(rawState, rawContext = {}) {
  const state = projectionShell(rawState);
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
  delete world.templateLibrary;
  const parties = viewerParties(world, context);
  world.journals = (world.journals || [])
    .filter(entry => journalVisibleToAudience(entry, {
      role: context.role, userId: context.userId, partyIds: [...parties],
    }))
    .map(entry => structuredClone(entry));
  const definitions = new Map((world.statusDefinitions || []).map(item => [String(item?.id ?? ''), item]));
  const vision = currentVision(world, context, actors);
  const metersPerUnit = Math.max(0.000001, Number(context.mapMetrics?.metersPerUnit) || 1);
  const currentScene = activeScene(world);
  const lineOfSightEnabled = true;
  const spatial = context.mapPackage ? sceneVisionContext(context.mapPackage, currentScene) : null;
  const occluders = spatial?.occluders || [];
  const sourceOccluders = vision && !visionIgnoresOcclusion(vision)
    ? visionOccludersForSource(vision, occluders, metersPerUnit) : occluders;
  const lights = spatial?.lights || deriveSceneLightSources(context.mapPackage, currentScene);
  const stamp = audienceKey(context);
  const requestedCache = context.movementCache;
  const movementCache = requestedCache && projectionAudiences.get(requestedCache.previousProjection?.preferences?.audienceVision) === stamp
    ? requestedCache : null;
  const previousWorld = movementCache?.beforeState?.preferences?.worldV2;
  const previousProjection = movementCache?.previousProjection;
  const previousActors = actorMap(previousWorld);
  const projectedActors = actorMap(previousProjection?.preferences?.worldV2);
  const previousScenes = new Map((previousWorld?.scenes || []).map(scene => [String(scene.id), scene]));
  const projectedScenes = new Map((previousProjection?.preferences?.worldV2?.scenes || []).map(scene => [String(scene.id), scene]));
  const sourceUnchanged = movementCache && JSON.stringify(previousProjection?.preferences?.audienceVision?.source || null)
    === JSON.stringify(vision);
  const partiesUnchanged = movementCache && JSON.stringify([...(previousProjection?.preferences?.audienceVision?.partyIds || [])].sort())
    === JSON.stringify([...parties].sort());
  const definitionsUnchanged = movementCache && previousWorld?.statusDefinitions === rawState.preferences.worldV2.statusDefinitions;
  const oldActive = previousScenes.get(String(world.activeSceneId));
  const rawActive = activeScene(rawState.preferences.worldV2);
  const geometryUnchanged = oldActive && oldActive.featureStates === rawActive?.featureStates
    && oldActive.sceneEvents === rawActive?.sceneEvents && oldActive.occlusionShapes === rawActive?.occlusionShapes
    && oldActive.settings === rawActive?.settings && oldActive.mapPackage === rawActive?.mapPackage;
  const movedIds = movementCache?.tokenIds || new Set();
  const lightMoved = movementCache && (rawActive?.tokens || []).some(token => movedIds.has(String(token.id))
    && (token.light?.enabled === true || oldActive?.tokens?.find(item => String(item.id) === String(token.id))?.light?.enabled === true));
  const reuseDetection = Boolean(sourceUnchanged && partiesUnchanged && definitionsUnchanged && geometryUnchanged && !lightMoved);
  const visibleTokenIds = new Set();
  const privateActorIds = new Set();
  const referencedActorIds = new Set();
  const restrictedActorIds = new Set();
  const restrictedTokenIds = new Set();
  const vagueActors = [];

  for (const scene of world.scenes || []) {
    const isActive = String(scene.id) === String(world.activeSceneId);
    const previousScene = previousScenes.get(String(scene.id));
    const projectedScene = projectedScenes.get(String(scene.id));
    const previousTokens = new Map((previousScene?.tokens || []).map(token => [String(token.id), token]));
    const projectedSceneTokens = projectedScene?.tokens || [];
    const projectedTokens = new Map(projectedSceneTokens.map(token => [String(token.id), token]));
    const hasVaguePrior = Boolean(sourceUnchanged && projectedSceneTokens.some(token => token.audienceVisibility === 'vague'));
    const sceneVisibleTokenIds = new Set();
    const projectedSceneTokensNext = [];
    for (const rawToken of scene.tokens || []) {
      const actor = actors.get(String(rawToken.actorId));
      const unchanged = movementCache && actor && previousTokens.get(String(rawToken.id)) === rawToken
        && previousActors.get(String(rawToken.actorId)) === actor && definitionsUnchanged && partiesUnchanged;
      const canReuseVaguePrior = hasVaguePrior && unchanged && !movedIds.has(String(rawToken.id));
      const prior = movementCache ? projectedTokens.get(String(rawToken.id))
        || (canReuseVaguePrior ? projectedTokens.get((context.lookupOpaqueId || context.opaqueIdFor)('token', rawToken.id)) : null) : null;
      if (reuseDetection && unchanged && !movedIds.has(String(rawToken.id))) {
        // The session, source, geometry, lights, permissions, party membership,
        // definitions and both canonical documents are unchanged. Reusing the
        // already masked Token also reuses the policy decision; no private
        // result is shared with another session or retained after invalidation.
        if (!prior) continue;
        if (prior.audienceVisibility === 'vague') {
          const previousActor = projectedActors.get(String(prior.actorId));
          if (previousActor) vagueActors.push(previousActor);
          else vagueActors.push(vagueActor(rawToken, context.opaqueIdFor));
        } else {
          visibleTokenIds.add(String(prior.id));
          sceneVisibleTokenIds.add(String(prior.id));
          referencedActorIds.add(String(actor.id));
          if (prior.audienceRestricted === true) {
            restrictedActorIds.add(String(actor.id));
            restrictedTokenIds.add(String(prior.id));
          } else privateActorIds.add(String(actor.id));
        }
        projectedSceneTokensNext.push(prior);
        continue;
      }
      if (!actor) continue;
      const controlled = tokenControlled(rawToken, actor, context);
      if (!visibleByPolicy(rawToken, actor, context, parties, controlled)) continue;
      const visibilityOverride = explicitVisibilityGranted(rawToken, context);
      const authorized = authorizedForPrivateData(actor, parties, controlled);
      if (tokenInvisible(rawToken, actor, definitions) && !authorized && !visibilityOverride) continue;
      const hostile = !authorized;
      const requiresDetection = hostile && !visibilityOverride;
      const level = requiresDetection && isActive
        ? reuseDetection && unchanged && !movedIds.has(String(rawToken.id))
          ? prior ? prior.audienceVisibility === 'vague' ? 'vague' : 'precise' : 'none'
          : detectionLevel(rawToken, vision, metersPerUnit, {
          lineOfSightEnabled: lineOfSightEnabled && !visionIgnoresOcclusion(vision), occluders, sourceOccluders, lights, ambient: currentScene?.settings?.lighting || 'normal',
        })
        : 'precise';
      if (requiresDetection && (!isActive || level === 'none')) continue;
      let token;
      if (authorized) {
        token = unchanged && prior && prior.audienceRestricted !== true ? prior : clone(rawToken);
        visibleTokenIds.add(String(token.id));
        sceneVisibleTokenIds.add(String(token.id));
        referencedActorIds.add(String(actor.id));
        privateActorIds.add(String(actor.id));
        if (tokenInvisible(rawToken, actor, definitions) && token.audienceVisibility !== 'allied-invisible') {
          token = { ...token, audienceVisibility: 'allied-invisible' };
        }
      } else if (level === 'vague') {
        token = unchanged && sourceUnchanged && prior?.audienceVisibility === 'vague' ? prior : restrictedToken(rawToken, {
          level, vision, metersPerUnit, opaqueIdFor: context.opaqueIdFor,
        });
        const priorVagueActor = movementCache ? projectedActors.get(String(token.actorId)) : null;
        vagueActors.push(vagueActorDocuments.has(priorVagueActor) ? priorVagueActor : vagueActor(rawToken, context.opaqueIdFor));
      } else {
        token = unchanged && prior?.audienceRestricted === true && prior.audienceVisibility === 'precise' ? prior : restrictedToken(rawToken, { level, vision, metersPerUnit, actor, definitions });
        visibleTokenIds.add(String(token.id));
        sceneVisibleTokenIds.add(String(token.id));
        referencedActorIds.add(String(actor.id));
        restrictedActorIds.add(String(actor.id));
        restrictedTokenIds.add(String(token.id));
      }
      projectedSceneTokensNext.push(token);
    }
    scene.tokens = projectedSceneTokensNext;
    scene.markers = (scene.markers || []).flatMap(marker => projectMarker(marker, context, parties) || []);
    scene.attackAreas = (scene.attackAreas || []).filter(area => area?.anchor?.type !== 'token'
      || sceneVisibleTokenIds.has(String(area.anchor.tokenId)));
    // Filter private party memory before copying and normalizing it. A viewer
    // of one party must not pay for every other party's large explored map.
    const fog = movementCache && partiesUnchanged && scene.fog === previousScene?.fog && projectedScene?.fog
      ? projectedScene.fog : normalizeFogState({ ...(scene.fog || {}), exploredByParty:
      Object.fromEntries(Object.entries(scene.fog?.exploredByParty || {})
        .filter(([partyId]) => parties.has(String(partyId)))) });
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
    const prior = movementCache && previousActors.get(actorId) === actor ? projectedActors.get(actorId) : null;
    if (privateActorIds.has(actorId) || owned || observed || allied) return [prior && prior.audienceRestricted !== true ? prior : clone(actor)];
    restrictedActorIds.add(actorId);
    return [prior?.audienceRestricted === true ? prior : restrictedActor(actor)];
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
    actors: context.trustedProjection ? [...world.actors] : clone(world.actors),
    tokens: context.trustedProjection ? [...(active?.tokens || [])] : clone(active?.tokens || []),
    statusDefinitions: context.trustedProjection ? [...(world.statusDefinitions || [])] : clone(world.statusDefinitions || []),
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
  projectionAudiences.set(state.preferences.audienceVision, stamp);
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
