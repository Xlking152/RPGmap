export const DOCUMENT_OPERATION_SCHEMA_VERSION = 3;
export const DOCUMENT_BATCH_LIMIT = 64;
export const DOCUMENT_MOVE_POINT_LIMIT = 64;

const ACTIONS = new Set(['create', 'update', 'delete', 'move', 'append']);
const DOCUMENT_TYPES = new Set([
  'Actor', 'Token', 'Scene', 'ChatMessage', 'Combat', 'Status', 'Fog',
]);

const INTENT_TO_OPERATION = new Map([
  ['actor.upsert', 'actor.upsert'],
  ['actor.publicProfile.update', 'actor.publicProfile.update'],
  ['actor.delete', 'actor.delete'],
  ['actor.runtime.perform', 'actor.runtime.perform'],
  ['actor.instances.detach', 'actor.instances.detach'],
  ['token.create', 'token.create'],
  ['token.upsert', 'token.upsert'],
  ['token.updateAccess', 'token.access.patch'],
  ['token.updateActorDelta', 'token.actorDelta.replace'],
  ['token.delete', 'token.delete'],
  ['token.movePath', 'token.movePath'],
  ['scene.upsert', 'scene.upsert'],
  ['scene.activate', 'scene.activate'],
  ['scene.delete', 'scene.delete'],
  ['scene.content.replace', 'scene.content.replace'],
  ['scene.featureState.patch', 'scene.featureState.patch'],
  ['fog.explore', 'scene.fog.explore'],
  ['fog.hide', 'scene.fog.hide'],
  ['fog.reset', 'scene.fog.reset'],
  ['combat.replace', 'combat.replace'],
  ['combat.advance', 'combat.advance'],
  ['chat.append', 'chat.append'],
  ['chat.clear', 'chat.clear'],
  ['status.apply', 'status.apply'],
  ['status.remove', 'status.remove'],
  ['status.setStacks', 'status.setStacks'],
  ['status.batch', 'status.batch'],
  ['status.definition.upsert', 'status.definition.upsert'],
  ['status.definition.delete', 'status.definition.delete'],
  ['status.definition.import', 'status.definition.import'],
]);

function fail(message, code = 'invalid_document_operation') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function identifier(value, label) {
  const result = String(value ?? '').trim();
  if (!result) fail(`${label} requires an id`);
  if (result.length > 160) fail(`${label} is too long`, 'document_operation_limit');
  return result;
}

function finitePoint(value, label) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`${label} must contain finite x/y`);
  return { x, y };
}

export function normalizeDocumentWrite(raw, label = 'write') {
  if (!plainObject(raw)) fail(`${label} must be an object`);
  const action = String(raw.action || '');
  if (!ACTIONS.has(action)) fail(`${label}.action is unsupported`);
  if (!plainObject(raw.document)) fail(`${label}.document must be an object`);
  const type = String(raw.document.type || '');
  if (!DOCUMENT_TYPES.has(type)) fail(`${label}.document.type is unsupported`);
  const id = identifier(raw.document.id, `${label}.document.id`);
  let parent = null;
  if (raw.document.parent != null) {
    if (!plainObject(raw.document.parent)) fail(`${label}.document.parent must be an object or null`);
    parent = {
      type: identifier(raw.document.parent.type, `${label}.document.parent.type`),
      id: identifier(raw.document.parent.id, `${label}.document.parent.id`),
    };
  }
  const intent = String(raw.intent || '');
  if (!INTENT_TO_OPERATION.has(intent)) fail(`Unsupported document intent: ${intent || '(missing)'}`, 'unknown_document_intent');
  if (raw.data != null && !plainObject(raw.data)) fail(`${label}.data must be an object`);
  if (raw.precondition != null && !plainObject(raw.precondition)) fail(`${label}.precondition must be an object`);
  return {
    action,
    document: { type, id, parent },
    intent,
    data: structuredClone(raw.data || {}),
    precondition: structuredClone(raw.precondition || {}),
  };
}

export function assertDocumentBatchMessage(raw) {
  if (!plainObject(raw) || raw.type !== 'document.batch') fail('message.type must be document.batch', 'unknown_message');
  if (Number(raw.operationSchema) !== DOCUMENT_OPERATION_SCHEMA_VERSION) {
    fail(`Document operation schema ${DOCUMENT_OPERATION_SCHEMA_VERSION} is required`, 'operation_schema_incompatible');
  }
  const operationId = identifier(raw.operationId, 'operationId');
  if (!Number.isSafeInteger(Number(raw.baseRevision)) || Number(raw.baseRevision) < 0) {
    fail('document.batch requires a non-negative baseRevision', 'invalid_revision');
  }
  if (!Array.isArray(raw.writes) || !raw.writes.length || raw.writes.length > DOCUMENT_BATCH_LIMIT) {
    fail(`document.batch must contain 1-${DOCUMENT_BATCH_LIMIT} writes`, 'document_operation_limit');
  }
  return {
    operationId,
    baseRevision: Number(raw.baseRevision),
    writes: raw.writes.map((write, index) => normalizeDocumentWrite(write, `writes[${index}]`)),
  };
}

function withAddress(write) {
  const payload = structuredClone(write.data || {});
  const { type, id, parent } = write.document;
  if (type === 'Actor') payload.actorId ??= id;
  if (type === 'Token') {
    payload.tokenId ??= id;
    if (parent?.type === 'Scene') payload.sceneId ??= parent.id;
  }
  if (type === 'Scene') payload.sceneId ??= id;
  if (type === 'Fog') payload.sceneId ??= parent?.type === 'Scene' ? parent.id : id;
  return payload;
}

