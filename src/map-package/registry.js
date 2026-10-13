import { prepareMapPackage } from './contract.js';

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function reference(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const id = text(source.id ?? source.mapId);
  const version = text(source.version ?? source.mapVersion);
  if (!id) {
    const error = new Error('MapPackage reference requires id');
    error.code = 'map_package_reference_missing';
    throw error;
  }
  return Object.freeze({ id, version: version || null });
}

function packageReference(mapPackage) {
  return Object.freeze({
    id: String(mapPackage.id),
    version: String(mapPackage.version ?? mapPackage.mapVersion ?? '1'),
  });
}

const entryKey = ({ id, version }) => JSON.stringify([id, version || null]);
function registryError(message, code) {
  const error = new Error(message); error.code = code; return error;
}

export class MapPackageRegistry {
  constructor() {
    this.entries = new Map();
  }

  registerPackage(rawPackage, { source = 'registry' } = {}) {
    const mapPackage = prepareMapPackage(rawPackage, { source });
    const ref = packageReference(mapPackage);
    const existing = this.entries.get(entryKey(ref));
    if (existing?.package && existing.package !== rawPackage
      && (!existing.package.fingerprint || existing.package.fingerprint !== mapPackage.fingerprint)) {
      throw registryError(`MapPackage ${ref.id}@${ref.version} is already registered`, 'map_package_version_conflict');
    }
    this.entries.set(entryKey(ref), {
      id: ref.id,
      version: ref.version,
      title: String(mapPackage.title || mapPackage.name || ref.id),
      source,
      package: mapPackage,
      loader: null,
    });
    return mapPackage;
  }

  registerLoader({ id, version = null, title = '', source = 'registry', load } = {}) {
    const mapId = text(id);
    if (!mapId || typeof load !== 'function') {
      throw new Error('MapPackage loader requires id and load()');
    }
    const ref = { id: mapId, version: text(version) || null };
    const existing = this.entries.get(entryKey(ref));
    if (existing) return this;
    this.entries.set(entryKey(ref), {
      id: mapId,
      version: text(version) || null,
      title: text(title, mapId),
      source,
      package: null,
      loader: load,
    });
    return this;
  }

  has(id, version = null) {
    const value = typeof id === 'object' ? id : { id, version };
    const ref = reference(value);
    return ref.version ? this.entries.has(entryKey(ref)) : [...this.entries.values()].some(entry => entry.id === ref.id);
  }

  unregister(rawReference) {
    const requested = reference(rawReference);
    if (!requested.version) throw registryError('Removing a package requires an exact version', 'map_package_reference_missing');
    return this.entries.delete(entryKey(requested));
  }

  list() {
    return [...this.entries.values()].map(entry => Object.freeze({
      id: entry.id,
      version: entry.version,
      title: entry.title,
      source: entry.source,
      loaded: Boolean(entry.package),
    }));
  }

  async load(rawReference) {
    const requested = reference(rawReference);
    const matches = [...this.entries.values()].filter(entry => entry.id === requested.id);
    let entry = requested.version ? this.entries.get(entryKey(requested)) : matches.length === 1 ? matches[0] : null;
    if (!entry && requested.version) entry = matches.find(candidate => candidate.version === null);
    if (!requested.version && matches.length > 1) {
      throw registryError(`MapPackage ${requested.id} has multiple versions; specify a version`, 'map_package_version_required');
    }
    if (!entry) {
      const error = new Error(`Unknown MapPackage: ${requested.id}${requested.version ? `@${requested.version}` : ''}`);
      error.code = matches.length ? 'map_package_version_mismatch' : 'map_package_not_found';
      throw error;
    }
    if (!entry.package) {
      if (!entry.pending) entry.pending = (async () => {
        const loaded = await entry.loader();
        const mapPackage = prepareMapPackage(loaded, { source: entry.source });
        const actual = packageReference(mapPackage);
        if (actual.id !== entry.id) throw registryError(`MapPackage loader ${entry.id} returned ${actual.id}`, 'map_package_id_mismatch');
        if (entry.version && entry.version !== actual.version) throw registryError(`MapPackage loader ${entry.id}@${entry.version} returned v${actual.version}`, 'map_package_version_mismatch');
        const previousKey = entryKey(entry), actualKey = entryKey(actual), existing = this.entries.get(actualKey);
        if (existing && existing !== entry) throw registryError(`MapPackage ${actual.id}@${actual.version} is already registered`, 'map_package_version_conflict');
        entry.package = mapPackage; entry.version = actual.version;
        entry.title = String(mapPackage.title || mapPackage.name || actual.id);
        if (previousKey !== actualKey) { this.entries.delete(previousKey); this.entries.set(actualKey, entry); }
      })();
      try { await entry.pending; } finally { entry.pending = null; }
    }
    const actual = packageReference(entry.package);
    if (requested.version && requested.version !== actual.version) {
      const error = new Error(`MapPackage ${requested.id} requires v${requested.version}; loaded v${actual.version}`);
      error.code = 'map_package_version_mismatch';
      throw error;
    }
    return entry.package;
  }

  async require(rawReference) {
    return this.load(rawReference);
  }

  reference(mapPackage) {
    return packageReference(mapPackage);
  }
}

export const mapPackageRegistry = new MapPackageRegistry();

export function normalizeMapPackageReference(value) {
  return reference(value);
}
