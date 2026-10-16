import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { importLegacyDirectory } from '../deployment/local-server/legacy-import.mjs';
import { ManagedWorldStore } from '../deployment/local-server/managed-worlds.mjs';
import { MapPackageStore } from '../deployment/local-server/package-store.mjs';
import { createWorldWal } from '../deployment/local-server/world-wal.mjs';
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';
import { createBoundUser, normalizeAccessState, verifyPlayerKey } from '../deployment/local-server/access-control.mjs';
import { emptyExploration, enqueueExploration, finishExplorationChunk } from '../deployment/local-server/exploration-queue.mjs';
import { buildMapArchive } from '../src/packages/map-archive.js';
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { createInitialState } from '../src/engine/state.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { createDefaultActor } from '../src/actor/model.js';
import { applyWorldOperations, createWorldOperationPatch, applyWorldOperationPatch } from '../src/world/operations.js';
import { inspectContent, JOURNAL_BODY_TYPE } from '../src/content/body.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc8AAAAASUVORK5CYII=', 'base64');

function assertImportedExploration(actual, original) {
  assert.notEqual(actual.worldEpoch, original.worldEpoch);
  for (const job of Object.values(actual.jobs)) assert.equal(job.worldEpoch, actual.worldEpoch);
  const unwrapped = structuredClone(actual); unwrapped.worldEpoch = original.worldEpoch;
  for (const job of Object.values(unwrapped.jobs)) job.worldEpoch = original.worldEpoch;
  assert.deepEqual(unwrapped, original, 'every accepted path, cursor, context and party epoch is retained');
}

