export const WORLD_CATALOG_SCHEMA_VERSION = 1;
export const WORLD_CATALOG_STORAGE_KEY = 'rpgmap:world-catalog:v1';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function newWorldId() {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `world-${value}`;
}

export function canonicalWorldStorageKey(worldId) {
  const id = text(worldId);
  if (!id) throw new Error('World storage requires worldId');
  return `rpgmap:world:${id}:v1`;
}

export function legacyMapWorldStorageKey(mapId) {
  const id = text(mapId);
  if (!id) throw new Error('Legacy World storage requires map id');
  return `rpg-map:${id}:v1`;
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') return clone(raw);
  try { return JSON.parse(raw); }
  catch { return null; }
}

export function inspectWorldSave(raw) {
  const state = parseJson(raw);
  const world = object(state?.preferences?.worldV2);
  if (!world.id) return null;
  const scenes = array(world.scenes);
  const activeScene = scenes.find(scene => String(scene?.id) === String(world.activeSceneId)) || scenes[0] || null;
  return Object.freeze({
    id: text(world.id),
    name: text(world.name, 'RPGmap World'),
    ruleset: Object.freeze({
      id: text(world.ruleset?.id),
      version: text(world.ruleset?.version),
    }),
    mapPackage: activeScene ? Object.freeze({
      id: text(activeScene.mapPackage?.id),
      version: text(activeScene.mapPackage?.version),
    }) : null,
    activeSceneId: text(world.activeSceneId),
    updatedAt: text(world.updatedAt),
  });
}

function normalizeDescriptor(raw = {}) {
  const source = object(raw);
  const id = text(source.id, newWorldId());
  return {
    id,
    name: text(source.name, 'RPGmap World').slice(0, 120),
    storageKey: text(source.storageKey, canonicalWorldStorageKey(id)),
    ruleset: {
      id: text(source.ruleset?.id),
      version: text(source.ruleset?.version),
    },
    mapPackage: {
      id: text(source.mapPackage?.id),
      version: text(source.mapPackage?.version),
    },
    createdAt: text(source.createdAt, new Date().toISOString()),
    updatedAt: text(source.updatedAt, source.createdAt || new Date().toISOString()),
  };
}

function normalizeCatalog(raw) {
  const source = object(parseJson(raw));
  const worlds = array(source.worlds).map(normalizeDescriptor);
  const ids = new Set(worlds.map(world => world.id));
  return {
    schemaVersion: WORLD_CATALOG_SCHEMA_VERSION,
    activeWorldId: ids.has(text(source.activeWorldId)) ? text(source.activeWorldId) : (worlds[0]?.id || null),
    worlds,
  };
}

