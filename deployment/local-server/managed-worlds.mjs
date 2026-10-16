import { mkdir, readFile, writeFile, rename, readdir, open, lstat, realpath, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { createInitialState } from '../../src/engine/state.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../../src/world/model.js';
import { commitStorageUpgrade, recoverStorageUpgrade } from './storage-upgrade.mjs';
import { collectContentReferences } from '../../src/content/references.js';
import { hasRetainedContentReference } from './content-history.mjs';
import { validateExploration } from './exploration-queue.mjs';

function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || /[.]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail('invalid_world_id');
  return value;
}
/** Create beneath an established data root without following directory links. */
export async function ensureManagedDirectory(root, relative = '') {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('managed_directory_invalid');
  const canonical = await realpath(root);
  const parts = relative ? relative.split(/[\\/]/) : [];
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) fail('managed_directory_invalid');
  let directory = canonical;
  for (const part of parts) {
    directory = path.join(directory, part);
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('managed_directory_invalid');
    const resolved = await realpath(directory), suffix = path.relative(canonical, resolved);
    if (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) fail('managed_directory_invalid');
  }
  return directory;
}
export async function writeManagedJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(JSON.stringify(value));
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (!(await readFile(temporary)).equals(bytes)) fail('storage_verification_failed');
  await rename(temporary, file);
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function stateReferences(state) {
  const world = state?.preferences?.worldV2;
  return (world?.scenes || []).map(scene => ({ ...scene.mapPackage, worldId: world.id, sceneId: scene.id, name: scene.name }));
}
function assertStoredIdentity(id, snapshot) {
  if (snapshot?.worldId !== id || snapshot?.state?.preferences?.worldV2?.id !== id) fail('world_identity_mismatch');
}
/** Automatic checkpoints and upgrade rollback sets are also retained recovery points. */
async function retainedWorldSnapshots(directory, worldId) {
  const backups = path.join(directory, 'backups');
  let info;
  try { info = await lstat(backups); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('backup_unreadable');
  const result = [];
  async function readSnapshot(file, expected = null) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('backup_unreadable');
    const bytes = await readFile(file);
    if (expected && (stat.size !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.hash)) fail('backup_checksum_invalid');
    try { return JSON.parse(bytes.toString('utf8')); } catch { fail('backup_unreadable'); }
  }
  for (const entry of await readdir(backups, { withFileTypes: true })) {
    if (entry.name.startsWith('world.') && entry.name.endsWith('.json')) {
      const snapshot = await readSnapshot(path.join(backups, entry.name));
      result.push({ snapshot, backupId: `automatic:${worldId}/${entry.name}` });
    } else if (/^upgrade-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('backup_unreadable');
      const upgrade = path.join(backups, entry.name);
      // A failed preparation can leave a directory before its verified receipt
      // exists. It has never become a usable recovery point.
      try { await lstat(path.join(upgrade, 'manifest.json')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const manifest = await readSnapshot(path.join(upgrade, 'manifest.json'));
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.before) || !Array.isArray(manifest.after)) fail('backup_unreadable');
      for (const side of ['before', 'after']) {
        const record = manifest[side].find(record => record.path === 'world.json');
        if (!record || record.hash === null) continue;
        if (!Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.hash)) fail('backup_unreadable');
        const sideDirectory = path.join(upgrade, side), sideInfo = await lstat(sideDirectory);
        if (!sideInfo.isDirectory() || sideInfo.isSymbolicLink()) fail('backup_unreadable');
        const snapshot = await readSnapshot(path.join(sideDirectory, 'world.json'), record);
        result.push({ snapshot, backupId: `upgrade:${worldId}/${entry.name}/${side}` });
      }
    }
  }
  return result;
}

