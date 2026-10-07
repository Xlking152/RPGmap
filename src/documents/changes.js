import { normalizeOcclusionShapes } from '../vision/occlusion-model.js';

const SCENE_COLLECTIONS = Object.freeze({ Token: 'tokens', Marker: 'markers', AttackArea: 'attackAreas', SceneEvent: 'sceneEvents', OcclusionShape: 'occlusionShapes' });
const WORLD_COLLECTIONS = Object.freeze({ Actor: 'actors', StatusDefinition: 'statusDefinitions', Journal: 'journals' });
const OMIT_WORLD = new Set(['actors', 'scenes', 'statusDefinitions', 'journals', 'updatedAt']);
const OMIT_SCENE = new Set([...Object.values(SCENE_COLLECTIONS), 'featureStates', 'fog']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clone = structuredClone;
const immutableJsonDocuments = new WeakSet();
const immutableCollections = new WeakSet();

function immutableJson(value, visiting = new WeakSet(), depth = 0) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || depth > 48 || visiting.has(value)) return false;
  if (immutableJsonDocuments.has(value)) return true;
  if (!Object.isFrozen(value) || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype
    : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) || Object.getOwnPropertySymbols(value).length) return false;
  visiting.add(value);
  const valid = Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) =>
    Array.isArray(value) && key === 'length'
      || descriptor.enumerable && Object.hasOwn(descriptor, 'value') && immutableJson(descriptor.value, visiting, depth + 1));
  visiting.delete(value);
  if (valid) immutableJsonDocuments.add(value);
  return valid;
}

function immutableCollection(items) {
  if (immutableCollections.has(items)) return true;
  if (!immutableJson(items)) return false;
  const ids = new Set();
  for (const item of items) {
    if (!plain(item) || !Object.hasOwn(item, 'id')) return false;
    const id = String(item.id);
    if (ids.has(id)) return false;
    ids.add(id);
  }
  immutableCollections.add(items);
  return true;
}

function fail(message, code = 'invalid_document_change') {
  throw Object.assign(new Error(message), { code });
}

function safeKey(value) {
  if (typeof value !== 'string' || !value || FORBIDDEN.has(value)) fail('Invalid Document field or identifier');
  return value;
}

function safeValue(value, depth = 0) {
  if (depth > 48) fail('Document change nesting limit exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => safeValue(item, depth + 1)); return; }
  if (!plain(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Document changes require JSON values');
  for (const [key, item] of Object.entries(value)) { safeKey(key); safeValue(item, depth + 1); }
}

export { safeValue as assertDocumentJson };

function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

export function documentKey(address) {
  return JSON.stringify([address?.parent?.type || null, address?.parent?.id || null, address?.type, address?.id]);
}

function omit(value, keys) {
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !keys.has(key)));
}

export function documentEntries(state) {
  const world = state?.preferences?.worldV2;
  if (!world) fail('Document changes require a World');
  const entries = [];
  const add = (type, id, value, parent = null) => {
    if (value !== undefined) entries.push([{ type, id: String(id), parent }, value]);
  };
  add('World', world.id, omit(world, OMIT_WORLD));
  for (const [type, field] of Object.entries(WORLD_COLLECTIONS)) {
    for (const value of world[field] || []) add(type, value.id, value);
  }
  for (const scene of world.scenes || []) {
    add('Scene', scene.id, omit(scene, OMIT_SCENE));
    const parent = { type: 'Scene', id: String(scene.id) };
    for (const [type, field] of Object.entries(SCENE_COLLECTIONS)) {
      for (const value of scene[field] || []) add(type, value.id, value, parent);
    }
    for (const [id, value] of Object.entries(scene.featureStates || {})) add('FeatureState', id, value, parent);
    add('Fog', scene.id, scene.fog, parent);
  }
  const chat = state.preferences?.chatSystem;
  add('ChatLog', 'active', chat === undefined ? undefined : omit(chat, new Set(['messages'])));
  for (const message of chat?.messages || []) add('ChatMessage', message.id, message);
  add('Combat', 'active', state.preferences?.combatSystem);
  add('Audience', 'current', state.preferences?.audienceVision);
  return entries;
}

function diffFields(before, after, path = [], removed = [], isCanonicalData = null) {
  const changed = {};
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) removed.push([...path, key]);
  }
  for (const [key, value] of Object.entries(after)) {
    if (equal(before[key], value) && Object.hasOwn(before, key)) continue;
    if (plain(before[key]) && plain(value)) {
      const nested = diffFields(before[key], value, [...path, key], removed, isCanonicalData);
      if (Object.keys(nested).length) changed[key] = nested;
    } else changed[key] = value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)) ? value
        : typeof isCanonicalData === 'function' && isCanonicalData(value) === true ? value : clone(value);
  }
  return changed;
}