export function createWorldCatalogManager(storageAdapter, { idFactory = newWorldId } = {}) {
  if (!storageAdapter?.get || !storageAdapter?.set || !storageAdapter?.remove) {
    throw new Error('World Manager requires get/set/remove storage adapter');
  }

  function readCatalog() {
    return normalizeCatalog(storageAdapter.get(WORLD_CATALOG_STORAGE_KEY));
  }

  function writeCatalog(catalog) {
    const normalized = normalizeCatalog(catalog);
    storageAdapter.set(WORLD_CATALOG_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function list() {
    return clone(readCatalog().worlds);
  }

  function get(worldId) {
    return list().find(world => String(world.id) === String(worldId)) || null;
  }

  function active() {
    const catalog = readCatalog();
    return clone(catalog.worlds.find(world => world.id === catalog.activeWorldId) || null);
  }

  function readRaw(worldId) {
    const descriptor = get(worldId);
    return descriptor ? storageAdapter.get(descriptor.storageKey) : null;
  }

  function select(worldId) {
    const catalog = readCatalog();
    const descriptor = catalog.worlds.find(world => String(world.id) === String(worldId));
    if (!descriptor) throw new Error(`Unknown World: ${worldId}`);
    catalog.activeWorldId = descriptor.id;
    writeCatalog(catalog);
    return clone(descriptor);
  }

  function create({ name, ruleset, mapPackage, id = idFactory() } = {}) {
    const worldId = text(id, idFactory());
    const ruleId = text(ruleset?.id);
    const mapId = text(mapPackage?.id);
    if (!ruleId) throw new Error('New World requires Ruleset');
    if (!mapId) throw new Error('New World requires MapPackage');
    const now = new Date().toISOString();
    const descriptor = normalizeDescriptor({
      id: worldId,
      name: text(name, '新 World'),
      storageKey: canonicalWorldStorageKey(worldId),
      ruleset,
      mapPackage,
      createdAt: now,
      updatedAt: now,
    });
    const catalog = readCatalog();
    if (catalog.worlds.some(world => world.id === descriptor.id)) throw new Error(`World already exists: ${descriptor.id}`);
    catalog.worlds.push(descriptor);
    catalog.activeWorldId = descriptor.id;
    writeCatalog(catalog);
    return clone(descriptor);
  }

  function updateFromSave(worldId, raw) {
    const header = inspectWorldSave(raw);
    const catalog = readCatalog();
    const index = catalog.worlds.findIndex(world => String(world.id) === String(worldId));
    if (index < 0) return null;
    if (header) {
      catalog.worlds[index] = normalizeDescriptor({
        ...catalog.worlds[index],
        name: header.name,
        ruleset: header.ruleset,
        mapPackage: header.mapPackage || catalog.worlds[index].mapPackage,
        updatedAt: header.updatedAt || new Date().toISOString(),
      });
      writeCatalog(catalog);
    }
    return clone(catalog.worlds[index]);
  }

  function activateStoredScene(worldId, sceneId) {
    const descriptor = get(worldId);
    if (!descriptor) throw new Error(`Unknown World: ${worldId}`);
    const raw = storageAdapter.get(descriptor.storageKey);
    const state = parseJson(raw);
    const world = object(state?.preferences?.worldV2);
    if (!world.id) {
      const error = new Error(`World ${worldId} has no persisted World V2 state`);
      error.code = 'world_save_missing';
      throw error;
    }
    const target = array(world.scenes).find(scene => String(scene?.id) === String(sceneId));
    if (!target) throw new Error(`Unknown Scene: ${sceneId}`);
    world.activeSceneId = String(target.id);
    world.updatedAt = new Date().toISOString();
    state.preferences.worldV2 = world;
    storageAdapter.set(descriptor.storageKey, JSON.stringify(state));

    const catalog = readCatalog();
    const index = catalog.worlds.findIndex(item => String(item.id) === String(worldId));
    if (index >= 0) {
      catalog.worlds[index] = normalizeDescriptor({
        ...catalog.worlds[index],
        name: text(world.name, catalog.worlds[index].name),
        ruleset: object(world.ruleset),
        mapPackage: object(target.mapPackage),
        updatedAt: world.updatedAt,
      });
      catalog.activeWorldId = catalog.worlds[index].id;
      writeCatalog(catalog);
    }
    return clone(target);
  }

  function remove(worldId) {
    const catalog = readCatalog();
    const index = catalog.worlds.findIndex(world => String(world.id) === String(worldId));
    if (index < 0) return false;
    const [removed] = catalog.worlds.splice(index, 1);
    storageAdapter.remove(removed.storageKey);
    if (catalog.activeWorldId === removed.id) catalog.activeWorldId = catalog.worlds[0]?.id || null;
    writeCatalog(catalog);
    return true;
  }

  function adoptLegacyMapWorld({ mapPackage, fallbackRuleset } = {}) {
    const catalog = readCatalog();
    if (catalog.worlds.length) return null;
    const mapId = text(mapPackage?.id);
    if (!mapId) return null;
    const legacyKey = legacyMapWorldStorageKey(mapId);
    const raw = storageAdapter.get(legacyKey);
    if (!raw) return null;
    const header = inspectWorldSave(raw);
    const worldId = text(header?.id, idFactory());
    const now = new Date().toISOString();
    const descriptor = normalizeDescriptor({
      id: worldId,
      name: header?.name || '迁移的 RPGmap World',
      ruleset: header?.ruleset?.id ? header.ruleset : fallbackRuleset,
      mapPackage: header?.mapPackage?.id ? header.mapPackage : { id: mapId, version: String(mapPackage.version || '1') },
      createdAt: now,
      updatedAt: header?.updatedAt || now,
    });
    storageAdapter.set(descriptor.storageKey, typeof raw === 'string' ? raw : JSON.stringify(raw));
    writeCatalog({ schemaVersion: WORLD_CATALOG_SCHEMA_VERSION, activeWorldId: descriptor.id, worlds: [descriptor] });
    // Keep the old map-key save as an untouched migration backup. It is no
    // longer the active persistence location after this point.
    return clone(descriptor);
  }

  return Object.freeze({
    storageKey: WORLD_CATALOG_STORAGE_KEY,
    list,
    get,
    active,
    readRaw,
    select,
    create,
    updateFromSave,
    activateStoredScene,
    remove,
    adoptLegacyMapWorld,
  });
}
