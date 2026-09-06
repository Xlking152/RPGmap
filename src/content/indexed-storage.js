import { inspectContent } from './body.js';
import { CONTENT_ID } from './references.js';
import { createContentDatabase } from './database.js';

export function createIndexedContentStorage(indexedDB = globalThis.indexedDB, { worldId = 'default' } = {}) {
  const database = createContentDatabase(indexedDB, worldId);
  const transaction = (mode, action) => database(['records', 'upgrades'], mode, ({ records, upgrades }, done, fail) => {
    if (mode === 'readonly') { action(records, done, fail, upgrades); return; }
    upgrades.get('pending').onsuccess = event => {
      if (event.target.result) { fail(new Error('content_upgrade_pending')); return; }
      try { action(records, done, fail, upgrades); } catch (error) { fail(error); }
    };
  });
  return {
    async put(blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer()), metadata = inspectContent(bytes, blob.type);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      const id = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      const record = { id, ...metadata, blob: new Blob([bytes], { type: metadata.type }) };
      await transaction('readwrite', (store, _done, fail) => {
        const publish = () => {
          const request = store.get(id);
          request.onsuccess = () => {
            try { if (!request.result) store.add(record); } catch (error) { fail(error); }
          };
        };
        let remaining = metadata.dependencies?.length || 0;
        if (!remaining) publish();
        else for (const reference of metadata.dependencies) {
          store.get(reference.slice(6)).onsuccess = event => {
            if (!event.target.result || event.target.result.kind === 'body') { fail(new Error('content_not_found')); return; }
            if (!--remaining) publish();
          };
        }
      });
      return { id, reference: `${metadata.kind}:${id}`, ...metadata };
    },
    async get(id) {
      if (!CONTENT_ID.test(id)) throw new Error('content_not_found');
      const record = await transaction('readonly', (store, done) => { store.get(id).onsuccess = event => done(event.target.result); });
      if (!record) throw new Error('content_not_found');
      const bytes = new Uint8Array(await record.blob.arrayBuffer());
      inspectContent(bytes, record.type);
      const hash = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== id) throw new Error('content_corrupt');
      return record.blob;
    },
    list: () => transaction('readonly', (store, done) => {
      store.getAll().onsuccess = event => done(event.target.result.map(({ blob, ...record }) => ({ ...record, reference: `${record.kind || 'asset'}:${record.id}` })));
    }),
    remove: id => transaction('readwrite', (store, _done, fail, upgrades) => {
      if (!CONTENT_ID.test(id)) throw new Error('content_not_found');
      upgrades.getAll().onsuccess = event => {
        if (event.target.result.some(backup => backup.before?.some(record => record.id === id) || backup.addedIds?.includes(id))) {
          fail(new Error('content_in_use')); return;
        }
        store.getAll().onsuccess = event => {
        try {
          if (event.target.result.some(record => record.dependencies?.includes(`asset:${id}`))) { fail(new Error('content_in_use')); return; }
          store.delete(id);
        } catch (error) { fail(error); }
        };
      };
    }),
  };
}
