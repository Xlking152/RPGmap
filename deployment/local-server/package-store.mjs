import { mkdir, readdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectMapArchive, rewriteMapArchiveResources, validateMapArchivePath, mapFileHash } from '../../src/packages/map-archive.js';
import { prepareMapPackage } from '../../src/map-package/contract.js';

function error(message, code, details = undefined) {
  const failure = new Error(message); failure.code = code;
  if (details !== undefined) failure.details = details;
  return failure;
}
function reference(value) {
  const id = value?.id ?? value?.mapId, version = value?.version ?? value?.mapVersion;
  if (!id || !version || typeof id !== 'string' || typeof version !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(version)) {
    throw error('Map reference requires an exact id and version', 'map_package_reference_missing');
  }
  validateMapArchivePath(id); validateMapArchivePath(version);
  return { id, version };
}
const key = ref => JSON.stringify([ref.id, ref.version]);
function freeze(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); Object.values(value).forEach(child => freeze(child, seen)); Object.freeze(value);
  }
  return value;
}
function within(directory, file) {
  const relative = path.relative(directory, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw error('Package path escapes its directory', 'map_archive_path_invalid');
  }
  return file;
}
function packageRecord(inspected, directory, assetBase) {
  const ref = reference(inspected.manifest);
  const metadata = freeze({ id: ref.id, version: ref.version, title: inspected.manifest.title || ref.id,
    name: inspected.data.name || inspected.manifest.title || ref.id,
    fingerprint: inspected.fingerprint, formatVersion: inspected.manifest.formatVersion,
    featureCount: inspected.data.features.length, width: inspected.data.width, height: inspected.data.height,
    ...(inspected.manifest.author ? { author: inspected.manifest.author } : {}),
    ...(inspected.files.has('preview.webp') ? { previewUrl: `${assetBase}/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.version)}/files/preview.webp` } : {}) });
  const pkg = prepareMapPackage({ ...rewriteMapArchiveResources(inspected, ref, assetBase), manifest: freeze(inspected.manifest),
    fingerprint: inspected.fingerprint }, { source: 'installed-map-package' });
  freeze(pkg); // prepareMapPackage freezes its outer node; static JSON children are also immutable.
  return { directory, metadata, package: pkg, files: new Set(inspected.files.keys()) };
}

/** Installed content is immutable. Authoritative geometry and served assets share one archive receipt. */
export class MapPackageStore {
  constructor({ root, assetBase = '/api/packages/maps' } = {}) {
    if (!root) throw new TypeError('MapPackageStore requires root');
    this.root = path.resolve(root);
    this.assetBase = String(assetBase).replace(/\/$/, '');
    this.entries = new Map(); this.initialized = false; this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    this.root = realpathSync(this.root);
    const loaded = new Map();
    for (const idDir of await readdir(this.root, { withFileTypes: true })) {
      if (idDir.name.startsWith('.staging-') || idDir.name.startsWith('.removing-')) continue;
      if (!idDir.isDirectory() || idDir.isSymbolicLink()) continue;
      validateMapArchivePath(idDir.name);
      for (const versionDir of await readdir(path.join(this.root, idDir.name), { withFileTypes: true })) {
        if (!versionDir.isDirectory() || versionDir.isSymbolicLink()) continue;
        validateMapArchivePath(versionDir.name);
        const directory = path.join(this.root, idDir.name, versionDir.name);
        const archivePath = path.join(directory, 'package.rpgmap');
        if ((await lstat(archivePath)).isSymbolicLink()) throw error('Installed archive cannot be a symlink', 'map_archive_path_invalid');
        const inspected = inspectMapArchive(await readFile(archivePath));
        if (inspected.manifest.id !== idDir.name || inspected.manifest.version !== versionDir.name) {
          throw error('Installed map directory identity differs from manifest', 'map_archive_identity_mismatch');
        }
        const actualDirectory = realpathSync(directory);
        for (const [name, expected] of inspected.files) {
          const absolute = within(actualDirectory, realpathSync(path.join(directory, ...name.split('/'))));
          const actual = await readFile(absolute);
          if (actual.length !== expected.length || mapFileHash(actual) !== mapFileHash(expected)) {
            throw error(`Installed map file was modified: ${name}`, 'map_archive_corrupt');
          }
        }
        const record = packageRecord(inspected, actualDirectory, this.assetBase);
        loaded.set(key(record.metadata), record);
      }
    }
    this.entries = loaded; this.initialized = true;
    return this;
  }

