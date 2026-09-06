import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createPortableStorage, ensurePortableStorage } from '../deployment/local-server/portable-storage.mjs';
import { commitStorageUpgrade, recoverStorageUpgrade } from '../deployment/local-server/storage-upgrade.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-storage-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createPortableStorage({ root, env: {} });
  await ensurePortableStorage(layout);
  const original = { 'world.json': '{"revision":3,"state":{"legacy":true}}', 'users.json': '{"users":[],"extension":4}',
    'world.operations.ndjson': '{"durable":"record"}\nunfinished-tail', 'uploads/content/image.content': 'immutable image',
    'uploads/content/body.content': 'immutable body' };
  for (const [relative, bytes] of Object.entries(original)) {
    const file = path.join(layout.mapDir, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
  }
  const replacements = { 'world.json': Buffer.from('{"revision":4,"state":{"upgraded":true}}'),
    'users.json': Buffer.from('{"schemaVersion":4,"users":[],"extension":4}'), 'world.operations.ndjson': Buffer.alloc(0) };
  return { layout, original, replacements };
}

async function assertOriginal(layout, original) {
  for (const [relative, bytes] of Object.entries(original)) assert.equal(await readFile(path.join(layout.mapDir, relative), 'utf8'), bytes);
}

test('upgrade stages and validates World, Access, WAL and immutable content before switching live records', async t => {
  const { layout, original, replacements } = await fixture(t);
  const result = await commitStorageUpgrade(layout, replacements, { async onStep(step) {
    if (step === 'prepared') await assertOriginal(layout, original);
  } });
  for (const [relative, bytes] of Object.entries(replacements)) assert.deepEqual(await readFile(path.join(layout.mapDir, relative)), bytes);
  for (const [relative, bytes] of Object.entries(original)) assert.equal(await readFile(path.join(result.backupDirectory, 'before', relative), 'utf8'), bytes);
  assert.equal(await recoverStorageUpgrade(layout), null);
  assert.equal((await readdir(layout.backupsDir)).length, 1);
});

for (const interruption of ['pending', 'replaced:world.json', 'replaced:users.json', 'replaced:world.operations.ndjson', 'published']) {
  test(`interrupted upgrade at ${interruption} restores the complete set before startup`, async t => {
    const { layout, original, replacements } = await fixture(t);
    await assert.rejects(commitStorageUpgrade(layout, replacements, { onStep(step) { if (step === interruption) throw new Error('simulated_process_interruption'); } }), /simulated_process_interruption/);
    const recovered = await recoverStorageUpgrade(layout);
    assert.ok(recovered.recovered);
    await assertOriginal(layout, original);
    assert.equal(await recoverStorageUpgrade(layout), null);
    assert.equal((await readdir(layout.backupsDir)).length, 1);
  });
}

test('preparation failure never publishes a pending marker or changes live state', async t => {
  const { layout, original, replacements } = await fixture(t);
  await assert.rejects(commitStorageUpgrade(layout, replacements, { onStep() { throw new Error('ENOSPC'); } }), /ENOSPC/);
  await assertOriginal(layout, original);
  assert.equal(await recoverStorageUpgrade(layout), null);
});

test('a real process exit between file replacements is recovered before the next load', async t => {
  const { layout, original, replacements } = await fixture(t);
  const module = new URL('../deployment/local-server/storage-upgrade.mjs', import.meta.url).href;
  const source = `import { commitStorageUpgrade } from ${JSON.stringify(module)};
    const replacements = Object.fromEntries(Object.entries(${JSON.stringify(Object.fromEntries(Object.entries(replacements).map(([key, bytes]) => [key, bytes.toString()])))}).map(([key, value]) => [key, Buffer.from(value)]));
    await commitStorageUpgrade(${JSON.stringify(layout)}, replacements, { onStep(step) { if (step === 'replaced:world.json') process.exit(86); } });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 86, stderr);
  assert.deepEqual(await readFile(layout.worldFile), replacements['world.json']);
  await recoverStorageUpgrade(layout);
  await assertOriginal(layout, original);
});

test('recovery refuses corrupt backups and preserves every live byte for explicit intervention', async t => {
  const { layout, replacements } = await fixture(t);
  await assert.rejects(commitStorageUpgrade(layout, replacements, { onStep(step) { if (step === 'replaced:world.json') throw new Error('crash'); } }), /crash/);
  const backup = (await readdir(layout.backupsDir))[0];
  await writeFile(path.join(layout.backupsDir, backup, 'before', 'users.json'), 'corrupt');
  await assert.rejects(recoverStorageUpgrade(layout), { code: 'upgrade_backup_corrupt' });
  assert.deepEqual(await readFile(layout.worldFile), replacements['world.json']);
  assert.ok((await readdir(layout.mapDir)).includes('.upgrade-pending.json'));
});

test('recovery does not overwrite unrelated user edits or new uploads after interruption', async t => {
  const { layout, replacements } = await fixture(t);
  await assert.rejects(commitStorageUpgrade(layout, replacements, { onStep(step) { if (step === 'pending') throw new Error('crash'); } }), /crash/);
  await writeFile(layout.usersFile, 'new user content');
  await assert.rejects(recoverStorageUpgrade(layout), { code: 'upgrade_recovery_conflict' });
  assert.equal(await readFile(layout.usersFile, 'utf8'), 'new user content');
});

test('recovery refuses new files added by the user after interruption', async t => {
  const { layout, replacements } = await fixture(t);
  await assert.rejects(commitStorageUpgrade(layout, replacements, { onStep(step) { if (step === 'pending') throw new Error('crash'); } }), /crash/);
  const file = path.join(layout.uploadsDir, 'new-user-file');
  await writeFile(file, 'retain');
  await assert.rejects(recoverStorageUpgrade(layout), { code: 'upgrade_recovery_conflict' });
  assert.equal(await readFile(file, 'utf8'), 'retain');
});

test('upgrade never follows uploaded directory links outside its data root', async t => {
  const { layout, replacements, original } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'rpgmap-upgrade-link-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'keep'), 'outside');
  await symlink(outside, path.join(layout.uploadsDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(commitStorageUpgrade(layout, replacements), { code: 'upgrade_file_invalid' });
  await assertOriginal(layout, original);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'outside');
});

test('upgrade addresses cannot escape the data root and unknown pending manifests never start partial state', async t => {
  const { layout, original } = await fixture(t);
  await assert.rejects(commitStorageUpgrade(layout, { '../world.json': Buffer.from('unsafe') }), { code: 'upgrade_replacement_invalid' });
  await writeFile(path.join(layout.mapDir, '.upgrade-pending.json'), '{"id":"../../outside"}');
  await assert.rejects(recoverStorageUpgrade(layout), { code: 'upgrade_manifest_invalid' });
  await assertOriginal(layout, original);
});