async function files(root, relative = '') {
  const result = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(root, name));
    else result[name] = await readFile(path.join(root, name));
  }
  return result;
}

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-legacy-import-'));
  const source = path.join(temporary, 'old', 'map'), root = path.join(temporary, 'new', 'UserData'), outside = path.join(temporary, 'outside');
  await Promise.all([mkdir(source, { recursive: true }), mkdir(root, { recursive: true }), mkdir(outside)]);
  const maps = await new MapPackageStore({ root: path.join(root, 'packages/maps') }).initialize();
  const metadata = await maps.install(buildMapArchive({ data: createMinimalReferencePackage() }));
  const map = maps.get(metadata);
  const rulesets = { async get(ref) {
    if (ref.id !== ruleset.id || ref.version !== ruleset.version) throw Object.assign(new Error('unknown_ruleset'), { code: 'unknown_ruleset' });
    return ruleset;
  } };
  const worlds = await new ManagedWorldStore({ root, maps, rulesets, validateState: assertWorldState }).initialize();
  let state = createInitialState(map);
  const world = createWorldV2FromRuntimeState(state, { mapPackage: map, ruleset, worldId: 'legacy-world', worldName: 'Before WAL' });
  const actor = createDefaultActor({ id: 'actor-a', ruleset }); actor.img = `asset:${hash(png)}`;
  world.actors = [actor];
  const scene = world.scenes[0];
  scene.tokens = [{ id: 'token-a', actorId: actor.id, actorLink: true, placement: 'map', x: 100, y: 100, elevationMeters: 0 }];
  const journal = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'journal-page', markdown: 'Original authored notes', images: [actor.img] }));
  world.journals = [{ id: 'journal', title: 'Old journal', bodyRef: `body:${hash(journal)}` }];
  state = projectWorldV2ToRuntimeState(state, world, { mapPackage: map, ruleset });
  await mkdir(path.join(source, 'uploads/content'), { recursive: true });
  for (const [bytes, type] of [[png, 'image/png'], [journal, JOURNAL_BODY_TYPE]]) {
    await writeFile(path.join(source, 'uploads/content', `${hash(bytes)}.content`),
      JSON.stringify({ id: hash(bytes), ...inspectContent(bytes, type), data: bytes.toString('base64') }));
  }
  const exploration = emptyExploration();
  const initial = { schemaVersion: 1, worldId: 'default', revision: 0, state, exploration, recentStatusOperations: [] };
  await writeFile(path.join(source, 'world.json'), JSON.stringify(initial, null, 2) + '\r\n');
  const changed = applyWorldOperations(state, [
    { type: 'world.rename', payload: { name: 'Restored from WAL' } },
    { type: 'token.move', payload: { tokenId: 'token-a', x: 110, y: 100 } },
  ], { source: { role: 'gm' }, ruleset, mapForScene: () => map }).state;
  const acceptedExploration = enqueueExploration(exploration, { map: { width: map.width, height: map.height, metersPerUnit: 1 }, occluders: [], lights: [] },
    { id: 'accepted-before-upgrade:0', sceneId: scene.id, partyId: 'party', tokenId: 'token-a', createdRevision: 1,
      vagueRangeMeters: 20, path: [{ x: 100, y: 100, elevationMeters: 0 }, { x: 110, y: 100, elevationMeters: 0 }] });
  const wal = createWorldWal({ filePath: path.join(source, 'world.operations.ndjson'), applyPatch: applyWorldOperationPatch });
  await wal.append({ baseRevision: 0, revision: 1, operationId: 'move-before-upgrade', patch: createWorldOperationPatch(state, changed),
    explorationDelta: { schemaVersion: 1, replace: acceptedExploration } });
  const user = createBoundUser({ name: 'Old player', defaultActorId: actor.id });
  const access = normalizeAccessState({ schemaVersion: 4, revision: 2, users: [user.user] });
  await writeFile(path.join(source, 'users.json'), JSON.stringify(access, null, 2) + '\n');
  await mkdir(path.join(source, 'backups'), { recursive: true });
  await writeFile(path.join(source, 'backups/old-backup.json'), JSON.stringify(initial));
  await mkdir(path.join(source, '自定义资料'), { recursive: true });
  await writeFile(path.join(source, '自定义资料/场景说明.md'), '不属于预设文件清单的原始地图资料\r\n');
  return { temporary, source, root, outside, worlds, maps, rulesets, map, access, user, acceptedExploration,
    run: () => importLegacyDirectory({ directory: source, root, worlds, rulesets }),
    snapshot: async id => JSON.parse(await readFile(path.join(worlds.worldDirectory(id), 'world.json'), 'utf8')),
    cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test('legacy import replays World/WAL, preserves accepted exploration and users/uploads, and leaves the complete original directory byte-for-byte unchanged', async () => {
  const f = await fixture();
  try {
    const original = await files(f.source);
    const result = await f.run(), loaded = await f.snapshot(result.id);
    assert.equal(loaded.state.preferences.worldV2.name, 'Restored from WAL');
    assert.equal(loaded.state.preferences.worldV2.scenes[0].tokens[0].x, 110);
    assert.equal(loaded.worldId, 'legacy-world'); assert.equal(loaded.revision, 0);
    assertImportedExploration(loaded.exploration, f.acceptedExploration);
    assert.deepEqual(await files(f.source), original);
    assert.deepEqual(await files(path.join(result.receiptDirectory, 'original')), original);
    const receipt = JSON.parse(await readFile(path.join(result.receiptDirectory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.originalRevision, 1);
    assert.equal(receipt.records.length, Object.keys(original).length);
    for (const record of receipt.records) assert.equal(record.sha256, hash(original[record.path]));
    const users = JSON.parse(await readFile(path.join(f.worlds.worldDirectory(result.id), 'users.json'), 'utf8'));
    assert.deepEqual(users, f.access); assert.equal(verifyPlayerKey(users.users[0], f.user.playerKey), true);
    for (const [name, bytes] of Object.entries(original).filter(([name]) => name.startsWith('uploads/'))) {
      assert.deepEqual(await readFile(path.join(f.root, name)), bytes);
    }
    assert.equal(f.worlds.list().length, 1);
    assert.equal(f.worlds.activeId(), null, 'import does not silently replace the active campaign');
    const duplicate = await f.run();
    assert.notEqual(duplicate.id, result.id);
    assert.equal((await f.snapshot(duplicate.id)).state.preferences.worldV2.id, duplicate.id);
    const duplicateExploration = (await f.snapshot(duplicate.id)).exploration;
    assertImportedExploration(duplicateExploration, f.acceptedExploration);
    assert.notEqual(duplicateExploration.worldEpoch, loaded.exploration.worldEpoch);
    assert.deepEqual(await files(f.source), original);
  } finally { await f.cleanup(); }
});

for (const kind of ['missing-map', 'corrupt-content', 'missing-journal-dependency', 'corrupt-wal', 'invalid-users']) {
  test(`${kind} import is rejected without publishing a World or altering any original byte`, async () => {
    const f = await fixture();
    try {
      if (kind === 'missing-map') {
        const snapshot = JSON.parse(await readFile(path.join(f.source, 'world.json'), 'utf8'));
        snapshot.state.preferences.worldV2.scenes[0].mapPackage.version = 'not-installed';
        await writeFile(path.join(f.source, 'world.json'), JSON.stringify(snapshot));
      } else if (kind === 'corrupt-content') {
        const file = path.join(f.source, 'uploads/content', `${hash(png)}.content`), record = JSON.parse(await readFile(file, 'utf8'));
        record.data = Buffer.from('damaged original image').toString('base64'); await writeFile(file, JSON.stringify(record));
      } else if (kind === 'missing-journal-dependency') await rm(path.join(f.source, 'uploads/content', `${hash(png)}.content`));
      else if (kind === 'corrupt-wal') await writeFile(path.join(f.source, 'world.operations.ndjson'), '{"invalid":"complete record"}\n');
      else await writeFile(path.join(f.source, 'users.json'), '{"schemaVersion":4,"users":{}}');
      const before = await files(f.source);
      await assert.rejects(f.run());
      assert.deepEqual(f.worlds.list(), []);
      assert.deepEqual(await readdir(path.join(f.root, 'worlds')), []);
      assert.deepEqual(await files(f.source), before);
    } finally { await f.cleanup(); }
  });
}

test('source directory and nested junctions are refused before any external content is copied', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.temporary, 'map-alias');
    await symlink(f.source, alias, 'junction');
    await assert.rejects(importLegacyDirectory({ directory: alias, root: f.root, worlds: f.worlds, rulesets: f.rulesets }),
      { code: 'legacy_import_directory_invalid' });
    await writeFile(path.join(f.outside, 'secret.bin'), 'external data');
    await symlink(f.outside, path.join(f.source, 'linked-data'), 'junction');
    await assert.rejects(f.run(), { code: 'legacy_import_file_invalid' });
    assert.deepEqual(f.worlds.list(), []);
    assert.deepEqual(await readdir(path.join(f.root, 'worlds')), []);
    assert.deepEqual(await readdir(path.join(f.outside)), ['secret.bin']);
  } finally { await f.cleanup(); }
});