function collectionEntries(state) {
  const world = state.preferences.worldV2;
  const entries = [['Scene', world.scenes, null], ['ChatMessage', state.preferences.chatSystem?.messages || [], null]];
  for (const [type, field] of Object.entries(WORLD_COLLECTIONS)) entries.push([type, world[field] || [], null]);
  for (const scene of world.scenes) {
    for (const [type, field] of Object.entries(SCENE_COLLECTIONS)) {
      if (type === 'OcclusionShape' && !Object.hasOwn(scene, field)) continue;
      entries.push([type, scene[field] || [], { type: 'Scene', id: String(scene.id) }]);
    }
  }
  return entries.map(([id, values, parent]) => [{ type: 'Collection', id, parent }, values.map(value => String(value.id))]);
}

function fogBoundsByScene(fog) {
  const fogBounds = new Map();
  for (const item of fog) {
    const sceneId = String(item.sceneId), previousBounds = fogBounds.get(sceneId), next = item.dirtyBounds;
    if (previousBounds === null || next === null) fogBounds.set(sceneId, null);
    else fogBounds.set(sceneId, previousBounds ? {
      minX: Math.min(previousBounds.minX, next.minX), minY: Math.min(previousBounds.minY, next.minY),
      maxX: Math.max(previousBounds.maxX, next.maxX), maxY: Math.max(previousBounds.maxY, next.maxY),
    } : next);
  }
  return fogBounds;
}

// Internal additive Fog commits cannot alter other documents or collection
// order. Diff only the recipient's addressed Fog, keeping the public delta
// format and deletion semantics identical to the full projection diff.
export function createFogDocumentChanges(beforeState, afterState, { fog = [], isCanonicalData = null } = {}) {
  const bounds = fogBoundsByScene(fog), changes = [];
  const beforeScenes = new Map((beforeState?.preferences?.worldV2?.scenes || []).map(scene => [String(scene.id), scene]));
  const afterScenes = new Map((afterState?.preferences?.worldV2?.scenes || []).map(scene => [String(scene.id), scene]));
  for (const [sceneId, dirtyBounds] of bounds) {
    const before = beforeScenes.get(sceneId)?.fog, after = afterScenes.get(sceneId)?.fog;
    if (equal(before, after)) continue;
    const document = { type: 'Fog', id: sceneId, parent: { type: 'Scene', id: sceneId } };
    if (after === undefined) { changes.push({ action: 'delete', document, changed: null }); continue; }
    if (before === undefined) { changes.push({ action: 'create', document, changed: clone(after), dirtyBounds: dirtyBounds ?? null }); continue; }
    const removed = [];
    // Only the server's accepted, deeply immutable JSON proof may share an
    // addressed replacement leaf. Each recipient still derives its own keys
    // from its filtered Fog; default callers retain detached mutable output.
    // Sharing canonical row arrays avoids cloning the same large numeric rows
    // once for every session while synchronous socket serialization reads them.
    const changed = plain(before) && plain(after) ? diffFields(before, after, [], removed, isCanonicalData) : clone(after);
    changes.push({ action: 'update', document, changed, ...(removed.length ? { removed } : {}), dirtyBounds: dirtyBounds ?? null });
  }
  return changes;
}

