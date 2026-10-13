import { mkdir, readdir, readFile, writeFile, rename, rm, lstat, open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readMapArchiveFiles, writeMapArchiveFiles, validateMapArchivePath, mapFileHash, validateStaticMapSvg, packageContentFingerprint } from '../../src/packages/map-archive.js';
import { prepareRuleset, RULESET_API_VERSION } from '../../src/ruleset/contract.js';

function failure(message, code = 'ruleset_archive_invalid', details) {
  const error = new Error(message); error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
function reference(value) {
  const id = value?.id ?? value?.rulesetId, version = value?.version ?? value?.rulesetVersion;
  for (const part of [id, version]) {
    if (typeof part !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(part)) throw failure('Ruleset reference requires exact id and version', 'world_ruleset_missing');
    validateMapArchivePath(part);
  }
  return { id, version };
}
const key = ref => JSON.stringify([ref.id, ref.version]);
const text = (bytes, label) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw failure(`${label} is not UTF-8`); }
};
function safeGraph(value, depth = 0) {
  if (depth > 30) throw failure('Manifest nesting exceeds limit');
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw failure('Manifest has a reserved property');
    safeGraph(child, depth + 1);
  }
}
function allowedFile(name) {
  if (['manifest.json', 'README.md'].includes(name) || /^(?:entry\.mjs|modules\/[a-zA-Z0-9._/-]+\.mjs)$/.test(name)
    || /^assets\/.+\.(png|webp|jpe?g|gif|svg|json|css)$/i.test(name)) return;
  throw failure(`Unsupported ruleset file: ${name}`);
}
function within(directory, target) {
  const relative = path.relative(directory, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure('Ruleset path escapes installation directory');
  return target;
}

/** Trusted extensions contain executable JavaScript. Hashes provide integrity, not a sandbox. */
export function inspectRulesetArchive(bytes) {
  const files = readMapArchiveFiles(bytes, { validateFile: allowedFile });
  let manifest;
  try { manifest = JSON.parse(text(files.get('manifest.json') || new Uint8Array(), 'manifest.json')); } catch { throw failure('Ruleset manifest is missing or invalid'); }
  safeGraph(manifest);
  if (manifest.format !== 'rpgrules' || manifest.formatVersion !== 1 || manifest.apiVersion !== RULESET_API_VERSION) {
    throw failure('Incompatible ruleset contract', 'ruleset_archive_incompatible');
  }
  reference(manifest);
  if (manifest.entry !== 'entry.mjs' || !files.has(manifest.entry)) throw failure('Ruleset must provide entry.mjs');
  if (!Array.isArray(manifest.files) || manifest.files.length !== files.size - 1) throw failure('Ruleset file inventory mismatch');
  const declared = new Set();
  for (const entry of manifest.files) {
    const name = validateMapArchivePath(entry?.path), payload = files.get(name);
    if (!payload || name === 'manifest.json' || declared.has(name) || payload.length !== entry.size || mapFileHash(payload) !== entry.sha256) {
      throw failure(`Ruleset checksum differs: ${name}`, 'ruleset_archive_corrupt');
    }
    declared.add(name);
  }
  for (const [name, payload] of files) {
    if (name.endsWith('.mjs')) text(payload, name);
    if (name.endsWith('.svg')) validateStaticMapSvg(text(payload, name), files, name);
  }
  const fingerprint = packageContentFingerprint(manifest, files);
  return { manifest, files, fingerprint };
}

export function buildRulesetArchive({ ruleset, entry, files = new Map(), metadata = {} }) {
  const payloads = new Map(files instanceof Map ? files : Object.entries(files));
  if (payloads.has('manifest.json') || payloads.has('entry.mjs')) throw failure('Ruleset assets cannot replace required files');
  for (const [name, payload] of payloads) payloads.set(name, Buffer.from(payload));
  payloads.set('entry.mjs', Buffer.from(entry));
  const manifest = { ...metadata, format: 'rpgrules', formatVersion: 1, apiVersion: RULESET_API_VERSION,
    id: ruleset.id, version: ruleset.version, title: ruleset.title, entry: 'entry.mjs',
    files: [...payloads].map(([name, payload]) => ({ path: name, size: payload.length, sha256: mapFileHash(payload) })).sort((a, b) => a.path.localeCompare(b.path)) };
  payloads.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  const archive = writeMapArchiveFiles(payloads); inspectRulesetArchive(archive); return archive;
}

export class RulesetPackageStore {
  constructor({ root, assetBase = '/api/packages/rulesets', builtins = [] } = {}) {
    if (!root) throw new TypeError('RulesetPackageStore requires root');
    this.root = path.resolve(root); this.assetBase = assetBase.replace(/\/$/, '');
    this.entries = new Map(); this.builtins = new Map(); this.versions = new Map(); this.initialized = false; this.queue = Promise.resolve();
    for (const raw of builtins) {
      const ruleset = prepareRuleset(raw), ref = reference(ruleset);
      this.builtins.set(key(ref), { ruleset, metadata: Object.freeze({ ...ref, title: ruleset.title, apiVersion: ruleset.apiVersion, builtIn: true }) });
    }
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
    this.root = realpathSync(this.root);
    const versions = await this._readVersions();
    const entries = new Map();
    for (const idDir of await readdir(this.root, { withFileTypes: true })) {
      if (!idDir.isDirectory() || idDir.isSymbolicLink() || idDir.name.startsWith('.')) continue;
      validateMapArchivePath(idDir.name);
      for (const versionDir of await readdir(path.join(this.root, idDir.name), { withFileTypes: true })) {
        if (!versionDir.isDirectory() || versionDir.isSymbolicLink()) continue;
        const directory = path.join(this.root, idDir.name, versionDir.name), stored = path.join(directory, 'package.rpgrules');
        if ((await lstat(stored)).isSymbolicLink()) throw failure('Ruleset archive cannot be a symlink');
        const inspected = inspectRulesetArchive(await readFile(stored));
        if (inspected.manifest.id !== idDir.name || inspected.manifest.version !== versionDir.name) throw failure('Ruleset directory identity mismatch');
        const ref = reference(inspected.manifest), versionKey = key(ref);
        if (this.builtins.has(versionKey)) throw this._builtinFailure(ref);
        if (versions.has(versionKey) && versions.get(versionKey).fingerprint !== inspected.fingerprint) {
          throw failure('This ruleset version previously had different content; increase its version', 'ruleset_package_version_conflict');
        }
        // Every module in the graph has a content-specific URL, including imports
        // relative to entry.mjs. Legacy flat installations remain readable.
        const content = path.join(directory, `content-${inspected.fingerprint}`);
        let contentDirectory = directory;
        try {
          const stat = await lstat(content);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('Ruleset content directory is invalid');
          contentDirectory = within(realpathSync(directory), realpathSync(content));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const actualDirectory = realpathSync(contentDirectory);
        for (const [name, payload] of inspected.files) {
          const actual = await readFile(within(actualDirectory, realpathSync(path.join(contentDirectory, ...name.split('/')))));
          if (mapFileHash(actual) !== mapFileHash(payload)) throw failure(`Installed ruleset has been modified: ${name}`, 'ruleset_archive_corrupt');
        }
        const record = this._record(inspected, actualDirectory, realpathSync(directory)); entries.set(versionKey, record);
        versions.set(versionKey, { ...ref, fingerprint: inspected.fingerprint });
      }
    }
    await this._persistVersions(versions);
    this.entries = entries; this.initialized = true; return this;
  }
  _builtinFailure(ref) {
    return failure(`规则 ${ref.id}@${ref.version} 已由应用内置。同版本外部包不能覆盖内置规则；更新规则请使用新版本。`, 'rule_builtin_version', ref);
  }
  async _readVersions() {
    const file = path.join(this.root, '.versions.json');
    let bytes;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw failure('Ruleset version history is invalid', 'ruleset_version_history_invalid');
      bytes = await readFile(file);
    } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
    const history = JSON.parse(text(bytes, '.versions.json'));
    safeGraph(history);
    if (history.schemaVersion !== 1 || !Array.isArray(history.versions)) throw failure('Ruleset version history is invalid', 'ruleset_version_history_invalid');
    const versions = new Map();
    for (const item of history.versions) {
      const ref = reference(item), versionKey = key(ref);
      if (versions.has(versionKey) || !/^[a-f0-9]{64}$/.test(item.fingerprint)) throw failure('Ruleset version history is invalid', 'ruleset_version_history_invalid');
      versions.set(versionKey, { ...ref, fingerprint: item.fingerprint });
    }
    return versions;
  }
  async _persistVersions(versions) {
    const file = path.join(this.root, '.versions.json'), temporary = `${file}.${randomUUID()}.tmp`;
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, versions: [...versions.values()] }));
    try {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (!(await readFile(temporary)).equals(bytes)) throw failure('Ruleset version history write verification failed');
      await rename(temporary, file);
      this.versions = versions;
    } finally { await rm(temporary, { force: true }); }
  }
  _record(inspected, directory, installationDirectory = directory) {
    const ref = reference(inspected.manifest);
    return { directory, installationDirectory, manifest: inspected.manifest, fingerprint: inspected.fingerprint,
      files: new Set(inspected.files.keys()), pending: null, ruleset: null,
      metadata: Object.freeze({ ...ref, title: inspected.manifest.title || ref.id, apiVersion: inspected.manifest.apiVersion,
        fingerprint: inspected.fingerprint, builtIn: false,
        entryUrl: `${this.assetBase}/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.version)}/files/${inspected.manifest.entry}` }) };
  }
  list() {
    const merged = new Map([...this.builtins].map(([id, entry]) => [id, entry.metadata]));
    for (const [id, entry] of this.entries) merged.set(id, entry.metadata);
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
  }
  _serialize(action) {
    const result = this.queue.then(action); this.queue = result.catch(() => {}); return result;
  }
  async install(bytes) {
    const archive = Buffer.from(bytes), inspected = inspectRulesetArchive(archive);
    return this._serialize(async () => {
      if (!this.initialized) await this.initialize();
      const ref = reference(inspected.manifest), existing = this.entries.get(key(ref));
      if (this.builtins.has(key(ref))) throw this._builtinFailure(ref);
      if (existing) {
        if (existing.fingerprint !== inspected.fingerprint) throw failure('This ruleset version already has different content; increase its version', 'ruleset_package_version_conflict');
        return { ...existing.metadata, reused: true };
      }
      const previous = this.versions.get(key(ref));
      if (previous && previous.fingerprint !== inspected.fingerprint) {
        throw failure('This ruleset version previously had different content; increase its version', 'ruleset_package_version_conflict');
      }
      const staging = within(this.root, path.join(this.root, `.staging-${randomUUID()}`));
      const destination = within(this.root, path.join(this.root, ref.id, ref.version));
      await mkdir(staging);
      let installed = false;
      try {
        const contentDirectory = path.join(staging, `content-${inspected.fingerprint}`);
        await mkdir(contentDirectory);
        for (const [name, payload] of inspected.files) {
          const target = within(contentDirectory, path.join(contentDirectory, ...name.split('/')));
          await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, payload, { flag: 'wx' });
        }
        await writeFile(path.join(staging, 'package.rpgrules'), archive, { flag: 'wx' });
        await mkdir(path.dirname(destination), { recursive: true });
        within(this.root, realpathSync(path.dirname(destination)));
        try { await lstat(destination); throw failure('Ruleset directory already exists', 'ruleset_package_version_conflict'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(staging, destination); installed = true;
        const record = this._record(inspected, realpathSync(path.join(destination, `content-${inspected.fingerprint}`)), realpathSync(destination));
        // Do not publish an invalid module; only execute after all file integrity checks and installation.
        await this._load(record);
        const versions = new Map(this.versions);
        versions.set(key(ref), { ...ref, fingerprint: inspected.fingerprint });
        await this._persistVersions(versions);
        this.entries.set(key(ref), record); return { ...record.metadata, reused: false };
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        if (installed) await rm(destination, { recursive: true, force: true });
        throw error;
      }
    });
  }
  async _load(record) {
    if (record.ruleset) return record.ruleset;
    if (!record.pending) record.pending = (async () => {
      const filename = within(record.directory, realpathSync(path.join(record.directory, record.manifest.entry)));
      const module = await import(`${pathToFileURL(filename).href}?sha256=${record.fingerprint}`);
      const prepared = prepareRuleset(module.default ?? module.ruleset ?? module);
      if (prepared.id !== record.metadata.id || prepared.version !== record.metadata.version || prepared.apiVersion !== record.metadata.apiVersion) {
        throw failure('Ruleset module identity differs from its manifest', 'ruleset_package_identity_mismatch');
      }
      record.ruleset = prepared; return prepared;
    })();
    try { return await record.pending; } finally { record.pending = null; }
  }
  async get(rawReference) {
    const ref = reference(rawReference), record = this.entries.get(key(ref));
    if (record) return this._load(record);
    const builtin = this.builtins.get(key(ref));
    if (builtin) return builtin.ruleset;
    throw failure(`Ruleset ${ref.id}@${ref.version} is not installed`, this.list().some(item => item.id === ref.id) ? 'ruleset_version_incompatible' : 'unknown_ruleset');
  }
  file(rawReference, name) {
    const ref = reference(rawReference), record = this.entries.get(key(ref)), safeName = validateMapArchivePath(name);
    if (!record || !record.files.has(safeName)) throw failure('Ruleset resource is not installed', 'ruleset_package_file_not_found');
    return within(record.directory, realpathSync(path.join(record.directory, ...safeName.split('/'))));
  }
  async remove(rawReference, { references = [] } = {}) {
    const ref = reference(rawReference);
    return this._serialize(async () => {
      const relevant = references.filter(item => {
        const candidate = item?.ruleset ?? item, id = candidate?.id ?? candidate?.rulesetId, version = candidate?.version ?? candidate?.rulesetVersion;
        return !id || id === ref.id && (!version || version === ref.version);
      });
      if (relevant.length) throw failure('Ruleset is still referenced', 'ruleset_package_in_use', relevant);
      if (this.builtins.has(key(ref))) throw this._builtinFailure(ref);
      const record = this.entries.get(key(ref));
      if (!record) throw failure('Ruleset package is not installed', 'unknown_ruleset');
      const tombstone = within(this.root, path.join(this.root, `.removing-${randomUUID()}`));
      await rename(record.installationDirectory, tombstone); this.entries.delete(key(ref));
      await rm(tombstone, { recursive: true, force: true }); return { ...record.metadata, removed: true };
    });
  }
}

export function createRulesetPackageStore(options) { return new RulesetPackageStore(options); }
