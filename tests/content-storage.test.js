import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { inspectImage, MAX_IMAGE_BYTES } from '../src/content/image.js';
import { collectContentReferences, contentImageAttributes, readableImageReferences, hasStoredContentReference } from '../src/content/references.js';
import { exportContentArchive, readContentArchive, persistArchiveContent } from '../src/content/archive.js';
import { createIndexedContentStorage } from '../src/content/indexed-storage.js';
import { createContentStorage } from '../deployment/local-server/content-storage.mjs';
import { sendJson } from '../deployment/local-server/http-runtime.mjs';
import { hasRetainedContentReference } from '../deployment/local-server/content-history.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc8AAAAASUVORK5CYII=', 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const reference = `asset:${digest(png)}`;
const makeState = img => ({ preferences: { worldV2: { actors: [{ id: 'actor-a', img }], scenes: [] } } });

test('image container validation checks signature, dimensions, size and declared MIME', () => {
  assert.deepEqual(inspectImage(png), { type: 'image/png', width: 1, height: 1, size: png.length });
  assert.throws(() => inspectImage(png, 'image/jpeg'), { code: 'image_type_mismatch' });
  assert.throws(() => inspectImage(Buffer.from('<svg><script>1</script></svg>')), { code: 'image_type_unsupported' });
  assert.throws(() => inspectImage(new Uint8Array(MAX_IMAGE_BYTES + 1)), { code: 'image_size_exceeded' });
  const large = Buffer.from(png); large.writeUInt32BE(8193, 16);
  assert.throws(() => inspectImage(large), { code: 'image_dimensions_exceeded' });
  assert.throws(() => inspectImage(png.subarray(0, -2)), { code: 'invalid_image' });
  const badChunk = Buffer.from(png); badChunk.writeUInt32BE(0xffffffff, 33);
  assert.throws(() => inspectImage(badChunk), { code: 'invalid_image' });
});

test('WebP and JPEG headers are bounded and cannot substitute a claimed MIME or size', () => {
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8 ', 8);
  webp.writeUInt32LE(10, 16); webp.set([157, 1, 42], 23); webp.writeUInt16LE(17, 26); webp.writeUInt16LE(29, 28);
  assert.equal(inspectImage(webp).height, 29);
  webp.writeUInt16LE(8193, 26); assert.throws(() => inspectImage(webp), { code: 'image_dimensions_exceeded' });
  const jpeg = Buffer.from([255,216,255,192,0,11,8,0,25,0,30,1,1,17,0,255,218,0,8,1,1,0,0,63,0,42,255,217]);
  assert.deepEqual(inspectImage(jpeg), { type: 'image/jpeg', width: 30, height: 25, size: jpeg.length });
  jpeg[5] = 0; assert.throws(() => inspectImage(jpeg));
});

test('read grants come from projected image fields, not chat text or guessed references', () => {
  const state = makeState(reference);
  state.preferences.chatLog = { messages: [{ text: `asset:${'b'.repeat(64)}` }] };
  state.preferences.worldV2.actors[0].notes = `asset:${'c'.repeat(64)}`;
  assert.deepEqual([...readableImageReferences(state).keys()], [reference]);
  assert.equal(collectContentReferences(state).size, 3);
  assert.equal(contentImageAttributes(reference, x => x), `data-content-ref="${reference}"`);
  assert.equal(contentImageAttributes('test.png', x => x), 'src="test.png"');
});