// Changes are generated only from the recipient's before/after projections.
// Arrays are atomic field values; object deletions have explicit path segments.
function createPairedDocumentChanges(beforeState, afterState, { motion = [], fog = [], collectionChanges = null } = {}) {
  const beforeWorld = beforeState?.preferences?.worldV2;
  const afterWorld = afterState?.preferences?.worldV2;
  if (!beforeWorld || !afterWorld || !Array.isArray(beforeWorld.scenes) || !Array.isArray(afterWorld.scenes)
    || String(beforeWorld.id) !== String(afterWorld.id)) return null;
  const moved = new Set(motion.map(item => documentKey({ type: 'Token', id: String(item.tokenId), parent: { type: 'Scene', id: String(item.sceneId) } })));
  const fogBounds = fogBoundsByScene(fog);
  const changes = [];
  const paired = (type, id, before, after, parent = null) => {
    if (equal(before, after)) return;
    const document = { type, id: String(id), parent };
    const removed = [];
    const changed = plain(before) && plain(after) ? diffFields(before, after, [], removed) : clone(after);
    const moving = moved.has(documentKey(document)) || (type === 'Token'
      && motion.some(item => !item.sceneId && String(item.tokenId) === document.id));
    changes.push({
      action: moving ? 'move' : 'update', document, changed,
      ...(removed.length ? { removed } : {}),
      ...(type === 'Fog' ? { dirtyBounds: fogBounds.get(parent.id) ?? null } : {}),
    });
  };
  const sameCollection = (type, beforeItems, afterItems, parent = null, onPair = paired) => {
    const before = beforeItems || [], after = afterItems || [];
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
    const qualified = onPair === paired && collectionChanges instanceof Map ? collectionChanges.get(after) : null;
    if (qualified?.before === before && Object.isFrozen(qualified) && Object.isFrozen(qualified.indices)
      && Array.isArray(qualified.indices) && qualified.indices.every((index, offset) => Number.isInteger(index)
        && index >= 0 && index < before.length && (!offset || qualified.indices[offset - 1] < index)
        && before[index] && after[index] && String(before[index].id) === String(after[index].id))) {
      for (const index of qualified.indices) onPair(type, String(before[index].id), before[index], after[index], parent);
      return true;
    }
    // Scene pairs still descend into Fog, feature states and child collections.
    // Only an unchanged qualified leaf collection can omit the ID scan.
    if (onPair === paired && before === after && immutableCollection(before)) return true;
    const seen = new Set();
    for (let index = 0; index < before.length; index += 1) {
      if (!before[index] || !after[index]) return false;
      const id = String(before[index]?.id);
      if (id !== String(after[index]?.id) || seen.has(id)) return false;
      seen.add(id);
      if (onPair(type, id, before[index], after[index], parent) === false) return false;
    }
    return true;
  };
  paired('World', beforeWorld.id, omit(beforeWorld, OMIT_WORLD), omit(afterWorld, OMIT_WORLD));
  for (const [type, field] of Object.entries(WORLD_COLLECTIONS)) {
    if (!sameCollection(type, beforeWorld[field], afterWorld[field])) return null;
  }
  if (!sameCollection('Scene', beforeWorld.scenes, afterWorld.scenes, null,
    (_type, id, beforeScene, afterScene) => {
      paired('Scene', id, omit(beforeScene, OMIT_SCENE), omit(afterScene, OMIT_SCENE));
      const parent = { type: 'Scene', id };
      for (const [type, field] of Object.entries(SCENE_COLLECTIONS)) {
        if (type === 'OcclusionShape' && Object.hasOwn(beforeScene, field) !== Object.hasOwn(afterScene, field)) return false;
        if (!sameCollection(type, beforeScene[field], afterScene[field], parent)) return false;
      }
      const beforeFeatures = Object.entries(beforeScene.featureStates || {});
      const afterFeatures = Object.entries(afterScene.featureStates || {});
      if (beforeFeatures.length !== afterFeatures.length) return false;
      for (let index = 0; index < beforeFeatures.length; index += 1) {
        const [featureId, beforeValue] = beforeFeatures[index];
        const [afterId, afterValue] = afterFeatures[index];
        if (featureId !== afterId || (beforeValue === undefined) !== (afterValue === undefined)) return false;
        if (beforeValue !== undefined) paired('FeatureState', featureId, beforeValue, afterValue, parent);
      }
      if ((beforeScene.fog === undefined) !== (afterScene.fog === undefined)) return false;
      if (beforeScene.fog !== undefined) paired('Fog', id, beforeScene.fog, afterScene.fog, parent);
    })) return null;
  const beforeChat = beforeState.preferences?.chatSystem;
  const afterChat = afterState.preferences?.chatSystem;
  if ((beforeChat === undefined) !== (afterChat === undefined)) return null;
  if (beforeChat !== undefined) paired('ChatLog', 'active', omit(beforeChat, OMIT_CHAT), omit(afterChat, OMIT_CHAT));
  if (!sameCollection('ChatMessage', beforeChat?.messages, afterChat?.messages)) return null;
  for (const [type, id, before, after] of [
    ['Combat', 'active', beforeState.preferences?.combatSystem, afterState.preferences?.combatSystem],
    ['Audience', 'current', beforeState.preferences?.audienceVision, afterState.preferences?.audienceVision],
  ]) {
    if ((before === undefined) !== (after === undefined)) return null;
    if (before !== undefined) paired(type, id, before, after);
  }
  return changes;
}

