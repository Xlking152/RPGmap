import {
  applyFeatureStateMergePatch,
  assertFeatureStatePatch,
  isPlainObject as isFeatureStateObject,
  migrateLegacySceneFeatureStates,
  stripLegacyFeatureStateProjection,
} from './feature-states.js';
import { normalizeActorDocument, performActorOperation } from '../actor/model.js';
import { normalizeActorPublicProfile } from '../actor/public-profile.js';
import { actorUsesIndependentInstances, normalizeActorClassification } from '../actor/classification.js';
import {
  createActorDelta,
  createInitialActorDelta,
  mergeActorDelta,
  normalizeActorDelta,
  rebaseActorDelta,
} from '../token/actor.js';
import { normalizeTokenAccess } from '../token/access.js';
import { normalizeSceneToken } from '../token/model.js';
import {
  exploreFogCircle,
  exploreFogSweep,
  hideFogCircle,
  normalizeFogState,
  resetFogParty,
} from '../vision/fog.js';
import { migrateWorldSchema3State } from './migration.js';
import { normalizeLightweightMarker } from '../marker/model.js';
import { advanceStatusDurations, STATUS_SCHEMA_VERSION } from '../status/model.js';

export {
  assertFeatureStatePatch,
  isFeatureStateObject as isPlainObject,
  migrateLegacySceneFeatureStates,
  stripLegacyFeatureStateProjection,
  migrateWorldSchema3State,
};

export const WORLD_OPERATION_SCHEMA_VERSION = 2;
export const WORLD_OPERATION_BATCH_LIMIT = 64;
export const WORLD_OPERATION_CACHE_LIMIT = 512;

const OPERATION_TYPES = new Set([
  'world.rename',
  'actor.upsert',
  'actor.publicProfile.update',
  'actor.delete',
  'actor.runtime.perform',
  'actor.instances.detach',
  'token.create',
  'token.upsert',
  'token.move',
  'token.actorDelta.replace',
  'token.delete',
  'token.access.patch',
  'marker.upsert',
  'marker.move',
  'marker.delete',
  'scene.upsert',
  'scene.activate',
  'scene.delete',
  'scene.content.replace',
  'scene.featureState.patch',
  'scene.fog.explore',
  'scene.fog.reset',
  'scene.fog.hide',
  'combat.replace',
  'combat.advance',
  'chat.append',
  'chat.clear',
  'status.apply',
  'status.remove',
  'status.setStacks',
  'status.definition.upsert',
  'status.definition.delete',
  'status.definition.import',
  'status.batch',
]);