/** Management data remains outside the replaceable application directory. */
export class ManagedWorldStore {
  constructor({ root, maps, rulesets, validateState = () => {} }) {
    this.root = path.resolve(root); this.maps = maps; this.rulesets = rulesets; this.validateState = validateState;
    this.catalogFile = path.join(this.root, 'config', 'catalog.json');
    this.catalog = { schemaVersion: 1, activeWorldId: null, worlds: [] };
    this.mutationChain = Promise.resolve();
    // Public store callers also receive atomic catalogue mutations, even outside HTTP.
    for (const name of ['create', 'import', 'activate', 'restore']) {
      const mutation = this[name].bind(this);
      this[name] = (...args) => {
        const pending = this.mutationChain.then(() => mutation(...args));
        this.mutationChain = pending.catch(() => {});
        return pending;
      };
    }
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
    await ensureManagedDirectory(this.root, 'worlds');
    await ensureManagedDirectory(this.root, 'backups');
    await ensureManagedDirectory(this.root, 'config');
    const catalog = await readJson(this.catalogFile);
    if (catalog) {
      if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.worlds)) fail('world_catalog_invalid');
      const ids = new Set();
      for (const world of catalog.worlds) { safeId(world.id); if (ids.has(world.id)) fail('world_catalog_duplicate'); ids.add(world.id); }
      if (catalog.activeWorldId && !ids.has(catalog.activeWorldId)) fail('world_catalog_invalid');
      this.catalog = catalog;
      for (const world of catalog.worlds) await recoverStorageUpgrade(this.restoreLayout(world.id));
    }
    return this;
  }
  list() { return structuredClone(this.catalog.worlds); }
  activeId() { return this.catalog.activeWorldId; }
  worldDirectory(id) { return path.join(this.root, 'worlds', safeId(id)); }
  restoreLayout(id) { const mapDir = this.worldDirectory(id); return { mapDir, backupsDir: path.join(mapDir, 'backups') }; }
  async persistCatalog(next) { await writeManagedJson(this.catalogFile, next); this.catalog = next; }
  async validateDependencies(state) {
    this.validateState(state);
    const world = state?.preferences?.worldV2;
    if (!world?.id || !world?.ruleset?.version) fail('world_ruleset_missing');
    const ruleset = await this.rulesets.get(world.ruleset);
    if (!ruleset) fail('unknown_ruleset');
    for (const scene of world.scenes) if (!this.maps.get(scene.mapPackage)) fail('map_package_not_found');
    return ruleset;
  }
  async create({ name, ruleset, mapPackage }) {
    const map = this.maps.get(mapPackage), rule = await this.rulesets.get(ruleset);
    const id = `world-${randomUUID()}`, now = new Date().toISOString();
    let state = createInitialState(map);
    const world = createWorldV2FromRuntimeState(state, { mapPackage: map, ruleset: rule, worldId: id, worldName: String(name || '新 World').slice(0, 160) });
    state = projectWorldV2ToRuntimeState(state, world, { mapPackage: map, ruleset: rule });
    await this.validateDependencies(state);
    const envelope = { schemaVersion: 1, worldId: id, revision: 0, updatedAt: now, state, recentStatusOperations: [] };
    await writeManagedJson(path.join(this.worldDirectory(id), 'world.json'), envelope);
    const descriptor = { id, name: world.name, ruleset: world.ruleset, createdAt: now, updatedAt: now };
    await this.persistCatalog({ ...this.catalog, worlds: [...this.catalog.worlds, descriptor] });
    return descriptor;
  }
  async import(raw, { beforePublish = async () => {} } = {}) {
    const state = raw?.state || raw;
    await this.validateDependencies(state);
    const original = state.preferences.worldV2;
    let id = this.catalog.worlds.some(entry => entry.id === original.id) ? `world-${randomUUID()}` : safeId(original.id);
    try { await lstat(this.worldDirectory(id)); id = `world-${randomUUID()}`; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const copy = structuredClone(state); copy.preferences.worldV2.id = id;
    const exploration = raw?.state && raw.exploration ? structuredClone(validateExploration(raw.exploration)) : null;
    if (exploration) {
      // Imports start a new authority baseline. Keep accepted work and cursors,
      // but fence responses/cache entries belonging to the original campaign.
      exploration.worldEpoch = randomUUID();
      for (const job of Object.values(exploration.jobs)) job.worldEpoch = exploration.worldEpoch;
      validateExploration(exploration);
    }
    if (exploration) for (const job of Object.values(exploration.jobs)) {
      const scene = copy.preferences.worldV2.scenes.find(scene => scene.id === job.sceneId);
      // Already accepted paths remain valid when their source Token was later
      // removed. The durable job contains its original geometry and path.
      if (!scene) fail('exploration_queue_invalid');
    }
    const now = new Date().toISOString();
    // Imported operation history belongs to the original server. Start a new baseline.
    const descriptor = { id, name: original.name, ruleset: original.ruleset, createdAt: now, updatedAt: now, importedFrom: original.id };
    const parent = await ensureManagedDirectory(this.root, 'worlds');
    const staging = await ensureManagedDirectory(this.root, `worlds/.import-${randomUUID()}`);
    const destination = path.join(parent, id);
    let published = false;
    try {
      await writeManagedJson(path.join(staging, 'world.json'), { schemaVersion: 1, worldId: id, revision: 0,
        updatedAt: now, state: copy, ...(exploration ? { exploration } : {}), recentStatusOperations: [] });
      await beforePublish({ directory: staging, id });
      await ensureManagedDirectory(this.root, 'worlds');
      await rename(staging, destination); published = true;
      await this.persistCatalog({ ...this.catalog, worlds: [...this.catalog.worlds, descriptor] });
      return descriptor;
    } catch (error) {
      // Only paths created by this import are removed. No existing World is overwritten.
      await rm(published ? destination : staging, { recursive: true, force: true });
      throw error;
    }
  }
  async activate(id) {
    if (!this.catalog.worlds.some(world => world.id === id)) fail('world_not_found');
    const snapshot = await readJson(path.join(this.worldDirectory(id), 'world.json'));
    assertStoredIdentity(id, snapshot);
    await this.validateDependencies(snapshot.state);
    await this.persistCatalog({ ...this.catalog, activeWorldId: id });
    return snapshot;
  }
  async backup({ worldId, snapshot, access, reason = 'manual', sceneId = null }) {
    const id = `${Date.now()}-${randomUUID()}`;
    const world = snapshot || await readJson(path.join(this.worldDirectory(worldId), 'world.json'));
    if (!world?.state) fail('world_uninitialized');
    assertStoredIdentity(worldId, world);
    const record = { schemaVersion: 1, id, worldId: safeId(worldId), sceneId, reason, createdAt: new Date().toISOString(),
      snapshot: structuredClone(world), access: access || await readJson(path.join(this.worldDirectory(worldId), 'users.json')) };
    const bytes = JSON.stringify(record);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await writeManagedJson(path.join(this.root, 'backups', `${id}.json`), { checksum, record });
    return { id, worldId, sceneId, reason, createdAt: record.createdAt, checksum };
  }
  async backups(worldId = null) {
    const files = await readdir(path.join(this.root, 'backups'));
    const results = [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
      const item = await readJson(path.join(this.root, 'backups', file));
      if (!item?.record || createHash('sha256').update(JSON.stringify(item.record)).digest('hex') !== item.checksum) fail('backup_checksum_invalid');
      if (!worldId || item.record.worldId === worldId) results.push(item);
    }
    return results;
  }
  async restore({ worldId, backupId }) {
    const item = (await this.backups(worldId)).find(item => item.record.id === backupId);
    if (!item) fail('backup_not_found');
    assertStoredIdentity(worldId, item.record.snapshot);
    await this.validateDependencies(item.record.snapshot.state);
    await this.backup({ worldId, reason: 'before-restore' });
    const replacements = { 'world.json': Buffer.from(JSON.stringify(item.record.snapshot)), 'world.operations.ndjson': Buffer.alloc(0) };
    if (item.record.access) replacements['users.json'] = Buffer.from(JSON.stringify(item.record.access));
    const layout = this.restoreLayout(worldId);
    try { await commitStorageUpgrade(layout, replacements); }
    catch (error) {
      // The receipt keeps the complete old set. Roll back now; if interrupted,
      // initialize() performs the same verified recovery before serving data.
      await recoverStorageUpgrade(layout);
      throw error;
    }
    return { id: backupId, worldId };
  }
  async references(ref, { type = 'map', activeSnapshot = null } = {}) {
    const result = [];
    const match = state => type === 'map' ? stateReferences(state) : [{ ...state?.preferences?.worldV2?.ruleset, worldId: state?.preferences?.worldV2?.id }];
    const inspect = (state, extra = {}) => {
      for (const reference of match(state)) if (reference.id === ref.id && reference.version === ref.version) result.push({ ...reference, ...extra });
    };
    for (const descriptor of this.catalog.worlds) {
      const state = descriptor.id === activeSnapshot?.worldId ? activeSnapshot.state
        : (await readJson(path.join(this.worldDirectory(descriptor.id), 'world.json')))?.state;
      inspect(state);
      for (const { snapshot, backupId } of await retainedWorldSnapshots(this.worldDirectory(descriptor.id), descriptor.id)) inspect(snapshot?.state, { backupId });
    }
    if (activeSnapshot?.state && !this.catalog.worlds.some(entry => entry.id === activeSnapshot.worldId)) inspect(activeSnapshot.state);
    for (const { record } of await this.backups()) inspect(record.snapshot.state, { backupId: record.id });
    return result;
  }
  async retainsContent(reference) {
    for (const descriptor of this.catalog.worlds) {
      const mapDir = this.worldDirectory(descriptor.id);
      if (await hasRetainedContentReference({ worldFile: path.join(mapDir, 'world.json'), operationsFile: path.join(mapDir, 'world.operations.ndjson'), backupsDir: path.join(mapDir, 'backups') }, reference)) return true;
      for (const { snapshot } of await retainedWorldSnapshots(mapDir, descriptor.id)) if (collectContentReferences(snapshot).has(reference)) return true;
    }
    return (await this.backups()).some(item => collectContentReferences(item.record.snapshot).has(reference));
  }
}
