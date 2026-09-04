import {
  DOCUMENT_OPERATION_SCHEMA_VERSION,
  documentWritesToWorldOperations,
  normalizeDocumentWrite,
} from './protocol.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function key(address) {
  const parent = address?.parent ? `${address.parent.type}:${address.parent.id}/` : '';
  return `${parent}${address?.type || ''}:${address?.id || ''}`;
}

function currentDocuments(api) {
  const world = api.world?.get?.() || {};
  const values = [];
  for (const actor of world.actors || []) values.push([{ type: 'Actor', id: String(actor.id), parent: null }, actor]);
  for (const scene of world.scenes || []) {
    values.push([{ type: 'Scene', id: String(scene.id), parent: null }, scene]);
    values.push([{ type: 'Fog', id: String(scene.id), parent: { type: 'Scene', id: String(scene.id) } }, scene.fog || null]);
    for (const token of scene.tokens || []) values.push([{ type: 'Token', id: String(token.id), parent: { type: 'Scene', id: String(scene.id) } }, token]);
  }
  for (const message of api.getState?.()?.preferences?.chatSystem?.messages || []) {
    values.push([{ type: 'ChatMessage', id: String(message.id), parent: null }, message]);
  }
  values.push([{ type: 'Combat', id: 'active', parent: null }, api.getState?.()?.preferences?.combatSystem || null]);
  return values;
}

export function createDocumentBackendSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.world || api.documents) return;
      const collection = new Map();

      function rebuild() {
        collection.clear();
        for (const [address, value] of currentDocuments(api)) collection.set(key(address), clone(value));
      }

      function updateCollection(change) {
        const address = change?.document;
        if (!address?.type || !address?.id) return;
        const addressKey = key(address);
        if (change.action === 'delete') collection.delete(addressKey);
        else if (change.action === 'create' || change.action === 'append' || !collection.has(addressKey)) {
          collection.set(addressKey, clone(change.changed));
        } else {
          const previous = collection.get(addressKey);
          collection.set(addressKey, previous && typeof previous === 'object' && !Array.isArray(previous)
            ? { ...clone(previous), ...clone(change.changed || {}) }
            : clone(change.changed));
        }
      }

      function emitChanges(changes, { revision = null, operationId = null } = {}) {
        const values = Array.isArray(changes) ? changes : [];
        for (const change of values) {
          updateCollection(change);
          const action = change.action === 'append' ? 'update' : change.action;
          api.emit?.(`document:${action}`, {
            document: clone(change.document),
            changed: clone(change.changed),
            revision,
            operationId,
          });
        }
      }

      async function dispatchBatch(rawWrites, { atomic = true, requestedOperationId = null } = {}) {
        if (atomic !== true) {
          const error = new Error('Atomic batch required');
          error.code = 'document_batch_atomic_required';
          throw error;
        }
        const writes = (Array.isArray(rawWrites) ? rawWrites : [])
          .map((write, index) => normalizeDocumentWrite(write, `writes[${index}]`));
        if (!writes.length) return { unchanged: true, results: [] };
        const multiplayer = api.multiplayer?.getStatus?.();
        if (multiplayer?.connected && typeof api.multiplayer?.performDocumentBatch === 'function') {
          return api.multiplayer.performDocumentBatch(writes, { requestedOperationId });
        }
        const operations = documentWritesToWorldOperations(writes);
        const result = await api.world.performOperations(operations, {
          source: 'document.batch',
          render: false,
          kind: 'document',
          requestedOperationId,
        });
        rebuild();
        emitChanges(writes.map(write => ({
          action: write.action,
          document: write.document,
          changed: collection.get(key(write.document)) ?? null,
        })), { operationId: result?.operationId || requestedOperationId });
        return result;
      }

      rebuild();
      api.documents = Object.freeze({
        schemaVersion: DOCUMENT_OPERATION_SCHEMA_VERSION,
        dispatch(write, options = {}) { return dispatchBatch([write], options); },
        dispatchBatch,
        applyCommitted(changes, metadata = {}) {
          emitChanges(changes, metadata);
        },
      });
      api.on?.('state:import', rebuild);
      api.on?.('scene:activate', rebuild);
    },
  });
}

export {
  DOCUMENT_BATCH_LIMIT,
  DOCUMENT_MOVE_POINT_LIMIT,
  DOCUMENT_OPERATION_SCHEMA_VERSION,
  assertDocumentBatchMessage,
  createDocumentChanges,
  documentWritesToWorldOperations,
  normalizeDocumentWrite,
} from './protocol.js';
