export function createContentDatabase(indexedDB, worldId) {
  let connection;
  const open = () => connection ||= new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('content_storage_unavailable')); return; }
    const request = indexedDB.open(`rpgmap-content-v1:${encodeURIComponent(worldId)}`, 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      for (const name of ['records', 'upgrades']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onerror = () => { connection = null; reject(request.error); };
    request.onblocked = () => { blocked = true; connection = null; reject(new Error('content_storage_blocked')); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
  });
  return async (names, mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode, { durability: 'strict' });
      let result, failure;
      const fail = error => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('content_storage_failed'));
      try { action(Object.fromEntries(names.map(name => [name, tx.objectStore(name)])), value => { result = value; }, fail); }
      catch (error) { fail(error); }
    });
  };
}
