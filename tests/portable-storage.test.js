import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPortableStorage, ensurePortableStorage, migrateLegacyStorage } from '../deployment/local-server/portable-storage.mjs';

test('portable storage keeps all mutable RPGmap data under map root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-portable-'));
  try {
    const layout = createPortableStorage({ root, env: {} });
    assert.equal(layout.appDir, path.join(root, 'app'));
    assert.equal(layout.mapDir, path.join(root, 'map'));
    assert.equal(layout.worldFile, path.join(root, 'map', 'world.json'));
    assert.equal(layout.usersFile, path.join(root, 'map', 'users.json'));
    assert.equal(layout.uploadsDir, path.join(root, 'map', 'uploads'));
    assert.equal(layout.backupsDir, path.join(root, 'map', 'backups'));
    await ensurePortableStorage(layout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy data/worlds/default files migrate into portable map root without deleting originals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-migrate-'));
  try {
    const legacy = path.join(root, 'data', 'worlds', 'default');
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'world.json'), JSON.stringify({ revision: 7, state: { ok: true } }), 'utf8');
    await writeFile(path.join(legacy, 'access.json'), JSON.stringify({ schemaVersion: 2, users: [{ id: 'u1', name: 'Alice' }] }), 'utf8');

    const layout = createPortableStorage({ root, env: {} });
    const migrated = await migrateLegacyStorage(layout);
    assert.deepEqual(migrated.map(item => item.type).sort(), ['users', 'world']);
    assert.equal(JSON.parse(await readFile(layout.worldFile, 'utf8')).revision, 7);
    assert.equal(JSON.parse(await readFile(layout.usersFile, 'utf8')).users[0].name, 'Alice');
    assert.equal(JSON.parse(await readFile(path.join(legacy, 'world.json'), 'utf8')).revision, 7);
    assert.equal(JSON.parse(await readFile(path.join(legacy, 'access.json'), 'utf8')).users[0].name, 'Alice');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing map-root files win over legacy data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-migrate-existing-'));
  try {
    const legacy = path.join(root, 'data', 'worlds', 'default');
    const mapDir = path.join(root, 'map');
    await mkdir(legacy, { recursive: true });
    await mkdir(mapDir, { recursive: true });
    await writeFile(path.join(legacy, 'world.json'), JSON.stringify({ revision: 1 }), 'utf8');
    await writeFile(path.join(legacy, 'access.json'), JSON.stringify({ users: [{ id: 'old' }] }), 'utf8');
    await writeFile(path.join(mapDir, 'world.json'), JSON.stringify({ revision: 9 }), 'utf8');
    await writeFile(path.join(mapDir, 'users.json'), JSON.stringify({ users: [{ id: 'new' }] }), 'utf8');

    const layout = createPortableStorage({ root, env: {} });
    const migrated = await migrateLegacyStorage(layout);
    assert.equal(migrated.length, 0);
    assert.equal(JSON.parse(await readFile(layout.worldFile, 'utf8')).revision, 9);
    assert.equal(JSON.parse(await readFile(layout.usersFile, 'utf8')).users[0].id, 'new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
