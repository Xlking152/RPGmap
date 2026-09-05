import {
  DOCUMENT_OPERATION_SCHEMA_VERSION,
  documentWritesToWorldOperations,
  normalizeDocumentWrite,
} from './protocol.js';
import { applyDocumentValue, documentEntries, documentKey } from './changes.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function key(address) {
  return documentKey(address);
}

function currentDocuments(api) {
  return documentEntries(api.getState?.() || { preferences: { worldV2: api.world.get() } });
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
        else collection.set(addressKey, applyDocumentValue(collection.get(addressKey), change));
      }

      function emitChanges(changes, { revision = null, operationId = null } = {}) {
        const values = Array.isArray(changes) ? changes : [];
        for (const change of values) {
          updateCollection(change);
          const action = change.action === 'append' ? 'update' : change.action;
          api.emit?.(`document:${action}`, {
            document: clone(change.document),
            action: change.action,
            changed: clone(change.changed),
            removed: clone(change.removed || []),
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
        return result;
      }

      rebuild();
      api.documents = Object.freeze({
        schemaVersion: DOCUMENT_OPERATION_SCHEMA_VERSION,
        get(address) { return clone(collection.get(key(address))); },
        dispatch(write, options = {}) { return dispatchBatch([write], options); },
        dispatchBatch,
        applyCommitted(changes, metadata = {}) {
          emitChanges(changes, metadata);
        },
      });
      api.on?.('state:import', rebuild);
      api.on?.('scene:activate', event => {
        if (!String(event.detail?.source || '').startsWith('document.')) rebuild();
      });
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
