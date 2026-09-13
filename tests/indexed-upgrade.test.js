import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createIndexedWorldUpgrade } from '../src/content/indexed-upgrade.js';
import { createIndexedContentStorage } from '../src/content/indexed-storage.js';
import { createContentDatabase } from '../src/content/database.js';
import { createMemoryStorage } from '../src/app/storage-adapter.js';
import { prepareInlineImageMigration } from '../src/content/migration.js';
import { prepareStoredWorldWithContent, persistPreparedWorldContent } from '../src/app/world-upgrade.js';
import { prepareStoredWorldState, worldStateStorageKey } from '../src/app/world-storage.js';
import { exportRuntimeState } from '../src/engine/runtime-state.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { createDefaultActor } from '../src/actor/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc8AAAAASUVORK5CYII=', 'base64');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

async function fixture() {
  const indexedDB = new IDBFactory(), storageAdapter = createMemoryStorage();
  const options = { indexedDB, storageAdapter, worldId: 'test', storageKey: 'world' };
  const beforeRaw = JSON.stringify({ img: dataUrl, extension: { keep: 1 } });
  const prepared = await prepareInlineImageMigration(beforeRaw);
  const upgrade = createIndexedWorldUpgrade(options);
  const content = createIndexedContentStorage(indexedDB, options);
  storageAdapter.set('world', beforeRaw);
  return { ...options, upgrade, content, database: createContentDatabase(indexedDB, 'test'),
    commit: { beforeRaw, afterRaw: JSON.stringify(prepared.state), records: prepared.records }, id: prepared.records[0].id };
}

test('offline upgrade preserves the original World and content before publishing references', async () => {
  const f = await fixture();
  const id = await f.upgrade.commit({ ...f.commit, async onStep(step) {
    if (step === 'prepared') assert.deepEqual(await f.content.list(), []);
    if (step === 'content-committed') {
      assert.equal(f.storageAdapter.get('world'), f.commit.beforeRaw);
      assert.deepEqual(Buffer.from(await (await f.content.get(f.id)).arrayBuffer()), png);
      await assert.rejects(f.content.put(new Blob([png], { type: 'image/png' })), /content_upgrade_pending/);
      await assert.rejects(f.content.remove(f.id), /content_upgrade_pending/);
    }
  } });
  assert.equal(f.storageAdapter.get('world'), f.commit.afterRaw);
  assert.equal(await f.upgrade.recover(), null);
  const backup = await f.database(['upgrades'], 'readonly', ({ upgrades }, done) => { upgrades.get(id).onsuccess = event => done(event.target.result); });
  assert.equal(backup.beforeRaw, f.commit.beforeRaw);
  assert.equal(backup.inputRaw, f.commit.beforeRaw);
  assert.deepEqual(backup.addedIds, [f.id]);
  await assert.rejects(f.content.remove(f.id), /content_in_use/);
});

for (const interruption of ['content-committed', 'world-committed']) {
  test(`offline restart after ${interruption} restores the original World and all dependencies`, async () => {
    const f = await fixture();
    const original = await f.content.put(new Blob([png], { type: 'image/png' }));
    await assert.rejects(f.upgrade.commit({ ...f.commit, onStep(step) { if (step === interruption) throw new Error('crash'); } }), /crash/);
    const reopened = createIndexedWorldUpgrade(f);
    assert.ok(await reopened.recover());
    assert.equal(f.storageAdapter.get('world'), f.commit.beforeRaw);
    assert.deepEqual(Buffer.from(await (await f.content.get(original.id)).arrayBuffer()), png);
    assert.equal(await reopened.recover(), null);
    await assert.rejects(f.content.remove(original.id), /content_in_use/);
  });
}

test('rollback removes only upgrade-created records and can resume after a World-write failure', async () => {
  const f = await fixture();
  const originalSet = f.storageAdapter.set;
  f.storageAdapter.set = (key, value) => {
    if (value === f.commit.afterRaw) throw new DOMException('quota', 'QuotaExceededError');
    originalSet(key, value);
  };
  await assert.rejects(f.upgrade.commit(f.commit), { name: 'QuotaExceededError' });
  assert.equal(f.storageAdapter.get('world'), f.commit.beforeRaw);
  assert.equal((await f.content.list()).length, 1);
  await f.upgrade.recover();
  assert.deepEqual(await f.content.list(), []);
  assert.equal(f.storageAdapter.get('world'), f.commit.beforeRaw);
});

test('IndexedDB quota or commit abort cannot publish World or leave partial image records', async () => {
  for (const storeName of ['records', 'upgrades']) {
    const f = await fixture();
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      const result = original.apply(this, args);
      if (this.name === storeName) this.transaction.abort();
      return result;
    };
    try { await assert.rejects(f.upgrade.commit(f.commit)); }
    finally { IDBObjectStore.prototype.add = original; }
    assert.equal(f.storageAdapter.get('world'), f.commit.beforeRaw);
    assert.deepEqual(await f.content.list(), []);
    assert.equal(await f.upgrade.recover(), null);
  }
});

