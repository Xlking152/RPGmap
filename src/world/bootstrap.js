import { WORLD_SCHEMA_VERSION, WORLD_STATE_KEY } from './constants.js';
import { upgradeBuiltInMapReference, upgradeBuiltInRulesetReference } from './package-upgrades.js';

function invalid(message, code = 'invalid_world') {
  throw Object.assign(new Error(message), { code });
}

function id(value, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) invalid(`${label} requires an id`);
  return result;
}

function unique(values, label) {
  if (!Array.isArray(values)) invalid(`${label} must be an array`);
  const ids = new Set();
  for (const value of values) {
    const valueId = id(value?.id, label);
    if (ids.has(valueId)) invalid(`${label} contains duplicate id: ${valueId}`, 'duplicate_id');
    ids.add(valueId);
  }
  return ids;
}

function assertWorldBoundary(world) {
  if (!world || typeof world !== 'object' || Array.isArray(world)) invalid('worldV2 must be an object');
  if (![2, 3, WORLD_SCHEMA_VERSION].includes(Number(world.schemaVersion))) invalid('World schema is incompatible', 'world_schema_incompatible');
  id(world.id, 'worldV2');
  const actors = unique(world.actors, 'worldV2.actors');
  const scenes = unique(world.scenes, 'worldV2.scenes');
  if (!scenes.has(id(world.activeSceneId, 'worldV2.activeSceneId'))) invalid('Active Scene is missing', 'invalid_reference');
  for (const scene of world.scenes) {
    id(scene?.mapPackage?.id, 'Scene MapPackage');
    id(scene?.mapPackage?.version, 'Scene MapPackage version');
    unique(scene.tokens, 'Scene Tokens');
    for (const token of scene.tokens) if (!actors.has(id(token?.actorId, 'Token actorId'))) invalid('Token Actor is missing', 'invalid_reference');
  }
  return world;
}

function worldRulesetReference(world) {
  return { id: id(world?.ruleset?.id, 'World ruleset'), version: id(world?.ruleset?.version, 'World ruleset version') };
}

function parseState(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); }
  catch {
    const error = new TypeError('save is not valid JSON');
    error.code = 'save_invalid_json';
    throw error;
  }
}

function defaultReference(value = {}) {
  const id = typeof value?.id === 'string' ? value.id.trim() : '';
  const version = typeof value?.version === 'string' ? value.version.trim() : '';
  if (!id || !version) {
    const error = new Error('Default World ruleset id and version are required');
    error.code = 'world_ruleset_missing';
    throw error;
  }
  return Object.freeze({ id, version });
}

function mapReference(value = null) {
  const id = typeof value?.id === 'string' ? value.id.trim() : '';
  const version = typeof value?.version === 'string' ? value.version.trim() : '';
  return id ? Object.freeze({ id, version: version || null }) : null;
}

function worldBootstrapMetadata(world) {
  const scenes = Array.isArray(world?.scenes) ? world.scenes : [];
  const active = scenes.find(scene => String(scene?.id) === String(world?.activeSceneId)) || scenes[0] || null;
  return {
    worldId: typeof world?.id === 'string' ? world.id : null,
    worldName: typeof world?.name === 'string' ? world.name : null,
    activeSceneId: active?.id ? String(active.id) : null,
    mapPackage: mapReference(upgradeBuiltInMapReference(active?.mapPackage, world?.schemaVersion)),
  };
}

export function readWorldBootstrap(raw, { defaultRuleset } = {}) {
  const state = parseState(raw);
  if (!state) {
    return Object.freeze({
      kind: 'empty', raw: null, ruleset: defaultReference(defaultRuleset),
      worldId: null, worldName: null, activeSceneId: null, mapPackage: null,
    });
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    const error = new TypeError('save root must be an object');
    error.code = 'invalid_world';
    throw error;
  }
  const world = state.preferences?.[WORLD_STATE_KEY];
  if (!world) {
    return Object.freeze({
      kind: 'legacy', raw: state, ruleset: defaultReference(defaultRuleset),
      worldId: null, worldName: null, activeSceneId: null, mapPackage: null,
    });
  }
  assertWorldBoundary(world);
  return Object.freeze({
    kind: 'world-v2',
    raw: state,
    ruleset: upgradeBuiltInRulesetReference(worldRulesetReference(world), world.schemaVersion),
    ...worldBootstrapMetadata(world),
  });
}

export function readServerWorldBootstrap(metadata, { defaultRuleset } = {}) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const kind = ['empty', 'legacy', 'world-v2'].includes(source.kind)
    ? source.kind
    : (source.initialized ? 'legacy' : 'empty');
  if (kind !== 'world-v2') {
    return Object.freeze({
      kind,
      raw: null,
      remote: true,
      ruleset: defaultReference(defaultRuleset),
      worldId: typeof source.worldId === 'string' ? source.worldId : null,
      worldName: typeof source.name === 'string' ? source.name : null,
      activeSceneId: null,
      mapPackage: null,
    });
  }
  if (![2, 3, WORLD_SCHEMA_VERSION].includes(Number(source.schemaVersion))) {
    const error = new Error('Server World schema is incompatible');
    error.code = 'world_schema_incompatible';
    throw error;
  }
  return Object.freeze({
    kind,
    raw: null,
    remote: true,
    ruleset: defaultReference(upgradeBuiltInRulesetReference(source.ruleset, source.schemaVersion)),
    worldId: typeof source.worldId === 'string' ? source.worldId : null,
    worldName: typeof source.name === 'string' ? source.name : null,
    activeSceneId: typeof source.activeSceneId === 'string' ? source.activeSceneId : null,
    mapPackage: mapReference(upgradeBuiltInMapReference(source.mapPackage, source.schemaVersion)),
  });
}
