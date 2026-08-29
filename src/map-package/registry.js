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

export class MapPackageRegistry {
  constructor() {
    this.entries = new Map();
  }

  registerPackage(rawPackage, { source = 'registry' } = {}) {
    const mapPackage = prepareMapPackage(rawPackage, { source });
    const ref = packageReference(mapPackage);
    this.entries.set(ref.id, {
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
    this.entries.set(mapId, {
      id: mapId,
      version: text(version) || null,
      title: text(title, mapId),
      source,
      package: null,
      loader: load,
    });
    return this;
  }

  has(id) {
    return this.entries.has(String(id || ''));
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
    const entry = this.entries.get(requested.id);
    if (!entry) {
      const error = new Error(`Unknown MapPackage: ${requested.id}`);
      error.code = 'map_package_not_found';
      throw error;
    }
    if (!entry.package) {
      const loaded = await entry.loader();
      entry.package = prepareMapPackage(loaded, { source: entry.source });
      const actual = packageReference(entry.package);
      entry.version = actual.version;
      entry.title = String(entry.package.title || entry.package.name || actual.id);
      if (actual.id !== entry.id) {
        const error = new Error(`MapPackage loader ${entry.id} returned ${actual.id}`);
        error.code = 'map_package_id_mismatch';
        throw error;
      }
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
