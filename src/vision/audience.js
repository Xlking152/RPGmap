import { mergeActorDelta } from '../token/actor.js';
import { normalizeFogState } from './fog.js';
import { normalizeActorPublicProfile } from '../actor/public-profile.js';
import { canPlaceActorTemplate } from '../permissions/model.js';
import { sceneVisionContext } from './context.js';
import { isImmutableVisionData as immutablePolicyDocument, hasImmutableVisionData, recordImmutableVisionData } from './immutable-data.js';
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
const projectionPolicies = new WeakMap();
const vagueActorDocuments = new WeakSet();
const canonicalActorMaps = new WeakMap();
const canonicalTokenMaps = new WeakMap();
const movementPartyRelations = new WeakMap();
const targetedMovementRelations = new WeakMap();
const projectionCollectionProofs = new WeakMap();
const fullProjectionCollectionProofs = new WeakMap();
const uniqueProjectionCollections = new WeakSet();
function registerUniqueProjectionCollection(collection, previous = null) {
  if (!Array.isArray(collection)) return;
  const ids = new Set();
  let sameOrder = Array.isArray(previous) && previous.length === collection.length && uniqueProjectionCollections.has(previous);
  const indices = [];
  for (let index = 0; index < collection.length; index++) {
    const item = collection[index];
    if (!item || !Object.hasOwn(item, 'id')) return;
    const id = String(item.id);
    if (ids.has(id)) return;
    ids.add(id);
    if (sameOrder) {
      if (String(previous[index]?.id) !== id) sameOrder = false;
      else if (previous[index] !== item) indices.push(index);
    }
  }
  uniqueProjectionCollections.add(collection);
  return sameOrder ? Object.freeze({ before: previous, indices: Object.freeze(indices) }) : null;
}
const EMPTY_ACTOR_SELECTION = Object.freeze([]);
const audienceKey = context => JSON.stringify([context.role, context.userId,
  context.user?.ownership || {}, context.user?.placementGrants || {}, context.user?.disabled === true]);

function jsonPermissionValue(value, visiting = new WeakSet()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || visiting.has(value)
    || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  visiting.add(value);
  const valid = Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) =>
    Array.isArray(value) && key === 'length'
      || descriptor.enumerable && Object.hasOwn(descriptor, 'value') && jsonPermissionValue(descriptor.value, visiting));
  visiting.delete(value);
  return valid;
}

function permissionsCacheable(user) {
  if (user == null) return true;
  if (!plainObject(user) || ![Object.prototype, null].includes(Object.getPrototypeOf(user))) return false;
  return ['ownership', 'placementGrants', 'disabled'].every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(user, key);
    if (!descriptor) return !(key in user);
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value') && jsonPermissionValue(descriptor.value);
  });
}

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

function actorMap(world, cacheCanonical = false) {
  const actors = world?.actors || [];
  if (!cacheCanonical || !Array.isArray(actors)) {
    return new Map(actors.map(actor => [String(actor?.id ?? ''), actor]));
  }
  const cached = canonicalActorMaps.get(actors);
  if (cached) return cached;
  const result = new Map(actors.map(actor => [String(actor?.id ?? ''), actor]));
  // Only canonical input arrays use this map. Recipient projections always
  // build their own map, even if a caller freezes the returned projection.
  // Duplicate IDs retain the legacy last-entry precedence without being cached.
  if (result.size === actors.length && jsonPermissionValue(actors) && immutablePolicyDocument(actors)
    && actors.every(actor => typeof actor?.id === 'string' && actor.id.length > 0)) {
    canonicalActorMaps.set(actors, result);
  }
  return result;
}

function canonicalTokenMap(tokens) {
  const cached = canonicalTokenMaps.get(tokens);
  if (cached) return cached;
  const result = new Map(tokens.map(token => [String(token.id), token]));
  // The previous canonical array was qualified as a whole when its audience
  // was projected. Reuse that immutable proof without scanning every document
  // again. Unqualified and duplicate-ID arrays keep the legacy fresh map.
  if (hasImmutableVisionData(tokens) && result.size === tokens.length
    && tokens.every(token => typeof token?.id === 'string' && token.id.length > 0)) {
    canonicalTokenMaps.set(tokens, result);
  }
  return result;
}

function sameOtherFields(before, after, omitted) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (omitted.has(key)) continue;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key) || !Object.is(before[key], after[key])) return false;
  }
  return true;
}