const OMIT_CHAT = new Set(['messages']);

export function createDocumentChanges(beforeState, afterState, patch = null, options = {}) {
  const paired = createPairedDocumentChanges(beforeState, afterState, options);
  if (paired) return paired;
  return createDocumentChangesFull(beforeState, afterState, patch, options);
}

export function createDocumentChangesFull(beforeState, afterState, _patch = null, { motion = [], fog = [] } = {}) {
  const previous = new Map(documentEntries(beforeState).map(([address, value]) => [documentKey(address), { address, value }]));
  const moved = new Set(motion.map(item => documentKey({ type: 'Token', id: String(item.tokenId), parent: { type: 'Scene', id: String(item.sceneId) } })));
  const fogBounds = fogBoundsByScene(fog);
  const changes = [];
  for (const [document, value] of documentEntries(afterState)) {
    const key = documentKey(document);
    const before = previous.get(key);
    previous.delete(key);
    if (!before) {
      changes.push({
        action: document.type === 'ChatMessage' ? 'append' : 'create', document, changed: clone(value),
        ...(document.type === 'Fog' ? { dirtyBounds: fogBounds.get(document.parent.id) ?? null } : {}),
      });
      continue;
    }
    if (equal(before.value, value)) continue;
    const removed = [];
    const changed = plain(before.value) && plain(value) ? diffFields(before.value, value, [], removed) : clone(value);
    const moving = moved.has(key) || (document.type === 'Token' && motion.some(item => !item.sceneId && String(item.tokenId) === document.id));
    changes.push({
      action: moving ? 'move' : 'update', document, changed,
      ...(removed.length ? { removed } : {}),
      ...(document.type === 'Fog' ? { dirtyBounds: fogBounds.get(document.parent.id) ?? null } : {}),
    });
  }
  for (const { address } of previous.values()) changes.push({ action: 'delete', document: address, changed: null });
  const beforeOrders = new Map(collectionEntries(beforeState).map(([address, ids]) => [documentKey(address), ids]));
  for (const [document, ids] of collectionEntries(afterState)) {
    const oldIds = beforeOrders.get(documentKey(document)) || [];
    const retained = new Set(ids);
    const existing = new Set(oldIds);
    const defaultOrder = [...oldIds.filter(id => retained.has(id)), ...ids.filter(id => !existing.has(id))];
    if (!equal(defaultOrder, ids) || (document.id === 'OcclusionShape' && !beforeOrders.has(documentKey(document)))) {
      changes.push({ action: 'update', document, changed: { ids } });
    }
  }
  return changes;
}

function mergeFields(before, changed) {
  if (!plain(changed)) return clone(changed);
  const next = plain(before) ? { ...before } : {};
  for (const [key, value] of Object.entries(changed)) next[key] = plain(value) ? mergeFields(next[key], value) : clone(value);
  return next;
}

function removeField(value, path) {
  if (!plain(value)) fail('Removed field parent must be an object');
  const next = { ...value };
  const [key, ...rest] = path;
  if (rest.length) {
    if (Object.hasOwn(next, key)) next[key] = removeField(next[key], rest);
  } else delete next[key];
  return next;
}