test('content HTTP rechecks authentication, projection, reference grants and deletion authority', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-content-'));
  let state = makeState(null), projection = makeState(null), live = true;
  const gm = { role: 'gm' }, player = { role: 'player' };
  const store = createContentStorage({ directory, getState: () => state, getProjection: () => projection,
    authenticate: req => live ? ({ gm, player })[req.headers.authorization] : null, serialize: task => task() });
  const server = http.createServer(async (req, res) => { await store.handle(req, res, sendJson); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api/content`;
  const request = (suffix = '', role = 'gm', options = {}) => fetch(url + suffix, { ...options, headers: { Authorization: role, ...options.headers } });
  assert.equal((await request('', 'missing')).status, 401);
  assert.equal((await request('', 'player')).status, 403);
  assert.equal((await request('', 'player', { method: 'POST', body: png })).status, 403);
  const upload = await request('', 'gm', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } });
  assert.equal(upload.status, 201);
  const metadata = await upload.json(); assert.equal(metadata.reference, reference);
  const again = await request('', 'gm', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } });
  assert.equal((await again.json()).id, metadata.id);
  assert.deepEqual(await readdir(directory), [`${metadata.id}.content`]);
  assert.equal((await request(`/${metadata.id}`, 'player')).status, 404);
  await assert.rejects(store.validateReferences({ img: reference }, player), { code: 'content_reference_forbidden' });
  // Existing hidden content never becomes a grant merely by knowing its ID.
  state = makeState(reference);
  await assert.rejects(store.validateReferences({ img: reference }, player), { code: 'content_reference_forbidden' });
  projection = makeState(reference);
  await store.validateReferences({ img: reference }, player);
  const allowed = await request(`/${metadata.id}`, 'player');
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), png);
  assert.equal((await request(`/${metadata.id}/references`, 'player')).status, 403);
  assert.equal((await (await request(`/${metadata.id}/references`)).json()).count, 1);
  assert.equal((await request(`/${metadata.id}`, 'gm', { method: 'DELETE' })).status, 409);
  assert.equal((await request(`/${metadata.id}`, 'player', { method: 'DELETE' })).status, 403);
  projection = makeState(null);
  assert.equal((await request(`/${metadata.id}`, 'player')).status, 404);
  live = false; assert.equal((await request(`/${metadata.id}`)).status, 401);
  live = true; state = makeState(null);
  assert.equal((await request(`/${metadata.id}`, 'gm', { method: 'DELETE' })).status, 200);
  assert.deepEqual(await readdir(directory), []);
});

test('content archives contain every dependency and persist content before replacing World', async () => {
  const state = makeState(reference);
  const blob = await exportContentArchive(state, { get: async () => new Blob([png], { type: 'image/png' }) });
  const decoded = readContentArchive(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(decoded.state, state); assert.equal(decoded.records.length, 1);
  const saved = [];
  await persistArchiveContent(decoded.records, { putImage: async blob => {
    saved.push(blob); return { reference: `asset:${digest(Buffer.from(await blob.arrayBuffer()))}` };
  } });
  assert.equal(saved.length, 1);
  await assert.rejects(persistArchiveContent(decoded.records, { putImage: async () => { throw new Error('QuotaExceededError'); } }), /QuotaExceededError/);
  await assert.rejects(persistArchiveContent(decoded.records, { putImage: async () => ({ reference: `asset:${'0'.repeat(64)}` }) }), /hash_mismatch/);
  assert.deepEqual(state, decoded.state);
});

test('archive import rejects missing dependencies, unsafe entries and unbounded expansion', () => {
  const manifest = { format: 'rpgmap-world', version: 1, world: 'world.json', content: [] };
  const files = { 'manifest.json': strToU8(JSON.stringify(manifest)), 'world.json': strToU8(JSON.stringify(makeState(reference))) };
  assert.throws(() => readContentArchive(zipSync(files)), /content_missing/);
  assert.throws(() => readContentArchive(zipSync({ ...files, '../world.json': strToU8('{}') })), /invalid_archive_entry/);
  assert.throws(() => readContentArchive(zipSync({ ...files, 'manifest.json': new Uint8Array(1024 * 1024 + 1) })), /archive_size_exceeded/);
});

test('offline content storage reports unavailable IndexedDB instead of claiming persistence', async () => {
  await assert.rejects(createIndexedContentStorage(null).put(new Blob([png], { type: 'image/png' })), /content_storage_unavailable/);
});

test('offline content persists immutable deduplicated records across adapter reloads', async () => {
  const database = new IDBFactory(), first = createIndexedContentStorage(database);
  const blob = new Blob([png], { type: 'image/png' });
  const saved = await first.put(blob), again = await first.put(blob);
  assert.equal(saved.reference, reference); assert.deepEqual(saved, again);
  const reloaded = createIndexedContentStorage(database);
  assert.deepEqual(Buffer.from(await (await reloaded.get(saved.id)).arrayBuffer()), png);
  assert.equal((await reloaded.list()).length, 1);
  const otherWorld = createIndexedContentStorage(database, { worldId: 'other-world' });
  assert.equal((await otherWorld.list()).length, 0);
  await assert.rejects(otherWorld.get(saved.id), /content_not_found/);
  await reloaded.remove(saved.id); assert.equal((await first.list()).length, 0);
});

test('content deletion protects retained browser backups and rejects unreadable saves', () => {
  let raw = JSON.stringify(makeState(reference));
  const storage = { length: 1, key: () => 'rpgmap:world:a:v1:backup:import', getItem: () => raw };
  assert.equal(hasStoredContentReference(storage, reference), true);
  raw = JSON.stringify(makeState(null)); assert.equal(hasStoredContentReference(storage, reference), false);
  raw = '{broken'; assert.throws(() => hasStoredContentReference(storage, reference), /backup_unreadable/);
});

test('content deletion protects LAN snapshots, retained backups and uncompacted WAL', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-content-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = { worldFile: path.join(root, 'world.json'), backupsDir: path.join(root, 'backups'), operationsFile: path.join(root, 'world.operations.ndjson') };
  await mkdir(storage.backupsDir);
  assert.equal(await hasRetainedContentReference(storage, reference), false);
  await writeFile(storage.worldFile, JSON.stringify(makeState(reference)));
  assert.equal(await hasRetainedContentReference(storage, reference), true);
  await writeFile(storage.worldFile, JSON.stringify(makeState(null)));
  await writeFile(storage.operationsFile, JSON.stringify({ revision: 1, patch: { img: reference } }) + '\n');
  assert.equal(await hasRetainedContentReference(storage, reference), true);
  await writeFile(storage.operationsFile, '');
  const backup = path.join(storage.backupsDir, 'world.backup.test.json');
  await writeFile(backup, JSON.stringify(makeState(reference)));
  assert.equal(await hasRetainedContentReference(storage, reference), true);
  await writeFile(backup, '{broken');
  await assert.rejects(hasRetainedContentReference(storage, reference), { code: 'content_backup_unreadable' });
});

test('offline quota failure and post-request transaction abort never report successful content persistence', async () => {
  const originalAdd = IDBObjectStore.prototype.add;
  try {
    const storage = createIndexedContentStorage(new IDBFactory());
    IDBObjectStore.prototype.add = function () { throw new DOMException('quota', 'QuotaExceededError'); };
    await assert.rejects(storage.put(new Blob([png], { type: 'image/png' })), { name: 'QuotaExceededError' });
    assert.deepEqual(await storage.list(), []);
    IDBObjectStore.prototype.add = function (...args) {
      const request = originalAdd.apply(this, args);
      request.onsuccess = () => this.transaction.abort();
      return request;
    };
    await assert.rejects(storage.put(new Blob([png], { type: 'image/png' })), /content_storage_failed|abort/i);
    assert.deepEqual(await storage.list(), []);
    IDBObjectStore.prototype.add = originalAdd;
    assert.equal((await storage.put(new Blob([png], { type: 'image/png' }))).reference, reference);
  } finally { IDBObjectStore.prototype.add = originalAdd; }
});