// Only server-accepted pure JSON can enter this proof. A proof records public
// canonical relationships, never a recipient's policy, mask or opaque identity.
// Its predecessor is weak and is replaced, so it cannot retain a World history.
function targetedMovementRelation(beforeState, afterState, isCanonicalData) {
  if (typeof isCanonicalData !== 'function' || !isCanonicalData(beforeState) || !isCanonicalData(afterState)) return null;
  const cached = targetedMovementRelations.get(afterState)?.get(beforeState);
  if (cached) return cached;
  const beforePreferences = beforeState.preferences, afterPreferences = afterState.preferences;
  const beforeWorld = beforePreferences?.worldV2, afterWorld = afterPreferences?.worldV2;
  if (!beforeWorld || !afterWorld
    || !sameOtherFields(beforeState, afterState, new Set(['preferences', 'attackAreas']))
    || !sameOtherFields(beforePreferences, afterPreferences, new Set(['worldV2', 'entitySystem']))
    || !sameOtherFields(beforeWorld, afterWorld, new Set(['scenes', 'updatedAt']))
    || !Array.isArray(beforeWorld.scenes) || !Array.isArray(afterWorld.scenes)
    || beforeWorld.scenes.length !== afterWorld.scenes.length) return null;
  const changes = [], sceneIds = new Set();
  for (let sceneIndex = 0; sceneIndex < afterWorld.scenes.length; sceneIndex++) {
    const before = beforeWorld.scenes[sceneIndex], after = afterWorld.scenes[sceneIndex];
    if (!before || !after || before.id !== after.id || sceneIds.has(after.id)
      || !sameOtherFields(before, after, new Set(['tokens']))
      || !Array.isArray(before.tokens) || !Array.isArray(after.tokens)
      || before.tokens.length !== after.tokens.length) return null;
    sceneIds.add(after.id);
    const tokenIds = new Set();
    for (let index = 0; index < after.tokens.length; index++) {
      const oldToken = before.tokens[index], token = after.tokens[index];
      if (!oldToken || !token || oldToken.id !== token.id || tokenIds.has(token.id)) return null;
      tokenIds.add(token.id);
      if (token === oldToken) continue;
      if (token.placement !== 'map' || oldToken.placement !== 'map'
        || !sameOtherFields(oldToken, token, new Set(['x', 'y', 'elevationMeters', 'movement']))
        || token.light?.enabled === true || oldToken.light?.enabled === true) return null;
      changes.push({ sceneId: String(after.id), index, before: oldToken, after: token });
    }
  }
  const beforeEntity = beforePreferences.entitySystem, afterEntity = afterPreferences.entitySystem;
  if (beforeEntity || afterEntity) {
    if (!beforeEntity || !afterEntity || !sameOtherFields(beforeEntity, afterEntity, new Set(['tokens']))
      || !Array.isArray(beforeEntity.tokens) || !Array.isArray(afterEntity.tokens)
      || beforeEntity.tokens.length !== afterEntity.tokens.length) return null;
    const scene = activeScene(afterWorld), previousScene = activeScene(beforeWorld);
    if (!scene || !previousScene || afterEntity.tokens.length !== scene.tokens.length) return null;
    for (let index = 0; index < afterEntity.tokens.length; index++) {
      const oldToken = beforeEntity.tokens[index], token = afterEntity.tokens[index];
      if (token?.id !== oldToken?.id || token?.id !== scene.tokens[index]?.id) return null;
      if (token !== oldToken && JSON.stringify(token) !== JSON.stringify(scene.tokens[index])) return null;
    }
  }
  // The reducer regenerates this legacy shell even when no anchor moved.
  // A real anchor/Scene change was rejected above and follows full projection.
  if (beforeState.attackAreas !== afterState.attackAreas
    && JSON.stringify(afterState.attackAreas) !== JSON.stringify(activeScene(afterWorld)?.attackAreas || [])) return null;
  const proof = { changes };
  targetedMovementRelations.set(afterState, new WeakMap([[beforeState, proof]]));
  return proof;
}

function selectionKind(token) {
  return !token ? 'hidden' : token.audienceVisibility === 'vague' ? 'vague'
    : token.audienceRestricted === true ? 'restricted'
      : token.audienceVisibility === 'allied-invisible' ? 'private-invisible' : 'private';
}

function targetedMovementProjection(state, rawState, context, previousProjection, previousPolicies, {
  stamp, vision, parties, definitions, actors, metersPerUnit, occluders, sourceOccluders, lights, relation,
}) {
  // trustedProjection is an internal ownership contract: its previous output
  // is server-owned, and opaque callbacks are pure stable lookups in the same
  // session/source scope. They may be fresh closures on every invocation.
  if (!context.trustedProjection || !previousPolicies?.targetedIndex
    || previousPolicies.targetedState !== context.movementCache?.beforeState
    || typeof context.opaqueIdFor !== 'function' || typeof context.lookupOpaqueId !== 'function'
    || previousPolicies.occluders !== occluders || previousPolicies.lights !== lights) return null;
  const proof = relation;
  if (!proof) return null;
  const movedIds = context.movementCache.tokenIds;
  if (!(movedIds instanceof Set) || proof.changes.some(change => !movedIds.has(String(change.after.id))
    || String(change.after.id) === String(context.visionSourceTokenId || ''))) return null;
  const world = rawState.preferences.worldV2, priorWorld = previousProjection.preferences.worldV2;
  const replacements = new Map(), policyEntries = [];
  for (const change of proof.changes) {
    const token = change.after, actor = actors.get(String(token.actorId));
    const record = previousPolicies.targetedIndex.get(change.sceneId)?.get(String(token.id));
    const priorScene = priorWorld.scenes.find(scene => String(scene.id) === change.sceneId);
    if (!actor || !record || !priorScene) return null;
    const prior = record.index < 0 ? null : priorScene.tokens[record.index];
    if (selectionKind(prior) !== record.kind || prior && (String(prior.id) !== record.id || String(prior.actorId) !== record.actorId)) return null;
    const policy = tokenAudiencePolicy(token, actor, context, parties, definitions);
    policyEntries.push([token, { actor, policy }]);
    let selected = null;
    if (policy.visible) {
      const requiresDetection = !policy.authorized && !policy.visibilityOverride;
      const active = change.sceneId === String(world.activeSceneId);
      const level = requiresDetection && active ? detectionLevel(token, vision, metersPerUnit, {
        lineOfSightEnabled: !visionIgnoresOcclusion(vision), occluders, sourceOccluders, lights,
        ambient: activeScene(world)?.settings?.lighting || 'normal',
      }) : 'precise';
      if (!requiresDetection || active && level !== 'none') {
        if (policy.authorized) {
          selected = clone(token);
          if (policy.invisible && selected.audienceVisibility !== 'allied-invisible') selected = { ...selected, audienceVisibility: 'allied-invisible' };
        } else selected = restrictedToken(token, { level, vision, metersPerUnit,
          opaqueIdFor: context.opaqueIdFor, actor: level === 'vague' ? null : actor, definitions });
      }
    }
    if (selectionKind(selected) !== record.kind || selected && (String(selected.id) !== record.id || String(selected.actorId) !== record.actorId)) return null;
    if (selected) {
      let sceneChanges = replacements.get(change.sceneId);
      if (!sceneChanges) { sceneChanges = new Map(); replacements.set(change.sceneId, sceneChanges); }
      sceneChanges.set(record.index, selected);
    }
  }
  const nextWorld = { ...world, actors: priorWorld.actors, journals: priorWorld.journals,
    scenes: priorWorld.scenes.map(scene => {
      const changes = replacements.get(String(scene.id));
      if (!changes) return scene;
      const tokens = scene.tokens.slice();
      for (const [index, token] of changes) tokens[index] = token;
      return { ...scene, tokens };
    }) };
  delete nextWorld.templateLibrary;
  state.preferences.worldV2 = nextWorld;
  state.preferences.entitySystem = { ...state.preferences.entitySystem,
    actors: previousProjection.preferences.entitySystem.actors,
    tokens: [...(activeScene(nextWorld)?.tokens || [])],
    statusDefinitions: previousProjection.preferences.entitySystem.statusDefinitions };
  if (Object.hasOwn(previousProjection.preferences, 'combatSystem')) state.preferences.combatSystem = previousProjection.preferences.combatSystem;
  if (Object.hasOwn(previousProjection.preferences, 'chatSystem')) state.preferences.chatSystem = previousProjection.preferences.chatSystem;
  state.preferences.audienceVision = { schemaVersion: 1, source: vision, partyIds: [...parties] };
  projectionAudiences.set(state.preferences.audienceVision, stamp);
  for (const [token, entry] of policyEntries) previousPolicies.policies.set(token, entry);
  projectionPolicies.set(state.preferences.audienceVision, { ...previousPolicies,
    targetedState: rawState, canonicalState: rawState, partyInputs: { actors: world.actors, scenes: world.scenes } });
  state.markers = previousProjection.markers;
  state.attackAreas = previousProjection.attackAreas;
  state.audienceProjection = true;
  const collections = new Map();
  const rememberCollection = (before, after, indices = []) => {
    if (Array.isArray(before) && Array.isArray(after) && uniqueProjectionCollections.has(before)) {
      uniqueProjectionCollections.add(after);
      collections.set(after, Object.freeze({ before, indices: Object.freeze(indices) }));
    }
  };
  for (const field of ['actors', 'statusDefinitions', 'journals']) {
    if (priorWorld[field] === nextWorld[field]) rememberCollection(priorWorld[field], nextWorld[field]);
  }
  for (let index = 0; index < nextWorld.scenes.length; index++) {
    const before = priorWorld.scenes[index], after = nextWorld.scenes[index];
    if (String(before.id) !== String(after.id)) continue;
    rememberCollection(before.tokens, after.tokens, [...(replacements.get(String(after.id))?.keys() || [])].sort((a, b) => a - b));
    for (const field of ['markers', 'attackAreas', 'sceneEvents', 'occlusionShapes']) {
      if (before[field] === after[field]) rememberCollection(before[field], after[field]);
    }
  }
  // Neither the current projection nor its metadata retains predecessor
  // projections. Only this exact server-owned pair can obtain the proof.
  projectionCollectionProofs.set(state, new WeakMap([[previousProjection, collections]]));
  return state;
}

