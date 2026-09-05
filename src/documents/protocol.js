import { assertDocumentJson } from './changes.js';

export const DOCUMENT_OPERATION_SCHEMA_VERSION = 4;
export const DOCUMENT_BATCH_LIMIT = 64;
export const DOCUMENT_MOVE_POINT_LIMIT = 64;

const ACTIONS = new Set(['create', 'update', 'delete', 'move', 'append']);
const DOCUMENT_TYPES = new Set([
  'World', 'Actor', 'Token', 'Scene', 'Marker', 'ChatMessage', 'Combat', 'Status', 'Fog',
]);

const INTENT_TO_OPERATION = new Map([
  ['world.rename', 'world.rename'],
  ['actor.upsert', 'actor.upsert'],
  ['actor.metadata.update', 'actor.metadata.update'],
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
  ['token.move', 'token.move'],
  ['marker.upsert', 'marker.upsert'],
  ['marker.move', 'marker.move'],
  ['marker.delete', 'marker.delete'],
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
  try {
    assertDocumentJson(raw.data || {});
    assertDocumentJson(raw.precondition || {});
  } catch { fail(`${label} must contain bounded safe JSON`, 'invalid_document_operation'); }
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
  if (type === 'Marker') {
    payload.markerId ??= id;
    if (parent?.type === 'Scene') payload.sceneId ??= parent.id;
  }
  const targetType = write.intent === 'actor.runtime.perform' && payload.tokenId ? 'Token'
    : write.intent.startsWith('actor.') ? 'Actor'
      : write.intent.startsWith('token.') ? 'Token'
        : write.intent.startsWith('marker.') ? 'Marker'
          : write.intent.startsWith('scene.') ? 'Scene'
            : write.intent.startsWith('fog.') ? 'Fog'
              : write.intent.startsWith('status.') ? 'Status'
                : write.intent.startsWith('chat.') ? 'ChatMessage'
                  : write.intent.startsWith('combat.') ? 'Combat' : 'World';
  if (type !== targetType) fail('Document type does not match intent', 'document_target_mismatch');
  const targetId = type === 'Actor' ? payload.actor?.id ?? payload.actorId
    : type === 'Token' ? payload.token?.id ?? payload.tokenId
      : type === 'Scene' ? payload.scene?.id ?? payload.sceneId
        : type === 'Marker' ? payload.marker?.id ?? payload.markerId : null;
  if (targetId != null && String(targetId) !== id) fail('Document id does not match payload', 'document_target_mismatch');
  if (parent && (!['Token', 'Marker', 'Status', 'Fog'].includes(type) || parent.type !== 'Scene'
    || (payload.sceneId != null && String(payload.sceneId) !== parent.id))) {
    fail('Document parent does not match payload', 'document_target_mismatch');
  }
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
    if (type === 'actor.delete' && payload.deleteReferencedTokens !== true) {
      fail('actor.delete must explicitly confirm deletion of referenced Tokens', 'actor_delete_confirmation_required');
    }
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

export { createDocumentChanges } from './changes.js';

export function worldOperationsToDocumentWrites(operations, { worldId, sceneId, operationId = 'operation' } = {}) {
  const intents = new Map([...INTENT_TO_OPERATION].map(([intent, type]) => [type, intent]));
  return operations.map((operation, index) => {
    const type = operation.type;
    const data = structuredClone(operation.payload || {});
    const intent = intents.get(type);
    if (!intent) fail(`Unsupported document operation: ${type}`, 'unknown_document_intent');
    let documentType;
    let id;
    let parent = null;
    if (type === 'actor.runtime.perform' && data.tokenId) {
      documentType = 'Token'; id = data.tokenId;
    } else if (type.startsWith('actor.')) { documentType = 'Actor'; id = data.actor?.id ?? data.actorId; }
    else if (type.startsWith('token.')) { documentType = 'Token'; id = data.token?.id ?? data.tokenId; }
    else if (type.startsWith('marker.')) { documentType = 'Marker'; id = data.marker?.id ?? data.markerId; }
    else if (type.startsWith('scene.fog.')) { documentType = 'Fog'; id = data.sceneId ?? sceneId; }
    else if (type.startsWith('scene.')) { documentType = 'Scene'; id = data.scene?.id ?? data.sceneId ?? sceneId; }
    else if (type.startsWith('status.')) { documentType = 'Status'; id = data.targetId ?? data.definition?.id ?? data.statusId ?? 'definitions'; }
    else if (type.startsWith('chat.')) { documentType = 'ChatMessage'; id = data.id ?? `${operationId}:${index}`; }
    else if (type.startsWith('combat.')) { documentType = 'Combat'; id = 'active'; }
    else { documentType = 'World'; id = worldId; }
    if (['Token', 'Marker', 'Fog'].includes(documentType)) parent = { type: 'Scene', id: String(data.sceneId ?? sceneId) };
    const action = type.endsWith('.delete') || type === 'chat.clear' ? 'delete'
      : type === 'chat.append' ? 'append'
        : ['token.move', 'token.movePath', 'marker.move'].includes(type) ? 'move' : 'update';
    if (type === 'actor.delete') data.deleteReferencedTokens = true;
    return normalizeDocumentWrite({ action, document: { type: documentType, id: String(id ?? ''), parent }, intent, data });
  });
}
