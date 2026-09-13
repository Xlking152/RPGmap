import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareInlineImageMigration } from '../src/content/migration.js';
import { prepareContentUpgrade } from '../deployment/local-server/content-storage.mjs';
import { createPortableStorage, ensurePortableStorage } from '../deployment/local-server/portable-storage.mjs';
import { commitStorageUpgrade, recoverStorageUpgrade } from '../deployment/local-server/storage-upgrade.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc8AAAAASUVORK5CYII=', 'base64');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const id = createHash('sha256').update(png).digest('hex');
const ref = `asset:${id}`;
const relative = `uploads/content/${id}.content`;

test('inline migration is read-only, deduplicates all known image fields and preserves safe extensions', async () => {
  const source = { actor: { img: dataUrl, system: { forms: [{ avatarDataUrl: dataUrl, custom: 12 }] } },
    token: { texture: { src: dataUrl }, extension: { value: 'keep' } }, notes: dataUrl };
  const before = structuredClone(source);
  const result = await prepareInlineImageMigration(JSON.stringify(source));
  assert.deepEqual(source, before);
  assert.equal(result.records.length, 1);
  assert.deepEqual(Buffer.from(result.records[0].bytes), png);
  assert.equal(result.state.actor.img, ref);
  assert.equal(result.state.token.texture.src, ref);
  assert.deepEqual(result.state.actor.system.forms, [{ avatarDataUrl: ref, custom: 12 }]);
  assert.equal(result.state.notes, dataUrl);
  assert.deepEqual(result.state.token.extension, source.token.extension);
  const again = await prepareInlineImageMigration(result.state);
  assert.equal(again.migrated, false);
  assert.deepEqual(again.state, result.state);
  assert.deepEqual(again.records, []);
});

test('damaged or unsafe input rejects the whole migration with the original field path', async () => {
  const source = { actors: [{ img: dataUrl }, { system: { forms: [{ avatarDataUrl: 'data:image/png;base64,broken' }] } }] };
  const before = structuredClone(source);
  await assert.rejects(prepareInlineImageMigration(source), error => {
    assert.equal(error.code, 'invalid_image_data_url');
    assert.deepEqual(error.path, ['actors', '1', 'system', 'forms', '0', 'avatarDataUrl']); return true;
  });
  assert.deepEqual(source, before);
  await assert.rejects(prepareInlineImageMigration('{"safe":{"__proto__":{"x":1}}}'), { code: 'migration_unsafe_key' });
  let deep = {}; for (let n = 0; n < 50; n++) deep = { child: deep };
  await assert.rejects(prepareInlineImageMigration(deep), { code: 'migration_input_limit' });
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-content-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createPortableStorage({ root, env: {} });
  await ensurePortableStorage(layout);
  const raw = JSON.stringify({ img: dataUrl, notes: 'original' });
  await writeFile(layout.worldFile, raw);
  return { layout, raw, directory: path.join(layout.uploadsDir, 'content') };
}

test('server preparation makes no writes and publishes content before replacing World', async t => {
  const { layout, raw, directory } = await fixture(t);
  const result = await prepareContentUpgrade(JSON.parse(raw), directory);
  assert.equal(await readFile(layout.worldFile, 'utf8'), raw);
  assert.deepEqual(await readdir(layout.uploadsDir), []);
  const steps = [];
  const committed = await commitStorageUpgrade(layout, { 'world.json': Buffer.from(JSON.stringify(result.state)), ...result.replacements }, {
    async onStep(step) {
      steps.push(step);
      if (step === `replaced:${relative}`) assert.equal(await readFile(layout.worldFile, 'utf8'), raw);
    },
  });
  assert.ok(steps.indexOf(`replaced:${relative}`) < steps.indexOf('replaced:world.json'));
  assert.equal(await readFile(path.join(committed.backupDirectory, 'before/world.json'), 'utf8'), raw);
  const record = JSON.parse(await readFile(path.join(layout.mapDir, relative), 'utf8'));
  assert.deepEqual(Buffer.from(record.data, 'base64'), png);
  assert.equal(record.id, id);
  const deduplicated = await prepareContentUpgrade(JSON.parse(raw), directory);
  assert.deepEqual(deduplicated.replacements, {});
  const again = await prepareContentUpgrade(result.state, directory);
  assert.equal(again.migrated, false);
});

for (const interruption of [`replaced:${relative}`, 'replaced:world.json']) {
  test(`server rollback removes newly extracted content after interruption at ${interruption}`, async t => {
    const { layout, raw, directory } = await fixture(t);
    const prepared = await prepareContentUpgrade(JSON.parse(raw), directory);
    await assert.rejects(commitStorageUpgrade(layout, { ...prepared.replacements, 'world.json': Buffer.from(JSON.stringify(prepared.state)) }, {
      onStep(step) { if (step === interruption) throw new Error('crash'); },
    }), /crash/);
    await recoverStorageUpgrade(layout);
    assert.equal(await readFile(layout.worldFile, 'utf8'), raw);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(await recoverStorageUpgrade(layout), null);
  });
}

test('existing immutable content is validated and never overwritten by migration', async t => {
  const { layout, raw, directory } = await fixture(t);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.content`), JSON.stringify({ id, type: 'image/png', data: 'broken' }));
  await assert.rejects(prepareContentUpgrade(JSON.parse(raw), directory), { code: 'content_corrupt' });
  await assert.rejects(commitStorageUpgrade(layout, { [relative]: Buffer.from('replacement') }), { code: 'upgrade_content_conflict' });
  assert.equal(await readFile(layout.worldFile, 'utf8'), raw);
  assert.equal(await recoverStorageUpgrade(layout), null);
});