export function targetedProjectionCollectionChanges(beforeProjection, projection) {
  return projectionCollectionProofs.get(projection)?.get(beforeProjection) || null;
}
export function projectionCollectionChanges(beforeProjection, projection) {
  return targetedProjectionCollectionChanges(beforeProjection, projection)
    || fullProjectionCollectionProofs.get(projection)?.get(beforeProjection) || null;
}

function tokenControlled(token, actor, context) {
  if (context.role === 'gm') return true;
  if (!context.userId) return false;
  if (hasId(token?.controllerUserIds, context.userId)) return true;
  return actor?.type === 'pc' && ownershipLevel(context.user, actor.id) === 'owner';
}

function viewerParties(world, context, actors) {
  const parties = new Set();
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
        && actor?.partyId && !parties.has(String(actor.partyId))
        && (context.role === 'gm' || hasId(token?.controllerUserIds, context.userId))) {
        parties.add(String(actor.partyId));
      }
    }
  }
  return parties;
}

function viewerPartyInputs(world) {
  if (!Array.isArray(world.actors) || !Array.isArray(world.scenes)
    || !immutablePolicyDocument(world.actors) || !immutablePolicyDocument(world.scenes)) return null;
  const actorIds = new Set(), sceneIds = new Set();
  for (const actor of world.actors) {
    if (!actor || actorIds.has(String(actor.id))) return null;
    actorIds.add(String(actor.id));
  }
  for (const scene of world.scenes) {
    if (!scene || sceneIds.has(String(scene.id)) || !Array.isArray(scene.tokens)) return null;
    sceneIds.add(String(scene.id));
    const tokenIds = new Set();
    for (const token of scene.tokens) {
      if (!token || tokenIds.has(String(token.id))) return null;
      tokenIds.add(String(token.id));
    }
  }
  return { actors: world.actors, scenes: world.scenes };
}

function movementPartyInputs(world, previous) {
  if (!previous || world.actors !== previous.actors || !Array.isArray(world.scenes)
    || !Object.isFrozen(world.scenes) || world.scenes.length !== previous.scenes.length) return null;
  if (movementPartyRelations.get(world.scenes)?.has(previous.scenes)) {
    return { actors: world.actors, scenes: world.scenes };
  }
  const knownScenes = hasImmutableVisionData(world.scenes);
  if (!knownScenes && (Object.getPrototypeOf(world.scenes) !== Array.prototype
    || Object.getOwnPropertyNames(world.scenes).length !== world.scenes.length + 1
    || Object.getOwnPropertySymbols(world.scenes).length)) return null;
  for (let sceneIndex = 0; sceneIndex < world.scenes.length; sceneIndex += 1) {
    const descriptor = knownScenes ? null : Object.getOwnPropertyDescriptor(world.scenes, sceneIndex);
    if (!knownScenes && !Object.hasOwn(descriptor || {}, 'value')) return null;
    const scene = knownScenes ? world.scenes[sceneIndex] : descriptor.value, before = previous.scenes[sceneIndex];
    if (scene === before) continue;
    if (!scene || !Object.isFrozen(scene) || ![Object.prototype, null].includes(Object.getPrototypeOf(scene))) return null;
    const fields = Object.getOwnPropertyDescriptors(scene);
    if (Object.keys(fields).length !== Object.getOwnPropertyNames(before).length) return null;
    // Accepted coordinate-only moves replace the Token array. Any other Scene
    // change follows the full party derivation, including changed collection order.
    for (const [key, descriptor] of Object.entries(fields)) {
      if (!Object.hasOwn(descriptor, 'value') || !Object.hasOwn(before, key)
        || (key !== 'tokens' && descriptor.value !== before[key])) return null;
    }
    const tokens = fields.tokens?.value;
    if (!Array.isArray(tokens) || !Object.isFrozen(tokens) || tokens.length !== before.tokens.length) return null;
    const knownTokens = hasImmutableVisionData(tokens);
    if (!knownTokens && (Object.getPrototypeOf(tokens) !== Array.prototype
      || Object.getOwnPropertyNames(tokens).length !== tokens.length + 1 || Object.getOwnPropertySymbols(tokens).length)) return null;
    for (let index = 0; index < tokens.length; index += 1) {
      const descriptor = knownTokens ? null : Object.getOwnPropertyDescriptor(tokens, index);
      if (!knownTokens && !Object.hasOwn(descriptor || {}, 'value')) return null;
      const token = knownTokens ? tokens[index] : descriptor.value, oldToken = before.tokens[index];
      if (token === oldToken) continue;
      if (!immutablePolicyDocument(token) || token.id !== oldToken.id || token.actorId !== oldToken.actorId
        || token.controllerUserIds !== oldToken.controllerUserIds) return null;
    }
    // All other fields are the same previously verified immutable documents;
    // every new Token has also been checked, proving the replacement is immutable.
    if (!immutablePolicyDocument(tokens) || !recordImmutableVisionData(scene, fields)) return null;
  }
  if (!immutablePolicyDocument(world.scenes)) return null;
  // This proof concerns only immutable collection structure, never a user's
  // party membership or projection. Keep one predecessor per live result,
  // with both arrays weakly keyed, so old Worlds cannot form a retained chain.
  movementPartyRelations.set(world.scenes, new WeakMap([[previous.scenes, true]]));
  return { actors: world.actors, scenes: world.scenes };
}

