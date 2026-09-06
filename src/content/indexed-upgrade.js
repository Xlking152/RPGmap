import { createContentDatabase } from './database.js';
import { inspectContent } from './body.js';
import { collectContentReferences } from './references.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
const textHash = text => hash(new TextEncoder().encode(JSON.stringify(text)));
const ids = records => records.map(record => record.id).sort().join(',');

async function verifyRecord(record) {
  const bytes = new Uint8Array(await record.blob.arrayBuffer());
  const metadata = inspectContent(bytes, record.type);
  if (await hash(bytes) !== record.id || Object.entries(metadata).some(([key, value]) => JSON.stringify(record[key] ?? (key === 'kind' ? 'asset' : null)) !== JSON.stringify(value))) fail('upgrade_backup_corrupt');
}

export function createIndexedWorldUpgrade({ indexedDB = globalThis.indexedDB, worldId, storageAdapter, storageKey } = {}) {
  const database = createContentDatabase(indexedDB, worldId);
  const read = () => database(['records', 'upgrades'], 'readonly', ({ records, upgrades }, done) => {
    records.getAll().onsuccess = event => {
      const current = event.target.result;
      upgrades.get('pending').onsuccess = event => {
        const pending = event.target.result;
        if (!pending) { done({ current }); return; }
        upgrades.get(pending.backupId).onsuccess = event => done({ current, backup: event.target.result, pending });
      };
    };
  });

  async function recover() {
    const { current, backup, pending } = await read();
    if (!pending) return null;
    if (!backup || backup.storageKey !== storageKey || !Array.isArray(backup.before) || !Array.isArray(backup.addedIds)
      || await textHash([backup.beforeRaw, backup.afterRaw, backup.inputRaw, ids(backup.before), backup.addedIds]) !== backup.hash) fail('upgrade_backup_corrupt');
    const raw = storageAdapter.get(storageKey);
    if (raw !== backup.beforeRaw && raw !== backup.afterRaw) fail('upgrade_recovery_conflict');
    if (ids(current) !== [...backup.before.map(record => record.id), ...backup.addedIds].sort().join(',')) fail('upgrade_recovery_conflict');
    for (const record of [...backup.before, ...current]) await verifyRecord(record);
    // Restore the World first. If IndexedDB aborts, the next load repeats this
    // rollback; original dependencies are never removed while World uses them.
    await database(['records', 'upgrades'], 'readwrite', ({ records, upgrades }, done, abort) => {
      records.getAll().onsuccess = event => {
        try {
          if (ids(event.target.result) !== ids(current) || storageAdapter.get(storageKey) !== raw) fail('upgrade_recovery_conflict');
          if (backup.beforeRaw === null) storageAdapter.remove(storageKey);
          else storageAdapter.set(storageKey, backup.beforeRaw);
          for (const record of backup.before) records.put(record);
          for (const id of backup.addedIds) records.delete(id);
          upgrades.delete('pending');
          done(backup.id);
        } catch (error) { abort(error); }
      };
    });
    return backup.id;
  }

  async function commit({ beforeRaw, afterRaw, inputRaw = beforeRaw, records: incoming = [], onStep = () => {} }) {
    const { current, pending } = await read();
    if (pending) fail('content_upgrade_pending');
    if (storageAdapter.get(storageKey) !== beforeRaw) fail('upgrade_source_changed');
    const records = [];
    for (const entry of incoming) {
      const bytes = entry.bytes || new Uint8Array(await entry.blob.arrayBuffer());
      const metadata = inspectContent(bytes, entry.type || entry.blob.type);
      const id = await hash(bytes);
      if (entry.id && entry.id !== id) fail('content_corrupt');
      records.push({ id, ...metadata, blob: new Blob([bytes], { type: metadata.type }) });
    }
    for (const record of current) await verifyRecord(record);
    const byId = new Map(current.map(record => [record.id, record]));
    const additions = new Map(records.filter(record => !byId.has(record.id)).map(record => [record.id, record]));
    const all = new Map([...byId, ...additions]);
    for (const reference of collectContentReferences(JSON.parse(afterRaw)).keys()) {
      const [kind, id] = reference.split(':');
      if ((all.get(id)?.kind || (all.has(id) ? 'asset' : null)) !== kind) fail('content_not_found');
    }
    for (const record of records) for (const ref of record.dependencies || []) if (all.get(ref.slice(6))?.kind !== 'asset') fail('content_not_found');
    const backup = { id: crypto.randomUUID(), storageKey, beforeRaw, afterRaw, inputRaw, before: current, addedIds: [...additions.keys()] };
    backup.hash = await textHash([beforeRaw, afterRaw, inputRaw, ids(current), backup.addedIds]);
    await onStep('prepared');
    await database(['records', 'upgrades'], 'readwrite', ({ records, upgrades }, _done, abort) => {
      upgrades.get('pending').onsuccess = event => {
        if (event.target.result) { abort(new Error('content_upgrade_pending')); return; }
        records.getAll().onsuccess = event => {
          try {
            if (ids(event.target.result) !== ids(current) || storageAdapter.get(storageKey) !== beforeRaw) fail('upgrade_source_changed');
            upgrades.add(backup);
            upgrades.add({ id: 'pending', backupId: backup.id });
            for (const record of additions.values()) records.add(record);
          } catch (error) { abort(error); }
        };
      };
    });
    await onStep('content-committed');
    if (storageAdapter.get(storageKey) !== beforeRaw) fail('upgrade_source_changed');
    storageAdapter.set(storageKey, afterRaw);
    await onStep('world-committed');
    await database(['upgrades'], 'readwrite', ({ upgrades }) => { upgrades.delete('pending'); });
    return backup.id;
  }
  return Object.freeze({ commit, recover });
}
