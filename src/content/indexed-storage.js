import { inspectImage } from './image.js';
import { CONTENT_ID } from './references.js';

export function createIndexedContentStorage(indexedDB = globalThis.indexedDB, { worldId = 'default' } = {}) {
  let connection;
  const open = () => connection ||= new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('content_storage_unavailable')); return; }
    const request = indexedDB.open(`rpgmap-content-v1:${encodeURIComponent(worldId)}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
    request.onerror = () => { connection = null; reject(request.error); };
    request.onblocked = () => { connection = null; reject(new Error('content_storage_blocked')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
  });
  const transaction = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode);
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('content_storage_failed'));
      try { action(tx.objectStore('records'), value => { result = value; }, error => { failure = error; tx.abort(); }); }
      catch (error) { tx.abort(); reject(error); }
    });
  };
  return {
    async put(blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer()), metadata = inspectImage(bytes, blob.type);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      const id = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      const record = { id, ...metadata, blob: new Blob([bytes], { type: metadata.type }) };
      await transaction('readwrite', (store, _done, fail) => {
        const request = store.get(id);
        request.onsuccess = () => {
          try { if (!request.result) store.add(record); } catch (error) { fail(error); }
        };
      });
      return { id, reference: `asset:${id}`, ...metadata };
    },
    async get(id) {
      if (!CONTENT_ID.test(id)) throw new Error('content_not_found');
      const record = await transaction('readonly', (store, done) => { store.get(id).onsuccess = event => done(event.target.result); });
      if (!record) throw new Error('content_not_found');
      const bytes = new Uint8Array(await record.blob.arrayBuffer());
      inspectImage(bytes, record.type);
      const hash = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== id) throw new Error('content_corrupt');
      return record.blob;
    },
    list: () => transaction('readonly', (store, done) => {
      store.getAll().onsuccess = event => done(event.target.result.map(({ blob, ...record }) => ({ ...record, reference: `asset:${record.id}` })));
    }),
    remove: id => transaction('readwrite', store => {
      if (!CONTENT_ID.test(id)) throw new Error('content_not_found');
      store.delete(id);
    }),
  };
}