test('recovery rejects changed World and corrupt backup bytes without overwriting user data', async () => {
  const f = await fixture();
  await assert.rejects(f.upgrade.commit({ ...f.commit, onStep(step) { if (step === 'world-committed') throw new Error('crash'); } }), /crash/);
  f.storageAdapter.set('world', 'user edit');
  await assert.rejects(f.upgrade.recover(), { code: 'upgrade_recovery_conflict' });
  assert.equal(f.storageAdapter.get('world'), 'user edit');
  f.storageAdapter.set('world', f.commit.afterRaw);
  await f.database(['upgrades'], 'readwrite', ({ upgrades }) => {
    upgrades.getAll().onsuccess = event => {
      const backup = event.target.result.find(record => record.id !== 'pending');
      backup.beforeRaw = 'corrupt'; upgrades.put(backup);
    };
  });
  await assert.rejects(f.upgrade.recover(), { code: 'upgrade_backup_corrupt' });
  assert.equal(f.storageAdapter.get('world'), f.commit.afterRaw);
});

test('upgrade CAS, missing dependencies and invalid content fail before any writes', async () => {
  const f = await fixture();
  await assert.rejects(f.upgrade.commit({ ...f.commit, beforeRaw: 'stale' }), { code: 'upgrade_source_changed' });
  await assert.rejects(f.upgrade.commit({ ...f.commit, records: [] }), { code: 'content_not_found' });
  await assert.rejects(f.upgrade.commit({ ...f.commit, records: [{ ...f.commit.records[0], id: 'bad' }] }), { code: 'content_corrupt' });
  assert.deepEqual(await f.content.list(), []);
  assert.equal(f.storageAdapter.get('world'), f.commit.beforeRaw);
});

test('a pending rollback never silently discards newly added content from outside the transaction', async () => {
  const f = await fixture();
  await assert.rejects(f.upgrade.commit({ ...f.commit, onStep(step) { if (step === 'content-committed') throw new Error('crash'); } }), /crash/);
  await f.database(['records'], 'readwrite', ({ records }) => { records.add({ id: 'user-content', blob: new Blob(['keep']) }); });
  await assert.rejects(f.upgrade.recover(), { code: 'upgrade_recovery_conflict' });
  assert.equal((await f.content.list()).length, 2);
});

test('production offline bootstrap extracts images before Actor normalization and does not migrate twice', async () => {
  const options = { indexedDB: new IDBFactory(), worldId: 'test', storageAdapter: createMemoryStorage(),
    mapPackage: { id: 'test', version: '1.0.0', title: 'Test' }, ruleset: infiniteHorrorRuleset };
  const initial = prepareStoredWorldState({ ...options, raw: null });
  const actor = createDefaultActor({ id: 'a', name: 'Image' }, options.ruleset);
  initial.state.preferences.worldV2.actors.push(actor);
  const state = exportRuntimeState(initial.state, options);
  state.preferences.worldV2.actors[0].img = dataUrl;
  state.preferences.worldV2.actors[0].notes = 'retain';
  const raw = JSON.stringify(state), key = worldStateStorageKey({ worldId: 'test' });
  options.storageAdapter.set(key, raw);
  const loaded = await prepareStoredWorldWithContent({ ...options, raw });
  assert.match(loaded.state.preferences.worldV2.actors[0].img, /^asset:/);
  assert.equal(loaded.state.preferences.worldV2.actors[0].notes, 'retain');
  assert.equal(loaded.notice.type, 'success');
  const once = options.storageAdapter.get(key);
  const again = await prepareStoredWorldWithContent({ ...options, raw: once });
  assert.equal(again.notice, null);
  assert.equal(options.storageAdapter.get(key), once);
  const database = createContentDatabase(options.indexedDB, 'test');
  const backups = await database(['upgrades'], 'readonly', ({ upgrades }, done) => { upgrades.getAll().onsuccess = event => done(event.target.result); });
  assert.equal(backups.length, 1);
  assert.equal(backups[0].beforeRaw, raw);
});

test('production offline bootstrap stops on damaged images without normalizing or overwriting the save', async () => {
  const options = { indexedDB: new IDBFactory(), worldId: 'damaged', storageAdapter: createMemoryStorage(),
    mapPackage: { id: 'test', version: '1.0.0' }, ruleset: infiniteHorrorRuleset };
  const key = worldStateStorageKey({ worldId: options.worldId });
  const raw = JSON.stringify({ preferences: { worldV2: { actors: [{ img: 'data:image/png;base64,broken' }] } } });
  options.storageAdapter.set(key, raw);
  await assert.rejects(prepareStoredWorldWithContent({ ...options, raw }), { code: 'invalid_image_data_url' });
  assert.equal(options.storageAdapter.get(key), raw);
  assert.deepEqual(await createIndexedContentStorage(options.indexedDB, options).list(), []);
});

test('failed import rollback explicitly blocks further runtime writes until recovery', async () => {
  const options = { indexedDB: new IDBFactory(), worldId: 'recovery', storageAdapter: createMemoryStorage(),
    mapPackage: { id: 'test', version: '1.0.0' }, ruleset: infiniteHorrorRuleset };
  const state = prepareStoredWorldState({ ...options, raw: null }).state;
  const beforeRaw = JSON.stringify(exportRuntimeState(state, options));
  const key = worldStateStorageKey({ worldId: options.worldId });
  options.storageAdapter.set(key, beforeRaw);
  const original = options.storageAdapter.set;
  options.storageAdapter.set = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  await assert.rejects(persistPreparedWorldContent({ ...options, state, beforeRaw, inputRaw: beforeRaw }), error => {
    assert.equal(error.name, 'QuotaExceededError'); assert.equal(error.recoveryRequired, true); return true;
  });
  assert.equal(options.storageAdapter.get(key), beforeRaw);
  options.storageAdapter.set = original;
  assert.ok(await createIndexedWorldUpgrade({ ...options, storageKey: key }).recover());
});
