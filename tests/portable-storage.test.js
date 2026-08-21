import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPortableStorage, ensurePortableStorage, migrateLegacyStorage } from '../deployment/local-server/portable-storage.mjs';

test('V1.4.2 portable storage separates app, world, and maps roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-portable-'));
  try {
    const layout = createPortableStorage({ root, env: {} });
    assert.equal(layout.appDir, path.join(root, 'app'));
    assert.equal(layout.worldDir, path.join(root, 'world'));
    assert.equal(layout.mapsDir, path.join(root, 'maps'));
    assert.equal(layout.worldFile, path.join(root, 'world', 'state.json'));
    assert.equal(layout.usersFile, path.join(root, 'world', 'users.json'));
    assert.equal(layout.uploadsDir, path.join(root, 'world', 'uploads'));
    assert.equal(layout.backupsDir, path.join(root, 'world', 'backups'));
    await ensurePortableStorage(layout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('V1.4.1 map-root files migrate into V1.4.2 world root without deleting originals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-migrate-map-'));
  try {
    const oldMap = path.join(root, 'map');
    await mkdir(path.join(oldMap, 'uploads'), { recursive: true });
    await mkdir(path.join(oldMap, 'backups'), { recursive: true });
    await writeFile(path.join(oldMap, 'world.json'), JSON.stringify({ revision: 11, state: { ok: true } }), 'utf8');
    await writeFile(path.join(oldMap, 'users.json'), JSON.stringify({ schemaVersion: 2, users: [{ id: 'u1', name: 'Alice' }] }), 'utf8');
    await writeFile(path.join(oldMap, 'uploads', 'sample.txt'), 'upload', 'utf8');

    const layout = createPortableStorage({ root, env: {} });
    const migrated = await migrateLegacyStorage(layout);
    assert.ok(migrated.some(item => item.type === 'world-v1.4.1'));
    assert.ok(migrated.some(item => item.type === 'users-v1.4.1'));
    assert.equal(JSON.parse(await readFile(layout.worldFile, 'utf8')).revision, 11);
    assert.equal(JSON.parse(await readFile(layout.usersFile, 'utf8')).users[0].name, 'Alice');
    assert.equal(await readFile(path.join(layout.uploadsDir, 'sample.txt'), 'utf8'), 'upload');
    assert.equal(JSON.parse(await readFile(path.join(oldMap, 'world.json'), 'utf8')).revision, 11);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy data/worlds/default files still migrate into V1.4.2 world root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-migrate-data-'));
  try {
    const legacy = path.join(root, 'data', 'worlds', 'default');
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'world.json'), JSON.stringify({ revision: 7, state: { ok: true } }), 'utf8');
    await writeFile(path.join(legacy, 'access.json'), JSON.stringify({ schemaVersion: 2, users: [{ id: 'u1', name: 'Alice' }] }), 'utf8');

    const layout = createPortableStorage({ root, env: {} });
    const migrated = await migrateLegacyStorage(layout);
    assert.ok(migrated.some(item => item.type === 'world-legacy-data'));
    assert.ok(migrated.some(item => item.type === 'users-legacy-data'));
    assert.equal(JSON.parse(await readFile(layout.worldFile, 'utf8')).revision, 7);
    assert.equal(JSON.parse(await readFile(layout.usersFile, 'utf8')).users[0].name, 'Alice');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing V1.4.2 world files win over all legacy sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-migrate-existing-'));
  try {
    const legacy = path.join(root, 'data', 'worlds', 'default');
    const oldMap = path.join(root, 'map');
    const worldDir = path.join(root, 'world');
    await mkdir(legacy, { recursive: true });
    await mkdir(oldMap, { recursive: true });
    await mkdir(worldDir, { recursive: true });
    await writeFile(path.join(legacy, 'world.json'), JSON.stringify({ revision: 1 }), 'utf8');
    await writeFile(path.join(legacy, 'access.json'), JSON.stringify({ users: [{ id: 'old-data' }] }), 'utf8');
    await writeFile(path.join(oldMap, 'world.json'), JSON.stringify({ revision: 5 }), 'utf8');
    await writeFile(path.join(oldMap, 'users.json'), JSON.stringify({ users: [{ id: 'old-map' }] }), 'utf8');
    await writeFile(path.join(worldDir, 'state.json'), JSON.stringify({ revision: 9 }), 'utf8');
    await writeFile(path.join(worldDir, 'users.json'), JSON.stringify({ users: [{ id: 'new' }] }), 'utf8');

    const layout = createPortableStorage({ root, env: {} });
    await migrateLegacyStorage(layout);
    assert.equal(JSON.parse(await readFile(layout.worldFile, 'utf8')).revision, 9);
    assert.equal(JSON.parse(await readFile(layout.usersFile, 'utf8')).users[0].id, 'new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