  list() {
    return [...this.entries.values()].map(entry => entry.metadata).sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
  }

  _serialize(action) {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }

  async install(bytes) {
    // Copy before entering the queue so a caller cannot mutate a pending import.
    const archive = Buffer.from(bytes);
    const inspected = inspectMapArchive(archive);
    return this._serialize(async () => {
      if (!this.initialized) await this.initialize();
      const ref = reference(inspected.manifest), entryKey = key(ref), existing = this.entries.get(entryKey);
      if (existing) {
        if (existing.metadata.fingerprint !== inspected.fingerprint) throw error(`Map ${ref.id}@${ref.version} already has different content; increase its version`, 'map_package_version_conflict');
        return { ...existing.metadata, reused: true };
      }
      const staging = within(this.root, path.join(this.root, `.staging-${randomUUID()}`));
      const destination = within(this.root, path.join(this.root, ref.id, ref.version));
      await mkdir(staging, { recursive: false });
      try {
        for (const [name, payload] of inspected.files) {
          const target = within(staging, path.join(staging, ...name.split('/')));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, payload, { flag: 'wx' });
        }
        await writeFile(path.join(staging, 'package.rpgmap'), archive, { flag: 'wx' });
        await mkdir(path.dirname(destination), { recursive: true });
        within(this.root, realpathSync(path.dirname(destination)));
        // Windows rename fails when destination exists; cross-process imports never overwrite it.
        try { await lstat(destination); throw error(`Map ${ref.id}@${ref.version} already exists on disk`, 'map_package_version_conflict'); }
        catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
        await rename(staging, destination);
        const record = packageRecord(inspected, realpathSync(destination), this.assetBase);
        this.entries.set(entryKey, record);
        return { ...record.metadata, reused: false };
      } catch (failure) {
        await rm(staging, { recursive: true, force: true });
        throw failure;
      }
    });
  }

  get(rawReference) {
    const ref = reference(rawReference), record = this.entries.get(key(ref));
    if (!record) throw error(`Map ${ref.id}@${ref.version} is not installed`, 'map_package_not_found', ref);
    return record.package;
  }

  mapForScene(scene) {
    return this.get(scene?.map ?? scene?.mapPackage ?? { id: scene?.mapId, version: scene?.mapVersion });
  }

  file(rawReference, name) {
    const ref = reference(rawReference), record = this.entries.get(key(ref));
    if (!record) throw error(`Map ${ref.id}@${ref.version} is not installed`, 'map_package_not_found');
    const safeName = validateMapArchivePath(name);
    if (!record.files.has(safeName)) throw error(`Map resource ${safeName} is missing`, 'map_package_file_not_found');
    return within(record.directory, realpathSync(path.join(record.directory, ...safeName.split('/'))));
  }

  async remove(rawReference, { references = [] } = {}) {
    const ref = reference(rawReference);
    return this._serialize(async () => {
      const relevant = references.filter(item => {
        const candidate = item?.map ?? item?.mapPackage ?? item;
        const id = candidate?.id ?? candidate?.mapId, version = candidate?.version ?? candidate?.mapVersion;
        return !id || id === ref.id && (!version || version === ref.version);
      });
      if (relevant.length) throw error(`Map ${ref.id}@${ref.version} is still referenced`, 'map_package_in_use', relevant);
      const record = this.entries.get(key(ref));
      if (!record) throw error(`Map ${ref.id}@${ref.version} is not installed`, 'map_package_not_found');
      const tombstone = within(this.root, path.join(this.root, `.removing-${randomUUID()}`));
      await rename(record.directory, tombstone);
      this.entries.delete(key(ref));
      await rm(tombstone, { recursive: true, force: true });
      return { ...record.metadata, removed: true };
    });
  }
}

export function createMapPackageStore(options) { return new MapPackageStore(options); }