const STATUS_TYPES = new Set([...OPERATION_TYPES].filter(type => type.startsWith('status.')));
const GRANULAR_OPERATION_TYPES = new Set([
  'token.move', 'scene.featureState.patch', 'scene.activate',
  'scene.fog.explore', 'scene.fog.hide', 'scene.fog.reset',
  'status.apply', 'status.remove', 'status.setStacks', 'status.batch',
  'status.definition.upsert', 'status.definition.delete', 'status.definition.import',
  'chat.append', 'chat.clear',
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function object(value, label) {
  if (!plainObject(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function fail(message, code = 'invalid_world_operation') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function identifier(value, label) {
  const result = String(value ?? '').trim();
  if (!result) fail(`${label} requires an id`);
  if (result.length > 160) fail(`${label} id is too long`, 'world_operation_limit');
  return result;
}

function finite(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) fail(`${label} must be finite`);
  return result;
}

function same(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function mapById(items = []) {
  return new Map((Array.isArray(items) ? items : [])
    .filter(item => item?.id != null)
    .map(item => [String(item.id), item]));
}

function worldFromState(state) {
  const world = state?.preferences?.worldV2;
  if (!plainObject(world) || ![2, 3].includes(Number(world.schemaVersion))) {
    fail('World operation requires initialized World V2', 'world_v2_required');
  }
  return world;
}

function cloneOperationInput(rawState, operations) {
  const copyOnWriteTypes = new Set(['token.move', 'scene.featureState.patch', 'scene.activate']);
  if (operations.some(operation => !copyOnWriteTypes.has(operation.type))) return clone(rawState);
  const source = object(rawState, 'state');
  const preferences = { ...object(source.preferences, 'state.preferences') };
  const rawWorld = object(preferences.worldV2, 'state.preferences.worldV2');
  const world = { ...rawWorld, scenes: [...array(rawWorld.scenes, 'world.scenes')] };
  const state = { ...source, preferences };
  preferences.worldV2 = world;
  preferences.entitySystem = plainObject(preferences.entitySystem)
    ? { ...preferences.entitySystem }
    : preferences.entitySystem;
  const sceneChanges = new Map();
  for (const operation of operations) {
    if (operation.type === 'scene.activate') continue;
    const sceneId = String(operation.payload?.sceneId || world.activeSceneId || '');
    const entry = sceneChanges.get(sceneId) || { tokens: false, featureStates: false };
    if (operation.type === 'token.move') entry.tokens = true;
    if (operation.type === 'scene.featureState.patch') entry.featureStates = true;
    sceneChanges.set(sceneId, entry);
  }
  for (const [sceneId, changes] of sceneChanges) {
    const index = world.scenes.findIndex(scene => String(scene?.id ?? '') === sceneId);
    if (index < 0) continue;
    const scene = { ...world.scenes[index] };
    if (changes.tokens) scene.tokens = [...(scene.tokens || [])];
    if (changes.featureStates) scene.featureStates = { ...(scene.featureStates || {}) };
    world.scenes[index] = scene;
  }
  if ([...sceneChanges.values()].some(change => change.tokens)
    && Array.isArray(preferences.entitySystem?.tokens)) {
    preferences.entitySystem.tokens = [...preferences.entitySystem.tokens];
  }
  if ([...sceneChanges.values()].some(change => change.featureStates)) {
    preferences.featureStates = { ...(preferences.featureStates || {}) };
  }
  return state;
}

function activeScene(world) {
  const scene = (Array.isArray(world.scenes) ? world.scenes : [])
    .find(item => String(item?.id ?? '') === String(world.activeSceneId ?? ''));
  if (!scene) fail(`World has no active Scene: ${world.activeSceneId || '(missing)'}`, 'invalid_reference');
  return scene;
}

function sceneById(world, sceneId) {
  const targetId = sceneId == null ? String(world.activeSceneId ?? '') : identifier(sceneId, 'sceneId');
  const scene = (Array.isArray(world.scenes) ? world.scenes : [])
    .find(item => String(item?.id ?? '') === targetId);
  if (!scene) fail(`Unknown Scene: ${targetId}`, 'scene_not_found');
  return scene;
}

function tokenById(scene, tokenId) {
  const targetId = identifier(tokenId, 'tokenId');
  const index = (Array.isArray(scene.tokens) ? scene.tokens : [])
    .findIndex(token => String(token?.id ?? '') === targetId);
  if (index < 0) fail(`Unknown Token: ${targetId}`, 'token_not_found');
  return { index, token: scene.tokens[index] };
}

function actorById(world, actorId) {
  const targetId = identifier(actorId, 'actorId');
  const index = (Array.isArray(world.actors) ? world.actors : [])
    .findIndex(actor => String(actor?.id ?? '') === targetId);
  if (index < 0) fail(`Unknown Actor: ${targetId}`, 'actor_not_found');
  return { index, actor: world.actors[index] };
}

function normalizedToken(raw, actor, context = {}) {
  const token = clone(object(raw, 'token'));
  const independent = actorUsesIndependentInstances(actor);
  if (independent && token.actorLink === true) {
    fail(`${actor.type} Token instances cannot link to their Actor template`, 'instance_link_forbidden');
  }
  return normalizeSceneToken(token, {
    actorId: token.actorId, tokenId: token.id, actor, ruleset: context.ruleset,
  });
}

function allActorTokens(world, actorId) {
  return (world.scenes || []).flatMap(scene => (scene.tokens || [])
    .filter(token => String(token?.actorId ?? '') === String(actorId))
    .map(token => ({ scene, token })));
}

function assertVariantsRemainUsable(previousActor, nextActor, tokens) {
  const previousIds = new Set((previousActor?.system?.forms || []).map(form => String(form?.id ?? '')));
  const nextIds = new Set((nextActor?.system?.forms || []).map(form => String(form?.id ?? '')));
  const removed = new Set([...previousIds].filter(id => id && !nextIds.has(id)));
  if (!removed.size) return;
  const used = tokens.find(({ token }) => token.actorLink === false
    && removed.has(String(token.actorDelta?.system?.currentFormId ?? '')));
  if (used) fail(`Variant is used by Token ${used.token.id}`, 'variant_in_use');
}

function normalizeMarker(raw) {
  const source = object(raw, 'marker');
  identifier(source.id, 'marker.id');
  finite(source.x, 'marker.x');
  finite(source.y, 'marker.y');
  return normalizeLightweightMarker(source);
}

function detachTokenAnchors(scene, token) {
  const tokenId = String(token?.id ?? '');
  scene.attackAreas = (Array.isArray(scene.attackAreas) ? scene.attackAreas : []).map(area => {
    const anchor = plainObject(area?.anchor) ? area.anchor : {};
    const matches = anchor.type === 'token' && String(anchor.tokenId ?? '') === tokenId;
    if (!matches) return area;
    const next = clone(area);
    next.anchor = { type: 'free', markerId: null };
    if (token.placement === 'map' && Number.isFinite(Number(token.x)) && Number.isFinite(Number(token.y))) {
      next.origin = { x: Number(token.x), y: Number(token.y) };
    }
    return next;
  });
}

function pruneCombatReferences(state) {
  const world = worldFromState(state);
  const actorIds = new Set((world.actors || []).map(actor => String(actor?.id ?? '')));
  const tokenIds = new Set((activeScene(world).tokens || []).map(token => String(token?.id ?? '')));
  const combatSystem = state.preferences?.combatSystem;
  const combat = combatSystem?.combat;
  if (!plainObject(combat) || !Array.isArray(combat.combatants)) return;
  combat.combatants = combat.combatants.filter(item => tokenIds.has(String(item?.tokenId ?? ''))
    && (item?.actorId == null || actorIds.has(String(item.actorId))));
  if (!combat.combatants.length) combatSystem.combat = null;
  else combat.turnIndex = Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0));
}

function mergeRuntimeToken(canonical, runtime) {
  if (!runtime || String(runtime.id ?? '') !== String(canonical.id ?? '')) return clone(canonical);
  const next = clone(canonical);
  for (const key of ['actorLink', 'actorDelta', 'diameterMeters', 'rotation', 'elevationFt', 'controllerUserIds', 'visibility', 'vision', 'locked', 'showName', 'effects']) {
    if (runtime[key] !== undefined) next[key] = clone(runtime[key]);
  }
  return next;
}

function applyStatusProjectionToWorld(state) {
  const world = worldFromState(state);
  const entity = state.preferences?.entitySystem;
  if (!plainObject(entity)) return state;
  const actors = mapById(entity.actors || []);
  world.actors = (world.actors || []).map(actor => {
    const projected = actors.get(String(actor.id));
    if (!projected) return actor;
    return {
      ...actor,
      effects: clone(Array.isArray(projected.effects) ? projected.effects : []),
    };
  });
  if (Array.isArray(entity.statusDefinitions)) world.statusDefinitions = clone(entity.statusDefinitions);
  const scene = activeScene(world);
  const tokens = mapById(entity.tokens || []);
  scene.tokens = (scene.tokens || []).map(token => mergeRuntimeToken(token, tokens.get(String(token.id))));
  return state;
}

export function projectWorldOperationState(rawState) {
  const state = rawState;
  const world = worldFromState(state);
  const scene = activeScene(world);
  state.preferences ||= {};
  const entity = plainObject(state.preferences.entitySystem) ? state.preferences.entitySystem : {};
  entity.schemaVersion = STATUS_SCHEMA_VERSION;
  entity.actors = clone(world.actors || []);
  entity.tokens = clone(scene.tokens || []);
  entity.statusDefinitions = clone(world.statusDefinitions || []);
  state.preferences.entitySystem = entity;
  state.markers = clone(scene.markers || []);
  state.attackAreas = clone(scene.attackAreas || []);
  state.sceneEvents = clone(scene.sceneEvents || []);
  state.preferences.featureStates = clone(scene.featureStates || {});
  delete state.preferences.featureInteractions;
  if (plainObject(scene.settings) && scene.settings.gridVisible !== undefined) {
    state.preferences.gridVisible = scene.settings.gridVisible !== false;
  }
  pruneCombatReferences(state);
  return state;
}

function projectGranularOperationState(state, operations) {
  if (operations.some(operation => !GRANULAR_OPERATION_TYPES.has(operation.type))) {
    return projectWorldOperationState(state);
  }
  const world = worldFromState(state);
  const scene = activeScene(world);
  state.preferences ||= {};
  const entity = plainObject(state.preferences.entitySystem) ? state.preferences.entitySystem : {};
  entity.schemaVersion = STATUS_SCHEMA_VERSION;
  state.preferences.entitySystem = entity;
  if (operations.some(operation => operation.type === 'scene.activate')) {
    entity.tokens = clone(scene.tokens || []);
    state.markers = clone(scene.markers || []);
    state.attackAreas = clone(scene.attackAreas || []);
    state.sceneEvents = clone(scene.sceneEvents || []);
    state.preferences.featureStates = clone(scene.featureStates || {});
    if (plainObject(scene.settings) && scene.settings.gridVisible !== undefined) {
      state.preferences.gridVisible = scene.settings.gridVisible !== false;
    }
    pruneCombatReferences(state);
    return state;
  }
  for (const operation of operations) {
    const payload = operation.payload || {};
    if (operation.type === 'token.move' && String(payload.sceneId || world.activeSceneId) === String(world.activeSceneId)) {
      const token = scene.tokens?.find(item => String(item?.id ?? '') === String(payload.tokenId ?? ''));
      const index = entity.tokens?.findIndex(item => String(item?.id ?? '') === String(payload.tokenId ?? '')) ?? -1;
      if (token && index >= 0) entity.tokens[index] = clone(token);
    }
    if (operation.type === 'scene.featureState.patch'
      && String(payload.sceneId || world.activeSceneId) === String(world.activeSceneId)) {
      state.preferences.featureStates = plainObject(state.preferences.featureStates)
        ? state.preferences.featureStates
        : {};
      const featureId = String(payload.featureId || '');
      if (Object.hasOwn(scene.featureStates || {}, featureId)) {
        state.preferences.featureStates[featureId] = clone(scene.featureStates[featureId]);
      } else delete state.preferences.featureStates[featureId];
    }
  }
  delete state.preferences.featureInteractions;
  return state;
}

export function assertWorldOperationId(value) {
  const operationId = identifier(value, 'operationId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(operationId)) {
    fail('operationId may only contain letters, numbers, dot, underscore, colon, and hyphen', 'invalid_operation_id');
  }
  return operationId;
}

export function normalizeWorldOperation(value, label = 'operation') {
  const source = object(value, label);
  const type = String(source.type || '').trim();
  if (!OPERATION_TYPES.has(type)) fail(`Unknown World operation: ${type || '(missing)'}`, 'unknown_world_operation');
  return Object.freeze({ type, payload: clone(plainObject(source.payload) ? source.payload : {}) });
}

export function assertWorldOperationMessage(message) {
  const source = object(message, 'message');
  if (source.type !== 'world.operation') fail('message.type must be world.operation', 'unknown_message');
  const operationId = assertWorldOperationId(source.operationId);
  if (!Number.isSafeInteger(source.baseRevision) || source.baseRevision < 0) {
    fail('world.operation requires a non-negative integer baseRevision', 'invalid_revision');
  }
  const values = Array.isArray(source.operations) ? source.operations : [source.operation];
  if (!values.length || values.length > WORLD_OPERATION_BATCH_LIMIT) {
    fail(`world.operation must contain 1-${WORLD_OPERATION_BATCH_LIMIT} operations`, 'world_operation_limit');
  }
  const operations = values.map((value, index) => normalizeWorldOperation(value, `operations[${index}]`));
  return Object.freeze({ operationId, baseRevision: source.baseRevision, operations });
}

function applyCanonicalOperation(state, operation, context = {}) {
  const world = worldFromState(state);
  const payload = operation.payload;
  const type = operation.type;

  if (type === 'world.rename') {
    const name = String(payload.name || '').trim();
    if (!name) fail('world.rename requires name');
    world.name = name.slice(0, 160);
    return { action: type, worldId: String(world.id) };
  }

  if (type === 'actor.upsert') {
    let actor = clone(object(payload.actor, 'actor.upsert.actor'));
    const actorId = identifier(actor.id, 'actor.id');
    const index = (world.actors || []).findIndex(item => String(item?.id ?? '') === actorId);
    if (context.ruleset) actor = normalizeActorDocument(actor, { ruleset: context.ruleset });
    else Object.assign(actor, normalizeActorClassification(actor));
    if (index >= 0) {
      const previous = world.actors[index];
      const instances = allActorTokens(world, actorId);
      if (actorUsesIndependentInstances(actor) && instances.some(({ token }) => token.actorLink !== false)) {
        fail('Independent Actor templates require detached Token instances', 'instance_detach_required');
      }
      assertVariantsRemainUsable(previous, actor, instances);
      for (const { token } of instances) {
        if (token.actorLink !== false) continue;
        token.actorDelta = rebaseActorDelta(previous, actor, token.actorDelta, { ruleset: context.ruleset });
      }
    }
    if (index < 0) world.actors.push(actor);
    else world.actors[index] = actor;
    return { action: type, actorId, created: index < 0 };
  }

  if (type === 'actor.publicProfile.update') {
    const actorId = identifier(payload.actorId, 'actorId');
    const record = actorById(world, actorId);
    const statusDefinitionIds = (world.statusDefinitions || []).map(definition => String(definition?.id || '')).filter(Boolean);
    record.actor.publicProfile = normalizeActorPublicProfile(
      { ...record.actor.publicProfile, ...object(payload.publicProfile, 'actor.publicProfile.update.publicProfile') },
      { statusDefinitionIds },
    );
    record.actor.updatedAt = String(context.now || new Date().toISOString());
    return { action: type, actorId };
  }

  if (type === 'actor.runtime.perform') {
    const scene = sceneById(world, payload.sceneId);
    const runtimeOperation = object(payload.operation, 'actor.runtime.perform.operation');
    if (payload.tokenId != null) {
      const { index, token } = tokenById(scene, payload.tokenId);
      const baseRecord = actorById(world, token.actorId);
      if (token.actorLink === false) {
        if (!context.ruleset) fail('Actor runtime operation requires Ruleset', 'ruleset_required');
        const currentDelta = normalizeActorDelta(baseRecord.actor, token.actorDelta, { ruleset: context.ruleset });
        const resolved = normalizeActorDocument(mergeActorDelta(baseRecord.actor, currentDelta), { ruleset: context.ruleset });
        const applied = performActorOperation(resolved, runtimeOperation, { ...context, token, actor: resolved });
        if (!applied.changed) fail('Actor runtime operation was rejected', applied.blocked || 'actor_operation_blocked');
        scene.tokens[index] = {
          ...token,
          actorDelta: createActorDelta(baseRecord.actor, resolved, {
            ruleset: context.ruleset,
            currentDelta,
          }),
        };
        return { action: type, sceneId: String(scene.id), tokenId: String(token.id), actorId: String(token.actorId), synthetic: true };
      }
      const applied = performActorOperation(baseRecord.actor, runtimeOperation, { ...context, token, actor: baseRecord.actor });
      if (!applied.changed) fail('Actor runtime operation was rejected', applied.blocked || 'actor_operation_blocked');
      world.actors[baseRecord.index] = baseRecord.actor;
      return { action: type, sceneId: String(scene.id), tokenId: String(token.id), actorId: String(token.actorId), synthetic: false };
    }
    const record = actorById(world, payload.actorId);
    if (actorUsesIndependentInstances(record.actor)) {
      fail('Monster, NPC, and summon runtime operations require tokenId', 'instance_target_required');
    }
    if (!context.ruleset) fail('Actor runtime operation requires Ruleset', 'ruleset_required');
    const applied = performActorOperation(record.actor, runtimeOperation, { ...context, actor: record.actor });
    if (!applied.changed) fail('Actor runtime operation was rejected', applied.blocked || 'actor_operation_blocked');
    world.actors[record.index] = record.actor;
    return { action: type, actorId: String(record.actor.id), synthetic: false };
  }

  if (type === 'actor.instances.detach') {
    const record = actorById(world, payload.actorId);
    if (payload.actorType !== undefined) {
      record.actor.type = normalizeActorClassification({
        ...record.actor,
        type: payload.actorType,
        partyId: payload.partyId === undefined ? record.actor.partyId : payload.partyId,
      }).type;
      if (payload.partyId !== undefined) record.actor.partyId = normalizeActorClassification({
        ...record.actor, partyId: payload.partyId,
      }).partyId;
    }
    let converted = 0;
    for (const { token } of allActorTokens(world, record.actor.id)) {
      if (token.actorLink === false) {
        token.actorDelta = normalizeActorDelta(record.actor, token.actorDelta, { ruleset: context.ruleset });
        continue;
      }
      token.actorLink = false;
      token.actorDelta = createInitialActorDelta(record.actor, { ruleset: context.ruleset });
      converted += 1;
    }
    return { action: type, actorId: String(record.actor.id), converted };
  }

  if (type === 'actor.delete') {
    const actorId = identifier(payload.actorId, 'actorId');
    const index = (world.actors || []).findIndex(actor => String(actor?.id ?? '') === actorId);
    if (index < 0) fail(`Unknown Actor: ${actorId}`, 'actor_not_found');
    const tokenIds = [];
    for (const scene of world.scenes || []) {
      const removed = (scene.tokens || []).filter(token => String(token?.actorId ?? '') === actorId);
      removed.forEach(token => {
        tokenIds.push(String(token.id));
        detachTokenAnchors(scene, token);
      });
      scene.tokens = (scene.tokens || []).filter(token => String(token?.actorId ?? '') !== actorId);
    }
    world.actors.splice(index, 1);
    return { action: type, actorId, tokenIds };
  }

  if (type.startsWith('token.')) {
    const scene = sceneById(world, payload.sceneId);
    if (type === 'token.create' || type === 'token.upsert') {
      const token = clone(object(payload.token, `${type}.token`));
      const tokenId = identifier(token.id, 'token.id');
      const actorId = identifier(token.actorId, 'token.actorId');
      const actor = actorById(world, actorId).actor;
      const normalized = normalizedToken(token, actor, context);
      const index = (scene.tokens || []).findIndex(item => String(item?.id ?? '') === tokenId);
      if (type === 'token.create' && index >= 0) fail(`Token already exists: ${tokenId}`, 'token_exists');
      if (index < 0) scene.tokens.push(normalized);
      else scene.tokens[index] = normalized;
      return { action: type, sceneId: String(scene.id), tokenId, created: index < 0 };
    }
    const { index, token } = tokenById(scene, payload.tokenId);
    if (type === 'token.move') {
      const next = clone(token);
      if (payload.placement === 'feature') {
        next.placement = 'feature';
        next.featureId = identifier(payload.featureId, 'featureId');
        next.x = null;
        next.y = null;
      } else {
        next.placement = 'map';
        next.x = finite(payload.x, 'x');
        next.y = finite(payload.y, 'y');
        next.featureId = null;
      }
      scene.tokens[index] = next;
      return { action: type, sceneId: String(scene.id), tokenId: String(token.id) };
    }
    if (type === 'token.actorDelta.replace') {
      if (token.actorLink !== false) fail('Linked Token cannot store actorDelta', 'token_actor_linked');
      if (payload.actorDelta !== null && !plainObject(payload.actorDelta)) fail('actorDelta must be an object or null');
      const actor = actorById(world, token.actorId).actor;
      scene.tokens[index] = {
        ...token,
        actorDelta: normalizeActorDelta(actor, payload.actorDelta || {}, { ruleset: context.ruleset }),
      };
      return { action: type, sceneId: String(scene.id), tokenId: String(token.id), actorId: String(token.actorId) };
    }
    if (type === 'token.access.patch') {
      const patch = object(payload.patch, 'token.access.patch.patch');
      const allowed = new Set(['controllerUserIds', 'visibility', 'vision']);
      if (Object.keys(patch).some(key => !allowed.has(key))) fail('token.access.patch contains unsupported fields');
      const actor = actorById(world, token.actorId).actor;
      const merged = { ...token, ...clone(patch) };
      if (plainObject(patch.visibility)) merged.visibility = { ...clone(token.visibility || {}), ...clone(patch.visibility) };
      if (plainObject(patch.vision)) merged.vision = { ...clone(token.vision || {}), ...clone(patch.vision) };
      scene.tokens[index] = normalizedToken(merged, actor, context);
      return { action: type, sceneId: String(scene.id), tokenId: String(token.id) };
    }
    if (type === 'token.delete') {
      detachTokenAnchors(scene, token);
      scene.tokens.splice(index, 1);
      return { action: type, sceneId: String(scene.id), tokenId: String(token.id), actorId: String(token.actorId) };
    }
  }

  if (type.startsWith('marker.')) {
    const scene = sceneById(world, payload.sceneId);
    scene.markers = Array.isArray(scene.markers) ? scene.markers : [];
    if (type === 'marker.upsert') {
      const marker = normalizeMarker(payload.marker);
      const index = scene.markers.findIndex(item => String(item?.id ?? '') === marker.id);
      if (index < 0) scene.markers.push(marker);
      else scene.markers[index] = marker;
      return { action: type, sceneId: String(scene.id), markerId: marker.id, created: index < 0 };
    }
    const markerId = identifier(payload.markerId, 'markerId');
    const index = scene.markers.findIndex(item => String(item?.id ?? '') === markerId);
    if (index < 0) fail(`Unknown Marker: ${markerId}`, 'marker_not_found');
    if (type === 'marker.move') {
      scene.markers[index] = { ...scene.markers[index], x: finite(payload.x, 'x'), y: finite(payload.y, 'y') };
    } else scene.markers.splice(index, 1);
    return { action: type, sceneId: String(scene.id), markerId };
  }

  if (type === 'scene.upsert') {
    const scene = clone(object(payload.scene, 'scene.upsert.scene'));
    const sceneId = identifier(scene.id, 'scene.id');
    const index = (world.scenes || []).findIndex(item => String(item?.id ?? '') === sceneId);
    if (index < 0) world.scenes.push(scene);
    else world.scenes[index] = scene;
    return { action: type, sceneId, created: index < 0 };
  }

  if (type === 'scene.activate') {
    const scene = sceneById(world, payload.sceneId);
    world.activeSceneId = String(scene.id);
    return { action: type, sceneId: String(scene.id) };
  }

  if (type === 'scene.delete') {
    const sceneId = identifier(payload.sceneId, 'sceneId');
    if (String(world.activeSceneId) === sceneId) fail('Active Scene cannot be deleted', 'scene_active_delete_forbidden');
    const index = (world.scenes || []).findIndex(scene => String(scene?.id ?? '') === sceneId);
    if (index < 0) fail(`Unknown Scene: ${sceneId}`, 'scene_not_found');
    world.scenes.splice(index, 1);
    return { action: type, sceneId };
  }

  if (type === 'scene.content.replace') {
    const scene = sceneById(world, payload.sceneId);
    for (const key of ['markers', 'attackAreas', 'sceneEvents']) {
      if (payload[key] !== undefined) scene[key] = clone(array(payload[key], key));
    }
    if (payload.settings !== undefined) scene.settings = clone(object(payload.settings, 'settings'));
    return { action: type, sceneId: String(scene.id) };
  }

  if (type === 'scene.featureState.patch') {
    const scene = sceneById(world, payload.sceneId);
    const featureId = identifier(payload.featureId, 'featureId');
    const patch = payload.patch === null ? null : object(payload.patch, 'scene.featureState.patch.patch');
    assertFeatureStatePatch(patch);
    scene.featureStates = plainObject(scene.featureStates) ? scene.featureStates : {};
    const next = applyFeatureStateMergePatch(scene.featureStates[featureId], patch);
    if (next === null || Object.keys(next).length === 0) delete scene.featureStates[featureId];
    else scene.featureStates[featureId] = next;
    return { action: type, sceneId: String(scene.id), featureId, removed: next === null };
  }

  if (type.startsWith('scene.fog.')) {
    const scene = sceneById(world, payload.sceneId);
    const partyId = identifier(payload.partyId, 'partyId');
    const map = plainObject(context.mapMetrics) ? context.mapMetrics : {};
    if (type === 'scene.fog.reset') scene.fog = resetFogParty(scene.fog, partyId);
    else if (type === 'scene.fog.hide') {
      const radiusMeters = Math.max(0, finite(payload.radiusMeters, 'radiusMeters'));
      scene.fog = hideFogCircle(scene.fog, partyId, {
        x: finite(payload.x, 'x'), y: finite(payload.y, 'y'),
        radiusMeters,
      }, map);
    } else if (payload.from && payload.to) {
      const radiusMeters = Math.max(0, finite(payload.radiusMeters, 'radiusMeters'));
      scene.fog = exploreFogSweep(scene.fog, partyId, payload.from, payload.to, radiusMeters, map);
    } else {
      const radiusMeters = Math.max(0, finite(payload.radiusMeters, 'radiusMeters'));
      scene.fog = exploreFogCircle(scene.fog, partyId, {
        x: finite(payload.x, 'x'), y: finite(payload.y, 'y'),
        radiusMeters,
      }, map);
    }
    return { action: type, sceneId: String(scene.id), partyId };
  }

  if (type === 'combat.replace') {
    state.preferences.combatSystem = clone(object(payload.combatSystem, 'combatSystem'));
    return { action: type };
  }

  if (type === 'combat.advance') {
    const combatSystem = plainObject(state.preferences.combatSystem)
      ? state.preferences.combatSystem
      : null;
    const combat = combatSystem?.combat;
    if (!plainObject(combat) || combat.state !== 'active' || !Array.isArray(combat.combatants) || !combat.combatants.length) {
      fail('combat.advance requires active Combat', 'combat_not_active');
    }
    const previousRound = Math.max(1, Math.floor(Number(combat.round) || 1));
    combat.turnIndex = Math.max(0, Math.floor(Number(combat.turnIndex) || 0)) + 1;
    if (combat.turnIndex >= combat.combatants.length) {
      combat.turnIndex = 0;
      combat.round = previousRound + 1;
    } else combat.round = previousRound;
    combat.turnOrigin = null;
    const scene = activeScene(world);
    const advanced = advanceStatusDurations({
      schemaVersion: 4,
      actors: world.actors || [],
      tokens: scene.tokens || [],
      statusDefinitions: world.statusDefinitions || [],
    }, {
      roundAdvanced: combat.round > previousRound,
      now: String(context.now || new Date().toISOString()),
      round: combat.round,
      turn: combat.turnIndex,
    });
    world.actors = advanced.state.actors;
    scene.tokens = advanced.state.tokens;
    world.statusDefinitions = advanced.state.statusDefinitions;
    return {
      action: type,
      round: combat.round,
      turnIndex: combat.turnIndex,
      expiredCount: advanced.expiredEffectIds.length,
    };
  }

  if (type === 'chat.append') {
    const text = String(payload.text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 4_000);
    if (!text) fail('chat.append requires non-empty text', 'invalid_chat');
    const createMessage = typeof context.createChatMessage === 'function'
      ? context.createChatMessage
      : input => ({
        id: String(context.randomId?.() || `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
        type: String(input.event || 'chat'),
        text: input.text,
        createdAt: String(context.now || new Date().toISOString()),
        sender: clone(context.sender || { id: 'offline', name: '本地 GM', role: 'gm' }),
        data: plainObject(input.data) ? clone(input.data) : null,
      });
    const message = object(createMessage({
      text,
      event: String(payload.event || 'chat'),
      data: plainObject(payload.data) ? clone(payload.data) : null,
    }), 'chat message');
    identifier(message.id, 'chat.id');
    state.preferences.chatSystem = plainObject(state.preferences.chatSystem)
      ? state.preferences.chatSystem
      : { schemaVersion: 1, messages: [] };
    const messages = Array.isArray(state.preferences.chatSystem.messages)
      ? state.preferences.chatSystem.messages
      : [];
    messages.push(clone(message));
    if (messages.length > 500) messages.splice(0, messages.length - 500);
    state.preferences.chatSystem.messages = messages;
    return { action: type, chatId: String(message.id) };
  }

  if (type === 'chat.clear') {
    state.preferences.chatSystem = { schemaVersion: 1, messages: [] };
    return { action: type };
  }

  fail(`Unsupported World operation: ${type}`, 'unknown_world_operation');
}

export function applyWorldOperations(rawState, rawOperations, context = {}) {
  const operations = array(rawOperations, 'operations').map((operation, index) =>
    normalizeWorldOperation(operation, `operations[${index}]`));
  if (!operations.length || operations.length > WORLD_OPERATION_BATCH_LIMIT) {
    fail(`operations must contain 1-${WORLD_OPERATION_BATCH_LIMIT} items`, 'world_operation_limit');
  }
  const state = cloneOperationInput(rawState, operations);
  worldFromState(state);
  const results = [];
  for (const operation of operations) {
    if (STATUS_TYPES.has(operation.type)) {
      if (typeof context.applyStatus !== 'function') fail('Status operation handler is unavailable', 'status_handler_unavailable');
      const applied = context.applyStatus(state, { type: operation.type, ...clone(operation.payload) }, context);
      if (!plainObject(applied?.state)) fail('Status operation handler returned invalid state', 'status_handler_invalid');
      Object.keys(state).forEach(key => delete state[key]);
      Object.assign(state, clone(applied.state));
      applyStatusProjectionToWorld(state);
      results.push(...(Array.isArray(applied.results) ? clone(applied.results) : []));
    } else {
      results.push(applyCanonicalOperation(state, operation, context));
    }
  }
  const world = worldFromState(state);
  world.updatedAt = String(context.now || new Date().toISOString());
  projectGranularOperationState(state, operations);
  const changeSet = createOperationChangeSet(operations, results, rawState, state)
    || createWorldOperationChangeSet(rawState, state);
  applyFogOperationDirtyBounds(changeSet, operations, context.mapMetrics);
  return {
    state,
    operations: clone(operations),
    results,
    changeSet,
  };
}

function createOperationChangeSet(operations, results, beforeState, afterState) {
  if (operations.some(operation => !GRANULAR_OPERATION_TYPES.has(operation.type))) return null;
  const beforeWorld = worldFromState(beforeState);
  const afterWorld = worldFromState(afterState);
  const actorIds = new Set();
  const tokenIdsByScene = new Map();
  const featureIdsByScene = new Map();
  const fogSceneIds = new Set();
  const appendedIds = new Set();
  let chatCleared = false;
  let statusDefinitionsChanged = false;
  let activeSceneChanged = false;
  const activeSceneId = String(afterWorld.activeSceneId || beforeWorld.activeSceneId || '');
  const addToken = (sceneId, tokenId) => {
    const scene = String(sceneId || activeSceneId);
    if (!scene || !tokenId) return;
    if (!tokenIdsByScene.has(scene)) tokenIdsByScene.set(scene, new Set());
    tokenIdsByScene.get(scene).add(String(tokenId));
  };
  const collectStatusTarget = payload => {
    if (payload?.type === 'status.batch') {
      for (const item of payload.operations || []) collectStatusTarget(item);
      return;
    }
    const scope = String(payload?.scope || payload?.target?.scope || '');
    const targetId = String(payload?.targetId || payload?.target?.targetId || '');
    if (scope === 'actor' && targetId) actorIds.add(targetId);
    else if ((scope === 'token' || scope === 'syntheticActor') && targetId) addToken(activeSceneId, targetId);
  };
  for (const operation of operations) {
    const payload = operation.payload || {};
    if (operation.type === 'token.move') addToken(payload.sceneId, payload.tokenId);
    else if (operation.type === 'scene.featureState.patch') {
      const sceneId = String(payload.sceneId || activeSceneId);
      if (!featureIdsByScene.has(sceneId)) featureIdsByScene.set(sceneId, new Set());
      featureIdsByScene.get(sceneId).add(String(payload.featureId));
    } else if (operation.type === 'scene.activate') activeSceneChanged = true;
    else if (operation.type.startsWith('scene.fog.')) fogSceneIds.add(String(payload.sceneId || activeSceneId));
    else if (operation.type.startsWith('status.definition.')) statusDefinitionsChanged = true;
    else if (operation.type.startsWith('status.')) collectStatusTarget({ type: operation.type, ...payload });
    else if (operation.type === 'chat.clear') chatCleared = true;
  }
  for (const result of results || []) if (result?.chatId) appendedIds.add(String(result.chatId));
  return {
    actors: { upsertIds: [...actorIds], removeIds: [] },
    tokens: [...tokenIdsByScene].map(([sceneId, ids]) => ({ sceneId, upsertIds: [...ids], removeIds: [] })),
    scenes: { upsertIds: [], removeIds: [], activeSceneChanged },
    featureStates: [...featureIdsByScene].map(([sceneId, ids]) => ({ sceneId, featureIds: [...ids] })),
    fog: [...fogSceneIds].map(sceneId => ({ sceneId, dirtyBounds: null })),
    combatChanged: false,
    chat: { appendedIds: [...appendedIds], cleared: chatCleared },
    statusDefinitionsChanged,
  };
}

function mergeBounds(left, right) {
  if (!left || !right) return left || right || null;
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

function fogOperationBounds(operation, mapMetrics = {}) {
  if (!String(operation?.type || '').startsWith('scene.fog.')) return undefined;
  if (operation.type === 'scene.fog.reset') return null;
  const payload = plainObject(operation.payload) ? operation.payload : {};
  const metersPerUnit = Math.max(0.000001, Number(mapMetrics?.metersPerUnit) || 1);
  const radius = Math.max(0, Number(payload.radiusMeters) || 0) / metersPerUnit;
  const points = payload.from && payload.to ? [payload.from, payload.to] : [payload];
  const values = points.map(point => ({ x: Number(point?.x), y: Number(point?.y) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!values.length) return null;
  return {
    minX: Math.min(...values.map(point => point.x)) - radius,
    minY: Math.min(...values.map(point => point.y)) - radius,
    maxX: Math.max(...values.map(point => point.x)) + radius,
    maxY: Math.max(...values.map(point => point.y)) + radius,
  };
}

function applyFogOperationDirtyBounds(changeSet, operations, mapMetrics) {
  const byScene = new Map();
  for (const operation of operations) {
    const bounds = fogOperationBounds(operation, mapMetrics);
    if (bounds === undefined) continue;
    const sceneId = String(operation.payload?.sceneId || '');
    if (!sceneId) continue;
    if (bounds === null || byScene.get(sceneId) === null) byScene.set(sceneId, null);
    else byScene.set(sceneId, mergeBounds(byScene.get(sceneId), bounds));
  }
  for (const entry of changeSet.fog || []) {
    if (byScene.has(String(entry.sceneId))) entry.dirtyBounds = clone(byScene.get(String(entry.sceneId)));
  }
}

function diffById(beforeItems = [], afterItems = []) {
  const before = mapById(beforeItems);
  const after = mapById(afterItems);
  const upsert = [];
  const remove = [];
  for (const [id, value] of after) if (!before.has(id) || !same(before.get(id), value)) upsert.push(clone(value));
  for (const id of before.keys()) if (!after.has(id)) remove.push(id);
  return { upsert, remove };
}

function sceneMetadata(scene) {
  if (!plainObject(scene)) return scene;
  const value = clone(scene);
  delete value.tokens;
  delete value.markers;
  delete value.attackAreas;
  delete value.sceneEvents;
  delete value.featureStates;
  delete value.fog;
  delete value.settings;
  return value;
}

function sceneContent(scene) {
  return {
    markers: clone(scene?.markers || []),
    attackAreas: clone(scene?.attackAreas || []),
    sceneEvents: clone(scene?.sceneEvents || []),
    settings: clone(scene?.settings || {}),
  };
}

function changedIds(beforeItems = [], afterItems = []) {
  const diff = diffById(beforeItems, afterItems);
  return {
    upsertIds: diff.upsert.map(item => String(item.id)),
    removeIds: diff.remove.map(String),
  };
}

function chatMessages(state) {
  const messages = state?.preferences?.chatSystem?.messages;
  return Array.isArray(messages) ? messages : [];
}

export function createWorldOperationChangeSet(beforeState, afterState) {
  const beforeWorld = worldFromState(beforeState);
  const afterWorld = worldFromState(afterState);
  const beforeScenes = mapById(beforeWorld.scenes);
  const afterScenes = mapById(afterWorld.scenes);
  const tokens = [];
  const featureStates = [];
  const fog = [];
  for (const [sceneId, scene] of afterScenes) {
    const previous = beforeScenes.get(sceneId);
    const tokenChanges = changedIds(previous?.tokens || [], scene.tokens || []);
    if (tokenChanges.upsertIds.length || tokenChanges.removeIds.length) tokens.push({ sceneId, ...tokenChanges });
    const featureChanges = changedIds(
      Object.entries(previous?.featureStates || {}).map(([id, state]) => ({ id, state })),
      Object.entries(scene.featureStates || {}).map(([id, state]) => ({ id, state })),
    );
    const featureIds = [...new Set([...featureChanges.upsertIds, ...featureChanges.removeIds])];
    if (featureIds.length) featureStates.push({ sceneId, featureIds });
    if (!same(previous?.fog, scene.fog)) fog.push({ sceneId, dirtyBounds: null });
  }
  for (const [sceneId, scene] of beforeScenes) {
    if (afterScenes.has(sceneId)) continue;
    const removeIds = (scene.tokens || []).map(token => String(token.id));
    if (removeIds.length) tokens.push({ sceneId, upsertIds: [], removeIds });
  }
  const beforeChat = chatMessages(beforeState);
  const afterChat = chatMessages(afterState);
  const beforeChatIds = new Set(beforeChat.map(message => String(message?.id || '')));
  const appendedIds = afterChat
    .filter(message => !beforeChatIds.has(String(message?.id || '')))
    .map(message => String(message.id));
  const cleared = beforeChat.length > 0 && afterChat.length === 0;
  const sceneChanges = changedIds(
    (beforeWorld.scenes || []).map(sceneMetadata),
    (afterWorld.scenes || []).map(sceneMetadata),
  );
  return {
    actors: changedIds(beforeWorld.actors || [], afterWorld.actors || []),
    tokens,
    scenes: {
      ...sceneChanges,
      activeSceneChanged: String(beforeWorld.activeSceneId || '') !== String(afterWorld.activeSceneId || ''),
    },
    featureStates,
    fog,
    combatChanged: !same(beforeState?.preferences?.combatSystem, afterState?.preferences?.combatSystem),
    chat: { appendedIds, cleared },
    statusDefinitionsChanged: !same(beforeWorld.statusDefinitions, afterWorld.statusDefinitions),
  };
}

export function createWorldOperationPatch(beforeState, afterState) {
  const beforeWorld = worldFromState(beforeState);
  const afterWorld = worldFromState(afterState);
  const patch = { schemaVersion: WORLD_OPERATION_SCHEMA_VERSION, world: {} };
  if (String(beforeWorld.name ?? '') !== String(afterWorld.name ?? '')) patch.world.name = String(afterWorld.name ?? '');
  if (String(beforeWorld.activeSceneId ?? '') !== String(afterWorld.activeSceneId ?? '')) {
    patch.world.activeSceneId = String(afterWorld.activeSceneId ?? '');
  }
  patch.world.updatedAt = String(afterWorld.updatedAt || new Date().toISOString());
  const actors = diffById(beforeWorld.actors, afterWorld.actors);
  if (actors.upsert.length || actors.remove.length) patch.world.actors = actors;
  if (!same(beforeWorld.statusDefinitions, afterWorld.statusDefinitions)) {
    patch.world.statusDefinitions = clone(afterWorld.statusDefinitions || []);
  }
  const beforeScenes = mapById(beforeWorld.scenes);
  const afterScenes = mapById(afterWorld.scenes);
  const scenes = { upsert: [], remove: [], tokens: [], content: [], featureStates: [], fog: [] };
  for (const [sceneId, scene] of afterScenes) {
    const previous = beforeScenes.get(sceneId);
    if (!previous || !same(sceneMetadata(previous), sceneMetadata(scene))) {
      scenes.upsert.push(clone(scene));
      continue;
    }
    const tokens = diffById(previous.tokens, scene.tokens);
    if (tokens.upsert.length || tokens.remove.length) scenes.tokens.push({ sceneId, ...tokens });
    if (!same(sceneContent(previous), sceneContent(scene))) scenes.content.push({ sceneId, ...sceneContent(scene) });
    const featureStates = diffById(
      Object.entries(previous.featureStates || {}).map(([id, state]) => ({ id, state })),
      Object.entries(scene.featureStates || {}).map(([id, state]) => ({ id, state })),
    );
    if (featureStates.upsert.length || featureStates.remove.length) scenes.featureStates.push({ sceneId, ...featureStates });
    if (!same(previous.fog, scene.fog)) scenes.fog.push({ sceneId, fog: normalizeFogState(scene.fog) });
  }
  for (const sceneId of beforeScenes.keys()) if (!afterScenes.has(sceneId)) scenes.remove.push(sceneId);
  if (scenes.upsert.length || scenes.remove.length || scenes.tokens.length || scenes.content.length || scenes.featureStates.length || scenes.fog.length) {
    patch.world.scenes = scenes;
  }
  if (!same(beforeState?.preferences?.combatSystem, afterState?.preferences?.combatSystem)) {
    patch.combatSystem = clone(afterState?.preferences?.combatSystem || { schemaVersion: 1, combat: null });
  }
  if (!same(beforeState?.preferences?.chatSystem, afterState?.preferences?.chatSystem)) {
    patch.chatSystem = clone(afterState?.preferences?.chatSystem || { schemaVersion: 1, messages: [] });
  }
  if (!same(beforeState?.preferences?.audienceVision, afterState?.preferences?.audienceVision)) {
    patch.audienceVision = afterState?.preferences?.audienceVision === undefined
      ? null
      : clone(afterState.preferences.audienceVision);
  }
  return patch;
}

function applyIdPatch(items, patch) {
  const values = mapById(items);
  for (const id of patch?.remove || []) values.delete(String(id));
  for (const value of patch?.upsert || []) values.set(identifier(value?.id, 'patch item id'), clone(value));
  return [...values.values()];
}

export function applyWorldOperationPatch(rawState, rawPatch) {
  const state = clone(object(rawState, 'state'));
  const patch = object(rawPatch, 'patch');
  if (Number(patch.schemaVersion) !== WORLD_OPERATION_SCHEMA_VERSION) {
    fail('Unsupported World operation patch schema', 'operation_patch_incompatible');
  }
  state.preferences = clone(object(state.preferences, 'state.preferences'));
  const world = worldFromState(state);
  const worldPatch = object(patch.world, 'patch.world');
  if (worldPatch.name !== undefined) world.name = String(worldPatch.name);
  if (worldPatch.activeSceneId !== undefined) world.activeSceneId = String(worldPatch.activeSceneId);
  if (worldPatch.updatedAt !== undefined) world.updatedAt = String(worldPatch.updatedAt);
  if (worldPatch.actors) world.actors = applyIdPatch(world.actors, worldPatch.actors);
  if (worldPatch.statusDefinitions !== undefined) world.statusDefinitions = clone(array(worldPatch.statusDefinitions, 'statusDefinitions'));
  if (worldPatch.scenes) {
    world.scenes = applyIdPatch(world.scenes, worldPatch.scenes);
    const scenes = mapById(world.scenes);
    for (const tokenPatch of worldPatch.scenes.tokens || []) {
      const scene = scenes.get(identifier(tokenPatch.sceneId, 'sceneId'));
      if (!scene) fail(`Patch references missing Scene: ${tokenPatch.sceneId}`, 'invalid_reference');
      scene.tokens = applyIdPatch(scene.tokens, tokenPatch);
    }
    for (const content of worldPatch.scenes.content || []) {
      const scene = scenes.get(identifier(content.sceneId, 'sceneId'));
      if (!scene) fail(`Patch references missing Scene: ${content.sceneId}`, 'invalid_reference');
      scene.markers = clone(content.markers || []);
      scene.attackAreas = clone(content.attackAreas || []);
      scene.sceneEvents = clone(content.sceneEvents || []);
      scene.settings = clone(content.settings || {});
    }
    for (const featurePatch of worldPatch.scenes.featureStates || []) {
      const scene = scenes.get(identifier(featurePatch.sceneId, 'sceneId'));
      if (!scene) fail(`Patch references missing Scene: ${featurePatch.sceneId}`, 'invalid_reference');
      scene.featureStates = plainObject(scene.featureStates) ? scene.featureStates : {};
      for (const featureId of featurePatch.remove || []) delete scene.featureStates[identifier(featureId, 'featureId')];
      for (const item of featurePatch.upsert || []) {
        const featureId = identifier(item?.id, 'featureId');
        const value = object(item?.state, 'featureState');
        assertFeatureStatePatch(value);
        scene.featureStates[featureId] = clone(value);
      }
    }
    for (const fogPatch of worldPatch.scenes.fog || []) {
      const scene = scenes.get(identifier(fogPatch.sceneId, 'sceneId'));
      if (!scene) fail(`Patch references missing Scene: ${fogPatch.sceneId}`, 'invalid_reference');
      scene.fog = normalizeFogState(fogPatch.fog);
    }
  }
  if (patch.combatSystem !== undefined) state.preferences.combatSystem = clone(patch.combatSystem);
  if (patch.chatSystem !== undefined) state.preferences.chatSystem = clone(patch.chatSystem);
  if (patch.audienceVision === null) delete state.preferences.audienceVision;
  else if (patch.audienceVision !== undefined) state.preferences.audienceVision = clone(object(patch.audienceVision, 'audienceVision'));
  return projectWorldOperationState(state);
}

function tokenWithout(token, keys) {
  const value = clone(token);
  keys.forEach(key => delete value[key]);
  return value;
}

function unsupportedProjection(state) {
  const copy = clone(state);
  delete copy.markers;
  delete copy.attackAreas;
  delete copy.sceneEvents;
  if (plainObject(copy.preferences)) {
    delete copy.preferences.worldV2;
    delete copy.preferences.entitySystem;
    delete copy.preferences.combatSystem;
    delete copy.preferences.chatSystem;
    delete copy.preferences.gridVisible;
    delete copy.preferences.featureStates;
    delete copy.preferences.featureInteractions;
  }
  return copy;
}

export function deriveWorldOperations(beforeState, afterState) {
  const beforeWorld = worldFromState(beforeState);
  const afterWorld = clone(worldFromState(afterState));
  const entity = afterState?.preferences?.entitySystem;
  if (plainObject(entity)) {
    if (Array.isArray(entity.actors)) afterWorld.actors = clone(entity.actors);
    const scene = activeScene(afterWorld);
    const tokens = mapById(entity.tokens || []);
    scene.tokens = (scene.tokens || []).map(token => mergeRuntimeToken(token, tokens.get(String(token.id))));
  }
  const scene = activeScene(afterWorld);
  if (Array.isArray(afterState?.markers)) scene.markers = clone(afterState.markers);
  if (Array.isArray(afterState?.attackAreas)) scene.attackAreas = clone(afterState.attackAreas);
  if (Array.isArray(afterState?.sceneEvents)) scene.sceneEvents = clone(afterState.sceneEvents);
  if (afterState?.preferences?.gridVisible !== undefined) {
    scene.settings = { ...clone(scene.settings || {}), gridVisible: afterState.preferences.gridVisible !== false };
  }
  const operations = [];
  const unsupported = [];
  if (Number(beforeWorld.schemaVersion) !== Number(afterWorld.schemaVersion)
    || String(beforeWorld.id) !== String(afterWorld.id)
    || !same(beforeWorld.ruleset, afterWorld.ruleset)) unsupported.push('world_identity');
  if (!same(beforeState?.preferences?.chatSystem, afterState?.preferences?.chatSystem)) unsupported.push('chat');
  if (!same(unsupportedProjection(beforeState), unsupportedProjection(afterState))) unsupported.push('runtime_state');
  if (!same(beforeWorld.statusDefinitions, afterWorld.statusDefinitions)) unsupported.push('status_definitions');

  if (String(beforeWorld.name ?? '') !== String(afterWorld.name ?? '')) {
    operations.push({ type: 'world.rename', payload: { name: afterWorld.name } });
  }

  const actors = diffById(beforeWorld.actors, afterWorld.actors);
  const removedActorIds = new Set(actors.remove);
  actors.upsert.forEach(actor => operations.push({ type: 'actor.upsert', payload: { actor } }));
  actors.remove.forEach(actorId => operations.push({ type: 'actor.delete', payload: { actorId } }));

  const beforeScenes = mapById(beforeWorld.scenes);
  const afterScenes = mapById(afterWorld.scenes);
  for (const [sceneId, scene] of afterScenes) {
    const previous = beforeScenes.get(sceneId);
    if (!previous) {
      operations.push({ type: 'scene.upsert', payload: { scene } });
      continue;
    }
    if (!same(sceneMetadata(previous), sceneMetadata(scene))) {
      operations.push({ type: 'scene.upsert', payload: { scene } });
      continue;
    }
    const beforeTokens = mapById(previous.tokens);
    const afterTokens = mapById(scene.tokens);
    for (const [tokenId, token] of afterTokens) {
      const old = beforeTokens.get(tokenId);
      if (!old) {
        operations.push({ type: 'token.upsert', payload: { sceneId, token } });
        continue;
      }
      if (same(old, token)) continue;
      const placementKeys = ['placement', 'x', 'y', 'featureId'];
      if (same(tokenWithout(old, placementKeys), tokenWithout(token, placementKeys))) {
        operations.push({ type: 'token.move', payload: {
          sceneId, tokenId, placement: token.placement,
          x: token.x, y: token.y, featureId: token.featureId,
        } });
      } else if (same(tokenWithout(old, ['actorDelta']), tokenWithout(token, ['actorDelta']))) {
        operations.push({ type: 'token.actorDelta.replace', payload: { sceneId, tokenId, actorDelta: token.actorDelta } });
      } else {
        operations.push({ type: 'token.upsert', payload: { sceneId, token } });
      }
    }
    for (const [tokenId, token] of beforeTokens) {
      if (!afterTokens.has(tokenId) && !removedActorIds.has(String(token.actorId))) {
        operations.push({ type: 'token.delete', payload: { sceneId, tokenId } });
      }
    }
    if (!same(sceneContent(previous), sceneContent(scene))) {
      operations.push({ type: 'scene.content.replace', payload: { sceneId, ...sceneContent(scene) } });
    }
    const beforeFeatureStates = plainObject(previous.featureStates) ? previous.featureStates : {};
    const afterFeatureStates = plainObject(scene.featureStates) ? scene.featureStates : {};
    for (const [featureId, value] of Object.entries(afterFeatureStates)) {
      if (!same(beforeFeatureStates[featureId], value)) {
        operations.push({
          type: 'scene.featureState.patch',
          payload: { sceneId, featureId, patch: createMergePatch(beforeFeatureStates[featureId], value) },
        });
      }
    }
    for (const featureId of Object.keys(beforeFeatureStates)) {
      if (!Object.prototype.hasOwnProperty.call(afterFeatureStates, featureId)) {
        operations.push({ type: 'scene.featureState.patch', payload: { sceneId, featureId, patch: null } });
      }
    }
    if (!same(previous.fog, scene.fog)) unsupported.push('fog_projection_write');
  }
  if (String(beforeWorld.activeSceneId) !== String(afterWorld.activeSceneId)) {
    operations.push({ type: 'scene.activate', payload: { sceneId: afterWorld.activeSceneId } });
  }
  for (const sceneId of beforeScenes.keys()) {
    if (!afterScenes.has(sceneId)) operations.push({ type: 'scene.delete', payload: { sceneId } });
  }
  if (!same(beforeState?.preferences?.combatSystem, afterState?.preferences?.combatSystem)) {
    operations.push({ type: 'combat.replace', payload: {
      combatSystem: clone(afterState?.preferences?.combatSystem || { schemaVersion: 1, combat: null }),
    } });
  }
  if (operations.length > WORLD_OPERATION_BATCH_LIMIT) unsupported.push('operation_limit');
  return { operations: clone(operations), unsupported: [...new Set(unsupported)] };
}

export function isStatusWorldOperation(operation) {
  return STATUS_TYPES.has(String(operation?.type || ''));
}

function createMergePatch(before, after) {
  if (!isFeatureStateObject(before) || !isFeatureStateObject(after)) return clone(after);
  const patch = {};
  for (const [key, value] of Object.entries(after)) {
    if (!same(before[key], value)) patch[key] = createMergePatch(before[key], value);
  }
  for (const key of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) patch[key] = null;
  }
  return patch;
}
