// Read-only conversion of projected UI changes to commands; no authority reducer.
import { DOCUMENT_OPERATION_SCHEMA_VERSION } from "../documents/protocol.js";
import { isPlainObject as isFeatureStateObject } from "./feature-states.js";
export const WORLD_OPERATION_SCHEMA_VERSION = DOCUMENT_OPERATION_SCHEMA_VERSION;
const WORLD_OPERATION_BATCH_LIMIT = 64;
const clone = structuredClone;

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(message, code = 'invalid_world_operation') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function same(left, right) {
  if (left === right) return true;
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function mapById(items = []) {
  return new Map((Array.isArray(items) ? items : [])
    .filter(item => item?.id != null)
    .map(item => [String(item.id), item]));
}

function worldFromState(state) {
  const world = state?.preferences?.worldV2;
  if (!plainObject(world) || ![2, 3, 4].includes(Number(world.schemaVersion))) {
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

function mergeRuntimeToken(canonical, runtime) {
  if (!runtime || String(runtime.id ?? '') !== String(canonical.id ?? '')) return clone(canonical);
  const next = clone(canonical);
  for (const key of ['actorLink', 'actorDelta', 'diameterMeters', 'rotation', 'elevationMeters', 'movement', 'light', 'controllerUserIds', 'visibility', 'vision', 'locked', 'showName', 'effects']) {
    if (runtime[key] !== undefined) next[key] = clone(runtime[key]);
  }
  return next;
}

function diffById(beforeItems = [], afterItems = []) {
  if (beforeItems === afterItems) return { upsert: [], remove: [] };
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
  const { tokens, markers, attackAreas, sceneEvents, featureStates, occlusionShapes, fog, settings, ...metadata } = scene;
  return clone(metadata);
}

function sceneContent(scene) {
  return {
    markers: clone(scene?.markers || []),
    attackAreas: clone(scene?.attackAreas || []),
    sceneEvents: clone(scene?.sceneEvents || []),
    settings: clone(scene?.settings || {}),
  };
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

  const journals = diffById(beforeWorld.journals || [], afterWorld.journals || []);
  journals.upsert.forEach(journal => operations.push({ type: 'journal.upsert', payload: {
    journal,
    expected: beforeWorld.journals?.find(entry => String(entry.id) === String(journal.id)) || null,
  } }));
  journals.remove.forEach(journalId => operations.push({ type: 'journal.delete', payload: {
    journalId,
    expected: beforeWorld.journals?.find(entry => String(entry.id) === String(journalId)) || null,
  } }));

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
    const shapeDiff = diffById(previous.occlusionShapes || [], scene.occlusionShapes || []);
    for (const shape of shapeDiff.upsert) operations.push({ type: 'scene.occlusionShape.upsert', payload: { sceneId, shape } });
    for (const shapeId of shapeDiff.remove) operations.push({ type: 'scene.occlusionShape.delete', payload: { sceneId, shapeId } });
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

