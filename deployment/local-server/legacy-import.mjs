import { lstat, realpath, mkdir, readdir, readFile, writeFile, copyFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createWorldWal } from './world-wal.mjs';
import { applyWorldOperationPatch, migrateLegacySceneFeatureStates, migrateWorldSchema3State } from './world-operations.mjs';
import { prepareContentUpgrade } from './content-storage.mjs';
import { normalizeAccessState } from './access-control.mjs';
import { writeManagedJson, ensureManagedDirectory } from './managed-worlds.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const contains = (a, b) => { const relative = path.relative(a, b);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const stamp = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
async function regular(file, optional = false) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) fail('legacy_import_file_invalid'); return info; }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function sync(file) { const handle = await open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }

async function fingerprint(file, info) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || stamp(before) !== stamp(info)) fail('legacy_import_source_changed');
    const digest = createHash('sha256'); let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length; if (size > MAX_BYTES) fail('legacy_import_too_large'); digest.update(chunk);
    }
    const after = await lstat(file);
    if (after.isSymbolicLink() || stamp(after) !== stamp(before) || size !== before.size
      || stamp(await handle.stat()) !== stamp(before)) fail('legacy_import_source_changed');
    return { size, sha256: digest.digest('hex'), stamp: stamp(before) };
  } finally { await handle.close(); }
}

async function inventory(source) {
  const records = []; let total = 0;
  async function visit(relative) {
    const file = path.join(source, relative), info = await lstat(file);
    if (info.isSymbolicLink()) fail('legacy_import_file_invalid');
    if (info.isDirectory()) {
      if (records.length >= 100000) fail('legacy_import_too_large');
      records.push({ path: relative.split(path.sep).join('/'), directory: true, stamp: stamp(info) });
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else {
      if (!info.isFile() || records.length >= 100000) fail('legacy_import_file_invalid');
      total += info.size; if (total > MAX_BYTES) fail('legacy_import_too_large');
      records.push({ path: relative.split(path.sep).join('/'), ...await fingerprint(file, info) });
    }
  }
  await visit('');
  return records;
}

async function copySourceFile(from, to, record) {
  const sourceHandle = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let targetHandle;
  try {
    const info = await sourceHandle.stat();
    if (!info.isFile() || stamp(info) !== record.stamp) fail('legacy_import_source_changed');
    targetHandle = await open(to, 'wx');
    const digest = createHash('sha256'); let size = 0;
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
      size += chunk.length; if (size > record.size) fail('legacy_import_source_changed');
      digest.update(chunk); await targetHandle.writeFile(chunk);
    }
    const after = await lstat(from);
    if (after.isSymbolicLink() || stamp(after) !== record.stamp || stamp(await sourceHandle.stat()) !== record.stamp
      || size !== record.size || digest.digest('hex') !== record.sha256) fail('legacy_import_source_changed');
    await targetHandle.sync();
  } finally { await targetHandle?.close(); await sourceHandle.close(); }
}

/** Copy first, then replay/migrate/validate the copy. Never modify the chosen old map/ folder. */
export async function importLegacyDirectory({ directory, root, worlds, rulesets }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('legacy_import_directory_invalid');
  const selected = await lstat(directory);
  if (!selected.isDirectory() || selected.isSymbolicLink()) fail('legacy_import_directory_invalid');
  const source = await realpath(directory), destinationRoot = await realpath(root);
  if (contains(source, destinationRoot) || contains(destinationRoot, source)) fail('legacy_import_directory_overlap');
  const info = await lstat(source); if (!info.isDirectory()) fail('legacy_import_directory_invalid');
  await regular(path.join(source, 'world.json'));
  const baseline = await inventory(source);
  const receiptDirectory = await ensureManagedDirectory(destinationRoot, `imports/${randomUUID()}`);
  const original = path.join(receiptDirectory, 'original');
  await mkdir(original, { recursive: true });
  const records = [];
  for (const record of baseline) {
    const relative = record.path.split('/').join(path.sep), from = path.join(source, relative), to = path.join(original, relative);
    const info = await lstat(from);
    if (info.isSymbolicLink() || stamp(info) !== record.stamp) fail('legacy_import_source_changed');
    if (record.directory) { await mkdir(to, { recursive: true }); continue; }
    await copySourceFile(from, to, record);
    const copied = await fingerprint(to, await lstat(to));
    if (copied.sha256 !== record.sha256 || copied.size !== record.size) fail('legacy_import_source_changed');
    records.push({ path: record.path, size: record.size, sha256: record.sha256 });
  }
  async function verifySource() {
    if (JSON.stringify(await inventory(source)) !== JSON.stringify(baseline)) fail('legacy_import_source_changed');
  }
  await verifySource();
  const envelope = JSON.parse(await readFile(path.join(original, 'world.json'), 'utf8'));
  if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.revision) || envelope.revision < 0) fail('legacy_import_world_invalid');
  const replayed = await createWorldWal({ filePath: path.join(original, 'world.operations.ndjson'),
    applyPatch: (state, patch) => applyWorldOperationPatch(state, patch, { project: false, acceptedSchemaVersions: [3, 4] })
  }).replay(envelope, { repairTail: false });
  if (!replayed.state?.preferences?.worldV2) fail('legacy_import_world_missing');
  const rule = await rulesets.get(replayed.state.preferences.worldV2.ruleset);
  const content = await prepareContentUpgrade(replayed.state, path.join(original, 'uploads', 'content'));
  const feature = migrateLegacySceneFeatureStates(content.state);
  const migrated = migrateWorldSchema3State(feature.state, { statusDefinitions: rule.statuses?.definitions });
  await worlds.validateDependencies(migrated.state);
  for (const [relative, bytes] of Object.entries(content.replacements)) {
    const target = path.join(receiptDirectory, 'prepared', ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' }); await sync(target);
  }
  const usersFile = path.join(original, 'users.json');
  let access = null;
  if (await regular(usersFile, true)) {
    const users = JSON.parse(await readFile(usersFile, 'utf8'));
    if (!users || typeof users !== 'object' || !Array.isArray(users.users)) fail('legacy_import_users_invalid');
    access = normalizeAccessState(users);
  }
  await verifySource();
  await writeManagedJson(path.join(receiptDirectory, 'receipt.json'), { formatVersion: 1, source, records, originalRevision: replayed.revision });
  const uploads = records.filter(record => record.path.startsWith('uploads/'));
  for (const [relative, bytes] of Object.entries(content.replacements)) uploads.push({ path: relative, size: bytes.length, sha256: sha(bytes), prepared: true });
  const installed = await worlds.import({ state: migrated.state, exploration: replayed.exploration }, { beforePublish: async ({ directory: worldDirectory }) => {
    for (const record of uploads) {
      const target = path.join(destinationRoot, ...record.path.split('/'));
      const from = path.join(record.prepared ? path.join(receiptDirectory, 'prepared') : original, ...record.path.split('/'));
      await ensureManagedDirectory(destinationRoot, path.posix.dirname(record.path));
      if (await regular(target, true)) {
        if (sha(await readFile(target)) !== record.sha256) fail('legacy_import_upload_conflict');
      } else { await copyFile(from, target, 1); await sync(target); }
      if (sha(await readFile(target)) !== record.sha256) fail('legacy_import_upload_conflict');
    }
    if (access) await writeManagedJson(path.join(worldDirectory, 'users.json'), access);
    await verifySource();
  } });
  await writeManagedJson(path.join(receiptDirectory, 'imported.json'), { worldId: installed.id, completedAt: new Date().toISOString() });
  return { ...installed, originalPreserved: true, receiptDirectory };
}