export function documentWritesToWorldOperations(rawWrites) {
  if (!Array.isArray(rawWrites) || !rawWrites.length || rawWrites.length > DOCUMENT_BATCH_LIMIT) {
    fail(`writes must contain 1-${DOCUMENT_BATCH_LIMIT} items`, 'document_operation_limit');
  }
  return rawWrites.map((raw, index) => {
    const write = normalizeDocumentWrite(raw, `writes[${index}]`);
    const type = INTENT_TO_OPERATION.get(write.intent);
    const payload = withAddress(write);
    if (type === 'token.movePath') {
      const tokenIds = [...new Set((Array.isArray(payload.tokenIds) ? payload.tokenIds : [write.document.id])
        .map(value => identifier(value, 'tokenId')))];
      if (!tokenIds.includes(write.document.id)) tokenIds.unshift(write.document.id);
      if (tokenIds.length > DOCUMENT_BATCH_LIMIT) fail('token.movePath has too many Token targets', 'document_operation_limit');
      const waypoints = (Array.isArray(payload.waypoints) ? payload.waypoints : [])
        .map((point, pointIndex) => finitePoint(point, `waypoints[${pointIndex}]`));
      if (!waypoints.length || waypoints.length > DOCUMENT_MOVE_POINT_LIMIT) {
        fail(`token.movePath requires 1-${DOCUMENT_MOVE_POINT_LIMIT} waypoints`, 'document_operation_limit');
      }
      payload.tokenIds = tokenIds;
      payload.waypoints = waypoints;
      payload.method = payload.method === 'keyboard' ? 'keyboard' : 'drag';
      payload.expectedOrigins = plainObject(write.precondition.expectedOrigins)
        ? structuredClone(write.precondition.expectedOrigins)
        : structuredClone(payload.expectedOrigins || {});
    }
    return { type, payload };
  });
}

function ids(items) {
  return new Set((Array.isArray(items) ? items : []).map(item => String(item?.id ?? item ?? '')).filter(Boolean));
}

function changedFields(before, after) {
  const result = {};
  const previous = plainObject(before) ? before : {};
  for (const [field, value] of Object.entries(plainObject(after) ? after : {})) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(value)) result[field] = structuredClone(value);
  }
  return result;
}

export function createDocumentChanges(beforeState, afterState, patch, { motion = [] } = {}) {
  const beforeWorld = beforeState?.preferences?.worldV2 || {};
  const afterWorld = afterState?.preferences?.worldV2 || {};
  const beforeActors = ids(beforeWorld.actors);
  const beforeActorsById = new Map((beforeWorld.actors || []).map(actor => [String(actor.id), actor]));
  const beforeScenes = new Map((beforeWorld.scenes || []).map(scene => [String(scene.id), scene]));
  const movedTokenIds = new Set((motion || []).map(item => String(item?.tokenId ?? '')).filter(Boolean));
  const changes = [];
  for (const actor of patch?.world?.actors?.upsert || []) {
    const created = !beforeActors.has(String(actor.id));
    changes.push({
      action: created ? 'create' : 'update',
      document: { type: 'Actor', id: String(actor.id), parent: null },
      changed: created ? structuredClone(actor) : changedFields(beforeActorsById.get(String(actor.id)), actor),
    });
  }
  for (const id of patch?.world?.actors?.remove || []) changes.push({ action: 'delete', document: { type: 'Actor', id: String(id), parent: null }, changed: null });
  for (const scene of patch?.world?.scenes?.upsert || []) {
    const beforeScene = beforeScenes.get(String(scene.id));
    changes.push({
      action: beforeScene ? 'update' : 'create',
      document: { type: 'Scene', id: String(scene.id), parent: null },
      changed: beforeScene ? changedFields(beforeScene, scene) : structuredClone(scene),
    });
  }
  for (const id of patch?.world?.scenes?.remove || []) changes.push({ action: 'delete', document: { type: 'Scene', id: String(id), parent: null }, changed: null });
  for (const tokenPatch of patch?.world?.scenes?.tokens || []) {
    const beforeTokens = new Map((beforeScenes.get(String(tokenPatch.sceneId))?.tokens || [])
      .map(token => [String(token.id), token]));
    for (const token of tokenPatch.upsert || []) {
      const beforeToken = beforeTokens.get(String(token.id));
      changes.push({
        action: beforeToken ? (movedTokenIds.has(String(token.id)) ? 'move' : 'update') : 'create',
        document: { type: 'Token', id: String(token.id), parent: { type: 'Scene', id: String(tokenPatch.sceneId) } },
        changed: beforeToken ? changedFields(beforeToken, token) : structuredClone(token),
      });
    }
    for (const id of tokenPatch.remove || []) changes.push({ action: 'delete', document: { type: 'Token', id: String(id), parent: { type: 'Scene', id: String(tokenPatch.sceneId) } }, changed: null });
  }
  const beforeChat = ids(beforeState?.preferences?.chatSystem?.messages);
  for (const message of afterState?.preferences?.chatSystem?.messages || []) {
    if (!beforeChat.has(String(message.id))) changes.push({ action: 'append', document: { type: 'ChatMessage', id: String(message.id), parent: null }, changed: structuredClone(message) });
  }
  if (patch?.combatSystem !== undefined) changes.push({ action: 'update', document: { type: 'Combat', id: 'active', parent: null }, changed: structuredClone(patch.combatSystem) });
  for (const fog of patch?.world?.scenes?.fog || []) changes.push({ action: 'update', document: { type: 'Fog', id: String(fog.sceneId), parent: { type: 'Scene', id: String(fog.sceneId) } }, changed: structuredClone(fog.fog) });
  return changes;
}