test('a shared uploads parent junction cannot publish content outside UserData or register the World', async () => {
  const f = await fixture();
  try {
    await symlink(f.outside, path.join(f.root, 'uploads'), 'junction');
    const before = await files(f.source);
    await assert.rejects(f.run(), { code: 'managed_directory_invalid' });
    assert.deepEqual(f.worlds.list(), []);
    assert.deepEqual(await readdir(path.join(f.root, 'worlds')), []);
    assert.deepEqual(await readdir(f.outside), []);
    assert.deepEqual(await files(f.source), before);
  } finally { await f.cleanup(); }
});

test('source changes after the copied World/WAL are validated cannot publish a mixed-time snapshot', async () => {
  const f = await fixture();
  try {
    const get = f.rulesets.get; let changed = false;
    f.rulesets.get = async ref => {
      if (!changed) { changed = true; await writeFile(path.join(f.source, 'world.operations.ndjson'), 'changed by the old server\n', { flag: 'a' }); }
      return get(ref);
    };
    await assert.rejects(f.run(), { code: 'legacy_import_source_changed' });
    assert.deepEqual(f.worlds.list(), []);
    assert.deepEqual(await readdir(path.join(f.root, 'worlds')), []);
  } finally { await f.cleanup(); }
});

test('failed import publication removes only its staging World and keeps existing campaigns intact', async () => {
  const f = await fixture();
  try {
    const existing = await f.run(), before = await f.snapshot(existing.id);
    await assert.rejects(f.worlds.import(before, { beforePublish: async () => { throw new Error('copy failed'); } }), /copy failed/);
    assert.deepEqual(f.worlds.list().map(item => item.id), [existing.id]);
    assert.deepEqual(await readdir(path.join(f.root, 'worlds')), [existing.id]);
    assert.deepEqual(await f.snapshot(existing.id), before);
  } finally { await f.cleanup(); }
});

test('confirmed exploration remains durable if a later WAL record removed its source Token', async () => {
  const f = await fixture();
  try {
    const wal = createWorldWal({ filePath: path.join(f.source, 'world.operations.ndjson'),
      applyPatch: (state, patch) => applyWorldOperationPatch(state, patch, { project: false }) });
    const snapshot = JSON.parse(await readFile(path.join(f.source, 'world.json'), 'utf8'));
    const replayed = await wal.replay(snapshot, { repairTail: false });
    const deleted = applyWorldOperations(replayed.state, [{ type: 'token.delete', payload: { tokenId: 'token-a' } }],
      { source: { role: 'gm' }, ruleset }).state;
    await wal.append({ baseRevision: 1, revision: 2, operationId: 'delete-after-accepted-path',
      patch: createWorldOperationPatch(replayed.state, deleted) });
    const before = await files(f.source), imported = await f.run(), loaded = await f.snapshot(imported.id);
    assert.deepEqual(loaded.state.preferences.worldV2.scenes[0].tokens, []);
    assertImportedExploration(loaded.exploration, f.acceptedExploration);
    const originalJob = Object.values(f.acceptedExploration.jobs)[0];
    const stale = { id: originalJob.id, worldEpoch: originalJob.worldEpoch, epoch: originalJob.epoch,
      fromCursor: originalJob.cursor, cursor: originalJob.cursor + 1 };
    assert.equal(finishExplorationChunk(loaded.exploration, stale), null, 'the former authority cannot advance the imported job');
    assert.ok(finishExplorationChunk(loaded.exploration, { ...stale, worldEpoch: loaded.exploration.worldEpoch }));
    assert.deepEqual(await files(f.source), before);
  } finally { await f.cleanup(); }
});
