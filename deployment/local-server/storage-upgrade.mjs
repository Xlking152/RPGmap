import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const ROOT_FILES = ['world.json', 'users.json', 'world.operations.ndjson'];
const PENDING = '.upgrade-pending.json';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CONTENT_FILE = /^uploads\/content\/[a-f0-9]{64}\.content$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');

function location(root, relative) {
  if (typeof relative !== 'string' || /[\\:\0]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('upgrade_path_invalid');
  const base = path.resolve(root), target = path.resolve(base, relative);
  if (!target.startsWith(`${base}${path.sep}`)) fail('upgrade_path_invalid');
  return target;
}

async function regularFile(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('upgrade_file_invalid');
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function checkParents(root, relative) {
  let directory = path.resolve(root);
  for (const part of ['', ...relative.split('/').slice(0, -1)]) {
    if (part) directory = path.join(directory, part);
    let stat;
    try { stat = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('upgrade_file_invalid');
  }
}

async function describe(root, relative) {
  const file = location(root, relative);
  await checkParents(root, relative);
  const stat = await regularFile(file);
  if (!stat) return { path: relative, hash: null, size: 0 };
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return { path: relative, hash: hash.digest('hex'), size: stat.size };
}

async function uploadFiles(root) {
  const result = [];
  async function visit(relative) {
    const directory = location(root, relative);
    let stat;
    try { stat = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('upgrade_file_invalid');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail('upgrade_file_invalid');
      if (entry.isDirectory()) await visit(next);
      else { await regularFile(location(root, next)); result.push(next); }
    }
  }
  await visit('uploads');
  return result.sort();
}

async function flush(file) {
  const handle = await open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function replaceFile(file, bytes, source = null) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    if (source) { await copyFile(source, temporary); await flush(temporary); }
    else {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)));
      }
    }
    await flush(file);
  } finally { await rm(temporary, { force: true }); }
}

const sameRecord = (left, right) => left.hash === right.hash && left.size === right.size;

async function checkLive(layout, manifest, { allowAfter = false } = {}) {
  const uploads = await uploadFiles(layout.mapDir);
  const allowed = new Set(manifest.before.filter(record => record.path.startsWith('uploads/') && (allowAfter || record.hash !== null)).map(record => record.path));
  if (uploads.some(file => !allowed.has(file))) fail('upgrade_recovery_conflict');
  const after = new Map(manifest.after.map(record => [record.path, record]));
  for (const record of manifest.before) {
    const current = await describe(layout.mapDir, record.path);
    if (!sameRecord(current, record) && !(allowAfter && after.has(record.path) && sameRecord(current, after.get(record.path)))) fail('upgrade_recovery_conflict');
  }
}

async function loadManifest(layout, id) {
  if (!UUID.test(id)) fail('upgrade_manifest_invalid');
  const directory = location(layout.backupsDir, `upgrade-${id}`);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('upgrade_manifest_invalid');
  const manifestFile = location(directory, 'manifest.json');
  if ((await regularFile(manifestFile))?.size > 8 * 1024 * 1024) fail('upgrade_manifest_invalid');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.id !== id || !Array.isArray(manifest.before) || !Array.isArray(manifest.after)) fail('upgrade_manifest_invalid');
  for (const [side, records] of [['before', manifest.before], ['after', manifest.after]]) {
    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.path) || (!ROOT_FILES.includes(record.path) && !CONTENT_FILE.test(record.path) && !(side === 'before' && record.path?.startsWith('uploads/')))
        || !Number.isSafeInteger(record.size) || record.size < 0 || !(record.hash === null || /^[a-f0-9]{64}$/.test(record.hash))) fail('upgrade_manifest_invalid');
      seen.add(record.path);
      if (!sameRecord(await describe(path.join(directory, side), record.path), record)) fail('upgrade_backup_corrupt');
    }
    if (side === 'before' && ROOT_FILES.some(file => !seen.has(file))) fail('upgrade_manifest_invalid');
  }
  const beforePaths = new Set(manifest.before.map(record => record.path));
  if (manifest.after.some(record => !beforePaths.has(record.path) || record.hash === null)) fail('upgrade_manifest_invalid');
  return { directory, manifest };
}

export async function recoverStorageUpgrade(layout) {
  const pendingFile = path.join(layout.mapDir, PENDING);
  await checkParents(layout.mapDir, PENDING);
  const pendingStat = await regularFile(pendingFile);
  if (!pendingStat) return null;
  if (pendingStat.size > 1024) fail('upgrade_manifest_invalid');
  const { id } = JSON.parse(await readFile(pendingFile, 'utf8'));
  const { directory, manifest } = await loadManifest(layout, id);
  // An interrupted startup has served no requests. Restore the whole set only
  // if each live file still matches its recorded old or staged bytes.
  await checkLive(layout, manifest, { allowAfter: true });
  for (const record of manifest.before) {
    const file = location(layout.mapDir, record.path);
    if (record.hash === null) await rm(file, { force: true });
    else await replaceFile(file, null, location(path.join(directory, 'before'), record.path));
  }
  await rm(pendingFile);
  return { recovered: id, backupDirectory: directory };
}

export async function commitStorageUpgrade(layout, replacements, { onStep = () => {} } = {}) {
  await recoverStorageUpgrade(layout);
  const entries = Object.entries(replacements).sort(([a], [b]) => Number(ROOT_FILES.includes(a)) - Number(ROOT_FILES.includes(b)));
  if (!entries.length || entries.some(([name, bytes]) => (!ROOT_FILES.includes(name) && !CONTENT_FILE.test(name)) || !(bytes instanceof Uint8Array))) fail('upgrade_replacement_invalid');
  const id = randomUUID(), directory = location(layout.backupsDir, `upgrade-${id}`);
  await checkParents(layout.backupsDir, `upgrade-${id}/manifest.json`);
  await mkdir(directory, { recursive: true });
  const manifest = { schemaVersion: 1, id, createdAt: new Date().toISOString(), before: [], after: [] };
  for (const relative of new Set([...ROOT_FILES, ...await uploadFiles(layout.mapDir), ...entries.map(([file]) => file)])) {
    const record = await describe(layout.mapDir, relative);
    if (record.hash !== null) {
      const target = location(path.join(directory, 'before'), relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(location(layout.mapDir, relative), target);
      await flush(target);
      if (!sameRecord(await describe(path.join(directory, 'before'), relative), record)) fail('upgrade_source_changed');
    }
    manifest.before.push(record);
  }
  for (const [relative, bytes] of entries) {
    const previous = manifest.before.find(record => record.path === relative);
    if (CONTENT_FILE.test(relative) && previous.hash !== null && previous.hash !== hashBytes(bytes)) fail('upgrade_content_conflict');
    await replaceFile(location(path.join(directory, 'after'), relative), bytes);
    manifest.after.push({ path: relative, size: bytes.length, hash: hashBytes(bytes) });
  }
  await replaceFile(path.join(directory, 'manifest.json'), Buffer.from(JSON.stringify(manifest)));
  await loadManifest(layout, id);
  await onStep('prepared');
  await checkLive(layout, manifest);
  await replaceFile(path.join(layout.mapDir, PENDING), Buffer.from(JSON.stringify({ id })));
  await onStep('pending');
  for (const [relative] of entries) {
    await replaceFile(location(layout.mapDir, relative), null, location(path.join(directory, 'after'), relative));
    await onStep(`replaced:${relative}`);
  }
  await onStep('published');
  await rm(path.join(layout.mapDir, PENDING));
  return { id, backupDirectory: directory };
}