function explicitVisibilityGranted(entity, context) {
  if (String(entity?.visibility?.mode || 'public') === 'gm') return false;
  return hasId(entity?.visibility?.userIds, context.userId);
}

function visibleByPolicy(entity, actor, context, parties, controlled, visibilityOverride = explicitVisibilityGranted(entity, context)) {
  const visibility = plainObject(entity?.visibility) ? entity.visibility : { mode: 'public', userIds: [] };
  if (visibility.mode === 'gm') return false;
  if (controlled) return true;
  if (visibilityOverride) return true;
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

function tokenAudiencePolicy(token, actor, context, parties, definitions) {
  const controlled = tokenControlled(token, actor, context);
  const visibilityOverride = explicitVisibilityGranted(token, context);
  if (!visibleByPolicy(token, actor, context, parties, controlled, visibilityOverride)) return { visible: false };
  const authorized = authorizedForPrivateData(actor, parties, controlled);
  const invisible = tokenInvisible(token, actor, definitions);
  return { visible: !invisible || authorized || visibilityOverride, authorized, visibilityOverride, invisible };
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
  lineOfSightCache = null,
} = {}) {
  if (!vision || token?.placement !== 'map') return 'none';
  return perceptionLevelAtPoint({
    vision, target: token, ambient, lights, occluders, sourceOccluders, metersPerUnit, lineOfSightEnabled, lineOfSightCache,
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
  const actors = actorMap(world, true);
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
  const stamp = audienceKey(context);
  const requestedCache = context.movementCache;
  const requestedPolicies = requestedCache && projectionPolicies.get(requestedCache.previousProjection?.preferences?.audienceVision);
  const movementCache = requestedCache && permissionsCacheable(context.user)
    && projectionAudiences.get(requestedCache.previousProjection?.preferences?.audienceVision) === stamp
    // A registered targeted result belongs to one canonical predecessor.
    // Reject the whole cache when an older projection is paired with a newer
    // World, so the full fallback cannot mistakenly reuse its historical Fog.
    && (!requestedPolicies?.targetedIndex || requestedPolicies.targetedState === requestedCache.beforeState)
    && (!requestedPolicies?.canonicalState || requestedPolicies.canonicalState === requestedCache.beforeState)
    ? requestedCache : null;
  const previousWorld = movementCache?.beforeState?.preferences?.worldV2;
  const previousProjection = movementCache?.previousProjection;
  const previousPolicies = movementCache && projectionPolicies.get(previousProjection?.preferences?.audienceVision);
  const sourceIdentityUnchanged = previousPolicies
    && previousPolicies.sourceTokenId === String(context.visionSourceTokenId || '');
  const rawWorld = rawState.preferences.worldV2;
  // A verified coordinate-only relation also proves Actor/controller/Scene
  // party inputs unchanged. Reuse that shared proof before preparing full
  // recipient maps, instead of scanning the same Token containers again.
  const targetedRelation = context.trustedProjection && sourceIdentityUnchanged && previousPolicies?.targetedIndex
    && previousPolicies.targetedState === movementCache?.beforeState
    ? targetedMovementRelation(movementCache.beforeState, rawState, context.isCanonicalData) : null;
  const partyInputs = targetedRelation ? { actors: rawWorld.actors, scenes: rawWorld.scenes }
    : sourceIdentityUnchanged ? movementPartyInputs(rawWorld, previousPolicies.partyInputs) : null;
  const parties = partyInputs ? new Set(previousPolicies.partyIds) : viewerParties(world, context, actors);
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
  const sourceUnchanged = movementCache && JSON.stringify(previousProjection?.preferences?.audienceVision?.source || null)
    === JSON.stringify(vision);
  const mapMetricsUnchanged = previousPolicies?.metersPerUnit === metersPerUnit;
  const mapPackageUnchanged = previousPolicies?.mapPackage === context.mapPackage;
  if (!context.forceFreshDetection && targetedRelation && sourceUnchanged && mapMetricsUnchanged && mapPackageUnchanged) {
    // currentVision still invokes the Ruleset description hook on every call.
    // Only an unchanged result and the complete canonical relation can avoid
    // full projection preparation; category changes retain the original path.
    const targeted = targetedMovementProjection(state, rawState, context, previousProjection, previousPolicies, {
      stamp, vision, parties, definitions, actors, metersPerUnit, occluders, sourceOccluders, lights,
      relation: targetedRelation,
    });
    if (targeted) return targeted;
  }
  world.journals = (world.journals || [])
    .filter(entry => journalVisibleToAudience(entry, {
      role: context.role, userId: context.userId, partyIds: [...parties],
    }))
    .map(entry => structuredClone(entry));
  const previousActors = actorMap(previousWorld, true);
  const projectedActors = actorMap(previousProjection?.preferences?.worldV2);
  const previousScenes = new Map((previousWorld?.scenes || []).map(scene => [String(scene.id), scene]));
  const projectedScenes = new Map((previousProjection?.preferences?.worldV2?.scenes || []).map(scene => [String(scene.id), scene]));
  const partiesUnchanged = previousPolicies && JSON.stringify([...previousPolicies.partyIds].sort())
    === JSON.stringify([...parties].sort());
  const definitionsUnchanged = movementCache && previousWorld?.statusDefinitions === rawState.preferences.worldV2.statusDefinitions;
  const reusePolicies = Boolean(sourceIdentityUnchanged && partiesUnchanged && definitionsUnchanged);
  const policies = new WeakMap();
  const immutableActors = hasImmutableVisionData(rawWorld.actors);
  const oldActive = previousScenes.get(String(world.activeSceneId));
  const rawActive = activeScene(rawState.preferences.worldV2);
  const geometryUnchanged = oldActive && oldActive.featureStates === rawActive?.featureStates
    && oldActive.sceneEvents === rawActive?.sceneEvents && oldActive.occlusionShapes === rawActive?.occlusionShapes
    && oldActive.settings === rawActive?.settings && oldActive.mapPackage === rawActive?.mapPackage;
  const movedIds = movementCache?.tokenIds || new Set();
  const lightMoved = movementCache && !targetedRelation && (rawActive?.tokens || []).some(token => movedIds.has(String(token.id))
    && (token.light?.enabled === true || oldActive?.tokens?.find(item => String(item.id) === String(token.id))?.light?.enabled === true));
  const reuseDetection = Boolean(!context.forceFreshDetection && sourceUnchanged && partiesUnchanged && definitionsUnchanged && geometryUnchanged
    && mapMetricsUnchanged && mapPackageUnchanged && !lightMoved);
  const canonicalProjection = context.trustedProjection && typeof context.isCanonicalData === 'function'
    && context.isCanonicalData(rawState);
  const targetedIndex = vision && canonicalProjection ? new Map() : null;
  // A light move changes illumination, not the rays from a stationary viewer.
  // Keep at most two positions for this recipient and source. Geometry, map
  // scale and non-position source descriptors must match; host exemptions
  // also need the exact derived occluder collection for that position.
  const rayDescriptor = JSON.stringify({ ...vision, x: undefined, y: undefined });
  const previousRayContexts = targetedIndex && movementCache && sourceIdentityUnchanged
    && mapMetricsUnchanged && mapPackageUnchanged && previousPolicies.occluders === occluders
    && previousPolicies.rayDescriptor === rayDescriptor ? previousPolicies.rayContexts || [] : [];
  const rayContext = targetedIndex ? previousRayContexts.find(entry => entry.occluders === sourceOccluders
    && Object.is(entry.x, vision.x) && Object.is(entry.y, vision.y))
    || { x: vision.x, y: vision.y, occluders: sourceOccluders, cache: { entries: new WeakMap(), count: 0 } } : null;
  const rayContexts = rayContext ? [rayContext, ...previousRayContexts.filter(entry => entry !== rayContext)].slice(0, 2) : [];
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
    const previousTokens = canonicalTokenMap(previousScene?.tokens || []);
    const projectedSceneTokens = projectedScene?.tokens || [];
    const projectedTokens = new Map(projectedSceneTokens.map(token => [String(token.id), token]));
    const hasVaguePrior = Boolean(sourceIdentityUnchanged && projectedSceneTokens.some(token => token.audienceVisibility === 'vague'));
    const sceneVisibleTokenIds = new Set();
    const projectedSceneTokensNext = [];
    const sceneSelectionIndex = targetedIndex ? new Map() : null;
    if (targetedIndex) targetedIndex.set(String(scene.id), sceneSelectionIndex);
    const rememberSelection = (rawToken, token = null) => {
      if (sceneSelectionIndex) sceneSelectionIndex.set(String(rawToken.id), {
        kind: selectionKind(token), index: token ? projectedSceneTokensNext.length : -1,
        id: token ? String(token.id) : null, actorId: token ? String(token.actorId) : null,
      });
    };
    const immutableScenePolicies = immutableActors && hasImmutableVisionData(scene.tokens);
    for (const rawToken of scene.tokens || []) {
      const actor = actors.get(String(rawToken.actorId));
      const unchanged = movementCache && actor && previousTokens.get(String(rawToken.id)) === rawToken
        && previousActors.get(String(rawToken.actorId)) === actor && definitionsUnchanged && partiesUnchanged;
      const canReuseVaguePrior = hasVaguePrior && unchanged && !movedIds.has(String(rawToken.id));
      const prior = movementCache ? projectedTokens.get(String(rawToken.id))
        || (canReuseVaguePrior ? projectedTokens.get((context.lookupOpaqueId || context.opaqueIdFor)('token', rawToken.id)) : null) : null;
      if (!actor) { rememberSelection(rawToken); continue; }
      // Only the immediately preceding projection supplies policy decisions,
      // and its audience/source/party/definition scope has already been checked.
      // Frozen canonical documents cannot change policy between coordinates.
      const policyCacheable = immutableScenePolicies
        || immutablePolicyDocument(rawToken) && immutablePolicyDocument(actor);
      const oldPolicy = reusePolicies && policyCacheable ? previousPolicies.policies.get(rawToken) : null;
      const reusablePolicy = oldPolicy?.actor === actor ? oldPolicy : null;
      const policy = reusablePolicy ? reusablePolicy.policy
        : tokenAudiencePolicy(rawToken, actor, context, parties, definitions);
      if (policyCacheable) policies.set(rawToken, reusablePolicy || { actor, policy });
      if (!policy.visible) { rememberSelection(rawToken); continue; }
      if (reuseDetection && unchanged && !movedIds.has(String(rawToken.id))) {
        // The session, source, geometry, lights, permissions, party membership,
        // definitions and both canonical documents are unchanged. Reusing the
        // already masked Token also reuses the policy decision; no private
        // result is shared with another session or retained after invalidation.
        if (!prior) { rememberSelection(rawToken); continue; }
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
        rememberSelection(rawToken, prior);
        projectedSceneTokensNext.push(prior);
        continue;
      }
      const { authorized, visibilityOverride, invisible } = policy;
      const hostile = !authorized;
      const requiresDetection = hostile && !visibilityOverride;
      const level = requiresDetection && isActive
        ? reuseDetection && unchanged && !movedIds.has(String(rawToken.id))
          ? prior ? prior.audienceVisibility === 'vague' ? 'vague' : 'precise' : 'none'
          : detectionLevel(rawToken, vision, metersPerUnit, {
          lineOfSightEnabled: lineOfSightEnabled && !visionIgnoresOcclusion(vision), occluders, sourceOccluders, lights, ambient: currentScene?.settings?.lighting || 'normal',
          lineOfSightCache: policyCacheable ? rayContext?.cache : null,
        })
        : 'precise';
      if (requiresDetection && (!isActive || level === 'none')) { rememberSelection(rawToken); continue; }
      let token;
      if (authorized) {
        token = unchanged && prior && prior.audienceRestricted !== true ? prior : clone(rawToken);
        visibleTokenIds.add(String(token.id));
        sceneVisibleTokenIds.add(String(token.id));
        referencedActorIds.add(String(actor.id));
        privateActorIds.add(String(actor.id));
        if (invisible && token.audienceVisibility !== 'allied-invisible') {
          token = { ...token, audienceVisibility: 'allied-invisible' };
        }
      } else if (level === 'vague') {
        token = unchanged && sourceIdentityUnchanged && mapMetricsUnchanged && prior?.audienceVisibility === 'vague'
          && (sourceUnchanged || policyCacheable)
          ? sourceUnchanged ? prior : { ...prior,
            approximateDirection: Math.atan2(Number(rawToken.y) - vision.y, Number(rawToken.x) - vision.x) }
          : restrictedToken(rawToken, { level, vision, metersPerUnit, opaqueIdFor: context.opaqueIdFor });
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
      rememberSelection(rawToken, token);
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
      return EMPTY_ACTOR_SELECTION;
    }
    const prior = movementCache && previousActors.get(actorId) === actor ? projectedActors.get(actorId) : null;
    // Ordinary documents append directly; Array documents must remain nested.
    if (privateActorIds.has(actorId) || owned || observed || allied) {
      const selected = prior && prior.audienceRestricted !== true ? prior : clone(actor);
      return Array.isArray(selected) ? [selected] : selected;
    }
    restrictedActorIds.add(actorId);
    const selected = prior?.audienceRestricted === true ? prior : restrictedActor(actor);
    return Array.isArray(selected) ? [selected] : selected;
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
  projectionPolicies.set(state.preferences.audienceVision, {
    sourceTokenId: String(context.visionSourceTokenId || ''), metersPerUnit,
    mapPackage: context.mapPackage, policies, partyIds: Object.freeze([...parties]),
    partyInputs: partyInputs || viewerPartyInputs(rawWorld),
    targetedIndex, targetedState: targetedIndex ? rawState : null,
    canonicalState: canonicalProjection ? rawState : null, occluders, lights, rayDescriptor, rayContexts,
  });
  if (canonicalProjection) {
    // Full projection already checks every selected ID. Use that same pass
    // to prove leaf ordering, instead of rebuilding ID maps in Document diff.
    // Membership/reordering/collisions retain the complete original fallback.
    const collections = new Map();
    const remember = (after, before) => {
      const proof = registerUniqueProjectionCollection(after, before);
      if (proof) collections.set(after, proof);
    };
    for (const field of ['actors', 'statusDefinitions', 'journals']) remember(world[field], previousProjection?.preferences?.worldV2?.[field]);
    for (let index = 0; index < world.scenes.length; index++) {
      const scene = world.scenes[index], oldScene = previousProjection?.preferences?.worldV2?.scenes?.[index];
      for (const field of ['tokens', 'markers', 'attackAreas', 'sceneEvents', 'occlusionShapes']) {
        remember(scene[field], String(oldScene?.id) === String(scene.id) ? oldScene[field] : null);
      }
    }
    if (movementCache && collections.size) fullProjectionCollectionProofs.set(state, new WeakMap([[previousProjection, collections]]));
  }
  state.markers = clone(active?.markers || []);
  state.attackAreas = clone(active?.attackAreas || []);
  state.audienceProjection = true;
  return state;
}

// This proves only the private audience scope, never a canonical predecessor.
// A source-free public append may retain older optimization metadata, but the
// server must still prove that every non-chat canonical field is unchanged.
export function matchesSourceFreeProjectionScope(previousProjection, rawContext = {}) {
  const audience = previousProjection?.preferences?.audienceVision;
  const metadata = projectionPolicies.get(audience);
  const context = { ...rawContext, userId: rawContext.userId == null ? '' : String(rawContext.userId) };
  return context.trustedProjection === true && audience?.source === null
    && !context.visionSourceTokenId && Boolean(metadata?.canonicalState)
    && metadata.sourceTokenId === '' && metadata.targetedIndex === null
    && permissionsCacheable(context.user)
    && projectionAudiences.get(audience) === audienceKey(context)
    && metadata.mapPackage === context.mapPackage
    && metadata.metersPerUnit === Math.max(0.000001, Number(context.mapMetrics?.metersPerUnit) || 1)
    && Array.isArray(audience.partyIds) && audience.partyIds.length === metadata.partyIds.length
    && audience.partyIds.every((id, index) => id === metadata.partyIds[index]);
}

// Only a proved public append can carry private perception metadata forward.
// Chat trimming, protected entity data and any non-chat mutation retain full
// projection. The new audience key never changes the predecessor's metadata.
export function advancePublicChatProjectionMetadata(previousProjection, projection, beforeState, afterState, rawContext = {}) {
  const audience = projection?.preferences?.audienceVision;
  const previousAudience = previousProjection?.preferences?.audienceVision;
  const metadata = projectionPolicies.get(previousAudience);
  const context = { ...rawContext, userId: rawContext.userId == null ? '' : String(rawContext.userId) };
  const stamp = audienceKey(context), canonical = context.isCanonicalData;
  const metersPerUnit = Math.max(0.000001, Number(context.mapMetrics?.metersPerUnit) || 1);
  if (!context.trustedProjection || !metadata || !audience || projection === previousProjection || audience !== previousAudience
    || !permissionsCacheable(context.user) || projectionAudiences.get(previousAudience) !== stamp
    || metadata.canonicalState !== beforeState || metadata.targetedIndex && metadata.targetedState !== beforeState
    || metadata.sourceTokenId !== String(context.visionSourceTokenId || '')
    || metadata.mapPackage !== context.mapPackage || metadata.metersPerUnit !== metersPerUnit
    || typeof canonical !== 'function' || !canonical(beforeState) || !canonical(afterState)) return null;
  const beforeWorld = beforeState.preferences?.worldV2, afterWorld = afterState.preferences?.worldV2;
  const beforeEntity = beforeState.preferences?.entitySystem, afterEntity = afterState.preferences?.entitySystem;
  if (!beforeWorld || !afterWorld || metadata.partyInputs?.actors !== beforeWorld.actors || metadata.partyInputs?.scenes !== beforeWorld.scenes
    || !sameOtherFields(beforeState, afterState, new Set(['preferences']))
    || !sameOtherFields(beforeState.preferences, afterState.preferences, new Set(['worldV2', 'chatSystem', 'entitySystem']))
    || !sameOtherFields(beforeWorld, afterWorld, new Set(['updatedAt']))
    || !plainObject(beforeEntity) || !plainObject(afterEntity) || !sameOtherFields(beforeEntity, afterEntity, new Set())
    || !Array.isArray(audience.partyIds) || audience.partyIds.length !== metadata.partyIds.length
    || audience.partyIds.some((partyId, index) => partyId !== metadata.partyIds[index])) return null;
  // Re-run the descriptor hook: a time/user-dependent hook is not proved
  // invariant merely because the canonical Actor and Token references match.
  const vision = currentVision(afterWorld, context, actorMap(afterWorld, true));
  if (JSON.stringify(vision) !== JSON.stringify(previousAudience.source || null)) return null;
  const beforeChat = beforeState.preferences.chatSystem, afterChat = afterState.preferences.chatSystem;
  const beforeProjectedChat = previousProjection.preferences.chatSystem, projectedChat = projection.preferences.chatSystem;
  if (![beforeChat, afterChat, beforeProjectedChat, projectedChat].every(plainObject)
    || !sameOtherFields(beforeChat, afterChat, new Set(['messages']))
    || !sameOtherFields(beforeProjectedChat, projectedChat, new Set(['messages']))) return null;
  const oldMessages = beforeChat.messages, newMessages = afterChat.messages;
  const oldSelected = beforeProjectedChat.messages, selected = projectedChat.messages;
  if (![oldMessages, newMessages, oldSelected, selected].every(Array.isArray)
    || newMessages.length <= oldMessages.length || newMessages.length > 500
    || oldMessages.some((message, index) => newMessages[index] !== message)) return null;
  const appended = newMessages.slice(oldMessages.length), ids = new Set();
  for (const message of newMessages) {
    if (!message || !Object.hasOwn(message, 'id') || ids.has(String(message.id))) return null;
    ids.add(String(message.id));
  }
  if (appended.some(message => message.data != null) || selected.length !== oldSelected.length + appended.length
    || oldSelected.some((message, index) => selected[index] !== message)
    || appended.some((message, index) => !jsonPermissionValue(selected[oldSelected.length + index])
      || JSON.stringify(selected[oldSelected.length + index]) !== JSON.stringify(message))) return null;
  const oldWorld = previousProjection.preferences.worldV2, world = projection.preferences.worldV2;
  if (!oldWorld || !world || !Array.isArray(oldWorld.actors) || !Array.isArray(world.actors)
    || !Array.isArray(oldWorld.scenes) || !Array.isArray(world.scenes)
    || !sameOtherFields(previousProjection, projection, new Set(['preferences']))
    || !sameOtherFields(previousProjection.preferences, projection.preferences, new Set(['worldV2', 'chatSystem', 'entitySystem']))
    || !sameOtherFields(oldWorld, world, new Set(['actors', 'scenes', 'updatedAt'])) || world.updatedAt !== afterWorld.updatedAt
    || oldWorld.actors.length !== world.actors.length || oldWorld.actors.some((actor, index) => actor !== world.actors[index])
    || oldWorld.scenes.length !== world.scenes.length || oldWorld.scenes.some((scene, index) => scene !== world.scenes[index])
    || !plainObject(previousProjection.preferences.entitySystem) || !plainObject(projection.preferences.entitySystem)
    || !sameOtherFields(previousProjection.preferences.entitySystem, projection.preferences.entitySystem, new Set())) return null;
  const next = { ...projection, preferences: { ...projection.preferences, audienceVision: { ...audience } } };
  projectionAudiences.set(next.preferences.audienceVision, stamp);
  projectionPolicies.set(next.preferences.audienceVision, { ...metadata,
    targetedState: metadata.targetedIndex ? afterState : null, canonicalState: afterState,
    partyInputs: { actors: afterWorld.actors, scenes: afterWorld.scenes } });
  const collections = new Map();
  const remember = (after, before) => {
    const proof = registerUniqueProjectionCollection(after, before);
    if (proof) collections.set(after, proof);
  };
  for (const field of ['actors', 'statusDefinitions', 'journals']) remember(world[field], oldWorld[field]);
  for (let index = 0; index < world.scenes.length; index++) {
    for (const field of ['tokens', 'markers', 'attackAreas', 'sceneEvents', 'occlusionShapes']) {
      remember(world.scenes[index][field], oldWorld.scenes[index][field]);
    }
  }
  remember(selected, oldSelected);
  fullProjectionCollectionProofs.set(next, new WeakMap([[previousProjection, collections]]));
  return next;
}

// Fog commits replace canonical containers without changing perception inputs.
// Register the new recipient projection under a new key; never update the
// predecessor's metadata or infer trust merely from a frozen object.
export function advanceFogProjectionMetadata(previousProjection, projection, beforeState, afterState, rawContext = {}) {
  const audience = projection?.preferences?.audienceVision;
  if (!audience) return projection;
  const next = { ...projection, preferences: { ...projection.preferences, audienceVision: { ...audience } } };
  const previousAudience = previousProjection?.preferences?.audienceVision;
  const metadata = projectionPolicies.get(previousAudience);
  const context = { ...rawContext, userId: rawContext.userId == null ? '' : String(rawContext.userId) };
  const stamp = audienceKey(context);
  const canonical = context.isCanonicalData;
  const metersPerUnit = Math.max(0.000001, Number(context.mapMetrics?.metersPerUnit) || 1);
  if (!context.trustedProjection || !metadata || projection === previousProjection || audience !== previousAudience
    || !permissionsCacheable(context.user) || projectionAudiences.get(previousAudience) !== stamp
    || metadata.sourceTokenId !== String(context.visionSourceTokenId || '')
    || metadata.mapPackage !== context.mapPackage || metadata.metersPerUnit !== metersPerUnit
    || typeof canonical !== 'function' || !canonical(beforeState) || !canonical(afterState)) return next;
  const beforeWorld = beforeState.preferences?.worldV2, afterWorld = afterState.preferences?.worldV2;
  if (!beforeWorld || !afterWorld || metadata.partyInputs?.actors !== beforeWorld.actors
    || metadata.partyInputs?.scenes !== beforeWorld.scenes
    || metadata.targetedIndex && metadata.targetedState !== beforeState
    || metadata.canonicalState && metadata.canonicalState !== beforeState
    || !sameOtherFields(beforeState, afterState, new Set(['preferences']))
    || !sameOtherFields(beforeState.preferences, afterState.preferences, new Set(['worldV2']))
    || !sameOtherFields(beforeWorld, afterWorld, new Set(['scenes', 'updatedAt']))
    || !Array.isArray(beforeWorld.scenes) || !Array.isArray(afterWorld.scenes)
    || beforeWorld.scenes.length !== afterWorld.scenes.length
    || !Array.isArray(audience.partyIds) || audience.partyIds.length !== metadata.partyIds.length
    || audience.partyIds.some((partyId, index) => partyId !== metadata.partyIds[index])) return next;
  for (let index = 0; index < afterWorld.scenes.length; index++) {
    const beforeScene = beforeWorld.scenes[index], afterScene = afterWorld.scenes[index];
    if (!sameOtherFields(beforeScene, afterScene, new Set(['fog']))
      || !plainObject(beforeScene.fog) || !plainObject(afterScene.fog)
      || !sameOtherFields(beforeScene.fog, afterScene.fog, new Set(['exploredByParty']))) return next;
  }
  // The server's Fog shell copies Actor/Scene containers, but every document
  // and every non-Fog recipient branch must remain the same private result.
  const beforeProjectedWorld = previousProjection.preferences.worldV2, projectedWorld = projection.preferences.worldV2;
  if (!beforeProjectedWorld || !projectedWorld
    || !Array.isArray(beforeProjectedWorld.actors) || !Array.isArray(projectedWorld.actors)
    || !Array.isArray(beforeProjectedWorld.scenes) || !Array.isArray(projectedWorld.scenes)
    || !plainObject(previousProjection.preferences.entitySystem) || !plainObject(projection.preferences.entitySystem)
    || !sameOtherFields(previousProjection, projection, new Set(['preferences']))
    || !sameOtherFields(previousProjection.preferences, projection.preferences, new Set(['worldV2', 'entitySystem']))
    || !sameOtherFields(beforeProjectedWorld, projectedWorld, new Set(['actors', 'scenes', 'updatedAt']))
    || beforeProjectedWorld.actors.length !== projectedWorld.actors.length
    || beforeProjectedWorld.actors.some((actor, index) => actor !== projectedWorld.actors[index])
    || beforeProjectedWorld.scenes.length !== projectedWorld.scenes.length
    || !sameOtherFields(previousProjection.preferences.entitySystem, projection.preferences.entitySystem, new Set())) return next;
  for (let index = 0; index < projectedWorld.scenes.length; index++) {
    const previousScene = beforeProjectedWorld.scenes[index], scene = projectedWorld.scenes[index];
    const canonicalScene = afterWorld.scenes[index];
    if (!sameOtherFields(previousScene, scene, new Set(['fog']))
      || !canonicalScene || !Object.is(scene.id, canonicalScene.id)
      || !plainObject(previousScene.fog) || !plainObject(scene.fog)
      || !sameOtherFields(previousScene.fog, scene.fog, new Set(['exploredByParty']))) return next;
    const projectedParties = scene.fog.exploredByParty, canonicalParties = canonicalScene.fog.exploredByParty;
    if (!plainObject(projectedParties) || !plainObject(canonicalParties)
      || Object.keys(projectedParties).some(partyId => !metadata.partyIds.includes(partyId)
        || projectedParties[partyId] !== canonicalParties[partyId])
      || metadata.partyIds.some(partyId => canonicalParties[partyId]
        && (!Object.hasOwn(projectedParties, partyId) || projectedParties[partyId] !== canonicalParties[partyId]))) return next;
  }
  projectionAudiences.set(next.preferences.audienceVision, stamp);
  projectionPolicies.set(next.preferences.audienceVision, { ...metadata,
    targetedState: metadata.targetedIndex ? afterState : null,
    canonicalState: metadata.canonicalState ? afterState : null,
    partyInputs: { actors: afterWorld.actors, scenes: afterWorld.scenes } });
  return next;
}

export function canUserControlToken(state, tokenId, { user, userId } = {}) {
  const world = state?.preferences?.worldV2;
  const scene = activeScene(world);
  const token = scene?.tokens?.find(item => String(item?.id ?? '') === String(tokenId));
  const actor = token ? actorMap(world).get(String(token.actorId)) : null;
  return Boolean(token && actor && tokenControlled(token, actor, { user, userId: String(userId ?? '') }));
}