export function applyDocumentValue(before, change) {
  if (!['create', 'update', 'delete', 'move', 'append'].includes(change?.action)) fail('Unsupported Document change action');
  if (change.action === 'delete') return undefined;
  safeValue(change.changed);
  let next = ['create', 'append'].includes(change.action) ? clone(change.changed) : mergeFields(before, change.changed);
  if (change.removed !== undefined && !Array.isArray(change.removed)) fail('Removed fields must be paths');
  for (const path of change.removed || []) {
    if (!Array.isArray(path) || !path.length || path.length > 48) fail('Invalid removed field path');
    path.forEach(safeKey);
    next = removeField(next, path);
  }
  return next;
}

function applyList(items, id, change) {
  const index = items.findIndex(item => String(item.id) === id);
  if (index >= 0 && ['create', 'append'].includes(change.action)) fail('Created Document already exists', 'duplicate_id');
  if (index < 0 && ['update', 'move'].includes(change.action)) fail('Updated Document does not exist', 'invalid_reference');
  const next = applyDocumentValue(index < 0 ? undefined : items[index], change);
  if (next !== undefined && String(next?.id) !== id) fail('Document identity cannot change');
  const values = items.slice();
  if (next === undefined) { if (index >= 0) values.splice(index, 1); }
  else if (index < 0) values.push(next);
  else values[index] = next;
  return values;
}

function assertReferences(world) {
  const unique = values => {
    const ids = new Set();
    for (const value of values) {
      const id = safeKey(String(value?.id || ''));
      if (ids.has(id)) fail('Duplicate Document id', 'duplicate_id');
      ids.add(id);
    }
    return ids;
  };
  const actors = unique(world.actors);
  const scenes = unique(world.scenes);
  if (!scenes.has(String(world.activeSceneId))) fail('Active Scene is missing', 'invalid_reference');
  for (const scene of world.scenes) {
    unique(scene.tokens);
    if (scene.occlusionShapes !== undefined) normalizeOcclusionShapes(scene.occlusionShapes);
    for (const token of scene.tokens) if (!actors.has(String(token.actorId))) fail('Token Actor is missing', 'invalid_reference');
  }
}

function reordered(items, change) {
  const ids = change.changed?.ids;
  if (change.action !== 'update' || !Array.isArray(ids) || ids.length !== items.length) fail('Invalid Document collection order');
  const byId = new Map(items.map(value => [String(value.id), value]));
  const values = ids.map(id => {
    safeKey(id);
    if (!byId.has(id)) fail('Document order references a missing or duplicate id', 'invalid_reference');
    const value = byId.get(id);
    byId.delete(id);
    return value;
  });
  return values;
}

function assertDocumentAddress(change) {
  const address = change?.document;
  const type = safeKey(address?.type);
  const id = safeKey(address?.id);
  if (address.parent != null && (address.parent.type !== 'Scene' || !safeKey(address.parent.id))) fail('Invalid Document parent');
  const child = Object.hasOwn(SCENE_COLLECTIONS, type) || ['FeatureState', 'Fog'].includes(type);
  if (type !== 'Collection' && Boolean(address.parent) !== child) fail('Document parent does not match its type');
  if (type === 'Fog' && id !== address.parent.id) fail('Fog identity must match its Scene');
  if (['ChatLog', 'Combat'].includes(type) && id !== 'active') fail('Invalid singleton Document id');
  if (type === 'Audience' && id !== 'current') fail('Invalid Audience Document id');
  if (!['create', 'update', 'delete', 'move', 'append'].includes(change.action)) fail('Unsupported Document change action');
  if (change.action === 'move' && type !== 'Token') fail('Only Token changes can contain motion');
  if (change.action === 'append' && type !== 'ChatMessage') fail('Only ChatMessage changes can append');
  if (change.dirtyBounds !== undefined) {
    if (type !== 'Fog') fail('Only Fog changes can contain dirty bounds');
    safeValue(change.dirtyBounds);
  }
  safeValue(change.changed);
  if (change.removed !== undefined) {
    if (!Array.isArray(change.removed)) fail('Removed fields must be paths');
    for (const path of change.removed) {
      if (!Array.isArray(path) || !path.length || path.length > 48) fail('Invalid removed field path');
      path.forEach(safeKey);
    }
  }
  const protectedFields = type === 'World' ? OMIT_WORLD : type === 'Scene' ? OMIT_SCENE : type === 'ChatLog' ? new Set(['messages']) : null;
  if (protectedFields && (Object.keys(change.changed || {}).some(key => protectedFields.has(key))
    || (change.removed || []).some(path => protectedFields.has(path[0])))) fail('Child collections require addressed Document changes');
  if (['World', 'Scene'].includes(type) && change.changed?.id !== undefined && change.changed.id !== id) fail('Document identity cannot change');
  if (['World', 'Scene'].includes(type) && (change.removed || []).some(path => path[0] === 'id')) fail('Document identity cannot be removed');
  return address;
}

