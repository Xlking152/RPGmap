export const WORLD_OPERATION_SCHEMA_VERSION = 1;
export const WORLD_OPERATION_BATCH_LIMIT = 64;
export const WORLD_OPERATION_CACHE_LIMIT = 512;

const OPERATION_TYPES = new Set([
  'world.rename',
  'actor.upsert',
  'actor.delete',
  'token.upsert',
  'token.move',
  'token.actorDelta.replace',
  'token.delete',
  'scene.upsert',
  'scene.activate',
  'scene.delete',
  'scene.content.replace',
  'combat.replace',
  'status.apply',
  'status.remove',
  'status.setStacks',
  'status.definition.upsert',
  'status.definition.delete',
  'status.batch',
]);

const STATUS_TYPES = new Set([...OPERATION_TYPES].filter(type => type.startsWith('status.')));

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
  if (!plainObject(world) || Number(world.schemaVersion) !== 2) {
    fail('World operation requires initialized World V2', 'world_v2_required');
  }
  return world;
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

function detachTokenAnchors(scene, token) {
  const tokenId = String(token?.id ?? '');
  scene.attackAreas = (Array.isArray(scene.attackAreas) ? scene.attackAreas : []).map(area => {
    const anchor = plainObject(area?.anchor) ? area.anchor : {};
    const matches = (anchor.type === 'token' && String(anchor.tokenId ?? '') === tokenId)
      || (anchor.type === 'character' && String(anchor.characterId ?? '') === tokenId);
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
  for (const key of ['actorLink', 'actorDelta', 'diameterMeters', 'rotation', 'elevationFt', 'hidden', 'locked', 'showName', 'effects']) {
    if (runtime[key] !== undefined) next[key] = clone(runtime[key]);
  }
  return next;
}

function synchronizeWorldFromProjection(state) {
  const world = worldFromState(state);
  const entity = state.preferences?.entitySystem;
  if (!plainObject(entity)) return state;
  if (Array.isArray(entity.actors)) world.actors = clone(entity.actors);
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
  entity.schemaVersion = Math.max(3, Number(entity.schemaVersion) || 0);
  entity.actors = clone(world.actors || []);
  entity.tokens = clone(scene.tokens || []);
  entity.statusDefinitions = clone(world.statusDefinitions || []);
  state.preferences.entitySystem = entity;
  state.markers = clone(scene.markers || []);
  state.attackAreas = clone(scene.attackAreas || []);
  state.sceneEvents = clone(scene.sceneEvents || []);
  if (plainObject(scene.settings) && scene.settings.gridVisible !== undefined) {
    state.preferences.gridVisible = scene.settings.gridVisible !== false;
  }
  pruneCombatReferences(state);
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

function applyCanonicalOperation(state, operation) {
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
    const actor = clone(object(payload.actor, 'actor.upsert.actor'));
    const actorId = identifier(actor.id, 'actor.id');
    const index = (world.actors || []).findIndex(item => String(item?.id ?? '') === actorId);
    if (index < 0) world.actors.push(actor);
    else world.actors[index] = actor;
    return { action: type, actorId, created: index < 0 };
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
    if (type === 'token.upsert') {
      const token = clone(object(payload.token, 'token.upsert.token'));
      const tokenId = identifier(token.id, 'token.id');
      const actorId = identifier(token.actorId, 'token.actorId');
      if (!(world.actors || []).some(actor => String(actor?.id ?? '') === actorId)) {
        fail(`Token references missing Actor: ${actorId}`, 'invalid_reference');
      }
      const index = (scene.tokens || []).findIndex(item => String(item?.id ?? '') === tokenId);
      if (index < 0) scene.tokens.push(token);
      else scene.tokens[index] = token;
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
      scene.tokens[index] = { ...token, actorDelta: clone(payload.actorDelta) };
      return { action: type, sceneId: String(scene.id), tokenId: String(token.id), actorId: String(token.actorId) };
    }
    if (type === 'token.delete') {
      detachTokenAnchors(scene, token);
      scene.tokens.splice(index, 1);
      return { action: type, sceneId: String(scene.id), tokenId: String(token.id), actorId: String(token.actorId) };
    }
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

  if (type === 'combat.replace') {
    state.preferences.combatSystem = clone(object(payload.combatSystem, 'combatSystem'));
    return { action: type };
  }

  fail(`Unsupported World operation: ${type}`, 'unknown_world_operation');
}

export function applyWorldOperations(rawState, rawOperations, context = {}) {
  const state = clone(object(rawState, 'state'));
  state.preferences = clone(object(state.preferences, 'state.preferences'));
  worldFromState(state);
  const operations = array(rawOperations, 'operations').map((operation, index) =>
    normalizeWorldOperation(operation, `operations[${index}]`));
  if (!operations.length || operations.length > WORLD_OPERATION_BATCH_LIMIT) {
    fail(`operations must contain 1-${WORLD_OPERATION_BATCH_LIMIT} items`, 'world_operation_limit');
  }
  const results = [];
  for (const operation of operations) {
    if (STATUS_TYPES.has(operation.type)) {
      if (typeof context.applyStatus !== 'function') fail('Status operation handler is unavailable', 'status_handler_unavailable');
      const applied = context.applyStatus(state, { type: operation.type, ...clone(operation.payload) }, context);
      if (!plainObject(applied?.state)) fail('Status operation handler returned invalid state', 'status_handler_invalid');
      Object.keys(state).forEach(key => delete state[key]);
      Object.assign(state, clone(applied.state));
      synchronizeWorldFromProjection(state);
      results.push(...(Array.isArray(applied.results) ? clone(applied.results) : []));
    } else {
      results.push(applyCanonicalOperation(state, operation));
      projectWorldOperationState(state);
    }
  }
  const world = worldFromState(state);
  world.updatedAt = String(context.now || new Date().toISOString());
  projectWorldOperationState(state);
  return { state, operations: clone(operations), results };
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
  const scenes = { upsert: [], remove: [], tokens: [], content: [] };
  for (const [sceneId, scene] of afterScenes) {
    const previous = beforeScenes.get(sceneId);
    if (!previous || !same(sceneMetadata(previous), sceneMetadata(scene))) {
      scenes.upsert.push(clone(scene));
      continue;
    }
    const tokens = diffById(previous.tokens, scene.tokens);
    if (tokens.upsert.length || tokens.remove.length) scenes.tokens.push({ sceneId, ...tokens });
    if (!same(sceneContent(previous), sceneContent(scene))) scenes.content.push({ sceneId, ...sceneContent(scene) });
  }
  for (const sceneId of beforeScenes.keys()) if (!afterScenes.has(sceneId)) scenes.remove.push(sceneId);
  if (scenes.upsert.length || scenes.remove.length || scenes.tokens.length || scenes.content.length) patch.world.scenes = scenes;
  if (!same(beforeState?.preferences?.combatSystem, afterState?.preferences?.combatSystem)) {
    patch.combatSystem = clone(afterState?.preferences?.combatSystem || { schemaVersion: 1, combat: null });
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
  }
  if (patch.combatSystem !== undefined) state.preferences.combatSystem = clone(patch.combatSystem);
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
  }
  return copy;
}

export function deriveWorldOperations(beforeState, afterState) {
  const beforeWorld = worldFromState(beforeState);
  const afterWorld = worldFromState(afterState);
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