export function applyDocumentChanges(rawState, changes, { updatedAt = null } = {}) {
  if (!Array.isArray(changes)) fail('Document changes must be an array');
  const preferences = { ...rawState.preferences };
  const world = { ...preferences.worldV2 };
  const state = { ...rawState, preferences };
  preferences.worldV2 = world;
  for (const change of changes) {
    const address = assertDocumentAddress(change);
    const { type, id } = address;
    if (type === 'Collection') {
      if (address.parent) {
        if (!Object.hasOwn(SCENE_COLLECTIONS, id)) fail('Unknown Scene collection');
        const index = world.scenes.findIndex(scene => String(scene.id) === address.parent.id);
        if (index < 0) fail('Document Scene is missing', 'invalid_reference');
        const scene = { ...world.scenes[index] };
        world.scenes = world.scenes.slice();
        world.scenes[index] = scene;
        scene[SCENE_COLLECTIONS[id]] = reordered(scene[SCENE_COLLECTIONS[id]] || [], change);
      } else if (id === 'Scene') world.scenes = reordered(world.scenes, change);
      else if (id === 'ChatMessage') preferences.chatSystem = { ...preferences.chatSystem, messages: reordered(preferences.chatSystem.messages, change) };
      else if (Object.hasOwn(WORLD_COLLECTIONS, id)) world[WORLD_COLLECTIONS[id]] = reordered(world[WORLD_COLLECTIONS[id]], change);
      else fail('Unknown World collection');
    } else if (type === 'World') {
      if (id !== String(world.id) || change.action === 'delete') fail('World identity cannot change');
      if (Object.keys(change.changed || {}).some(key => OMIT_WORLD.has(key))) fail('Child collections require addressed Document changes');
      Object.assign(world, applyDocumentValue(world, change));
      for (const path of change.removed || []) if (path.length === 1) delete world[path[0]];
    } else if (Object.hasOwn(WORLD_COLLECTIONS, type)) {
      world[WORLD_COLLECTIONS[type]] = applyList(world[WORLD_COLLECTIONS[type]] || [], id, change);
    } else if (type === 'Scene') {
      if (Object.keys(change.changed || {}).some(key => OMIT_SCENE.has(key))) fail('Scene children require addressed Document changes');
      const prepared = change.action === 'create' ? { ...change, changed: {
        tokens: [], markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, ...change.changed,
      } } : change;
      world.scenes = applyList(world.scenes || [], id, prepared);
    } else if (Object.hasOwn(SCENE_COLLECTIONS, type) || type === 'FeatureState' || type === 'Fog') {
      if (address.parent?.type !== 'Scene') fail('Scene child requires a Scene parent');
      const index = world.scenes.findIndex(scene => String(scene.id) === address.parent.id);
      // A Scene deletion includes its child removals; deleting an absent child is harmless.
      if (index < 0 && change.action === 'delete') continue;
      if (index < 0) fail('Document Scene is missing', 'invalid_reference');
      const scene = { ...world.scenes[index] };
      world.scenes = world.scenes.slice();
      world.scenes[index] = scene;
      if (type === 'FeatureState') {
        const value = applyDocumentValue(scene.featureStates?.[id], change);
        scene.featureStates = { ...scene.featureStates };
        if (value === undefined) delete scene.featureStates[id];
        else scene.featureStates[id] = value;
      } else if (type === 'Fog') scene.fog = applyDocumentValue(scene.fog, change);
      else scene[SCENE_COLLECTIONS[type]] = applyList(scene[SCENE_COLLECTIONS[type]] || [], id, change);
    } else if (type === 'ChatMessage') {
      preferences.chatSystem = { ...preferences.chatSystem, messages: applyList(preferences.chatSystem?.messages || [], id, change) };
    } else if (type === 'ChatLog') {
      preferences.chatSystem = { ...applyDocumentValue(preferences.chatSystem, change), messages: preferences.chatSystem?.messages || [] };
    } else if (type === 'Combat') preferences.combatSystem = applyDocumentValue(preferences.combatSystem, change);
    else if (type === 'Audience') {
      const value = applyDocumentValue(preferences.audienceVision, change);
      if (value === undefined) delete preferences.audienceVision;
      else preferences.audienceVision = value;
    } else fail('Unknown committed Document type');
  }
  if (updatedAt != null) world.updatedAt = String(updatedAt);
  assertReferences(world);
  const scene = world.scenes.find(item => String(item.id) === String(world.activeSceneId));
  preferences.entitySystem = { ...preferences.entitySystem, actors: world.actors, tokens: scene.tokens, statusDefinitions: world.statusDefinitions };
  preferences.featureStates = scene.featureStates || {};
  delete preferences.featureInteractions;
  if (scene.settings?.gridVisible !== undefined) preferences.gridVisible = scene.settings.gridVisible !== false;
  state.markers = scene.markers || [];
  state.attackAreas = scene.attackAreas || [];
  state.sceneEvents = scene.sceneEvents || [];
  return state;
}

export function documentChangeSet(changes) {
  const result = {
    actors: { upsertIds: [], removeIds: [] }, tokens: [],
    scenes: { upsertIds: [], removeIds: [], activeSceneChanged: false },
    featureStates: [], fog: [], combatChanged: false,
    chat: { appendedIds: [], removedIds: [], cleared: false }, statusDefinitionsChanged: false,
    sceneContent: [], collections: [],
  };
  const group = (values, sceneId, defaults) => {
    let entry = values.find(item => item.sceneId === sceneId);
    if (!entry) { entry = { sceneId, ...defaults }; values.push(entry); }
    return entry;
  };
  for (const { document: { type, id, parent }, action, changed, removed = [], dirtyBounds } of changes) {
    const deleted = action === 'delete';
    if (type === 'World' && changed?.activeSceneId !== undefined) result.scenes.activeSceneChanged = true;
    if (type === 'Actor') result.actors[deleted ? 'removeIds' : 'upsertIds'].push(id);
    if (type === 'Scene') result.scenes[deleted ? 'removeIds' : 'upsertIds'].push(id);
    if (['Marker', 'AttackArea', 'SceneEvent', 'OcclusionShape'].includes(type)) group(result.sceneContent, parent.id, { types: [] }).types.push(type);
    if (type === 'Collection') result.collections.push({ type: id, sceneId: parent?.id || null });
    if (type === 'Token') {
      const entry = group(result.tokens, parent.id, { upsertIds: [], removeIds: [], fields: {} });
      entry[deleted ? 'removeIds' : 'upsertIds'].push(id);
      entry.fields[id] = [...new Set([...Object.keys(changed || {}), ...removed.map(path => path[0])])];
    }
    if (type === 'FeatureState') group(result.featureStates, parent.id, { featureIds: [] }).featureIds.push(id);
    if (type === 'Fog') group(result.fog, parent.id, { dirtyBounds: dirtyBounds ?? null });
    if (type === 'Combat') result.combatChanged = true;
    if (type === 'StatusDefinition') result.statusDefinitionsChanged = true;
    if (type === 'ChatMessage') result.chat[deleted ? 'removedIds' : 'appendedIds'].push(id);
  }
  result.chat.cleared = result.chat.removedIds.length > 0;
  return result;
}
