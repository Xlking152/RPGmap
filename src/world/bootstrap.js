import { WORLD_SCHEMA_VERSION, WORLD_STATE_KEY } from './constants.js';
import { assertPersistedWorldV2, worldRulesetReference } from './validation.js';

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
    mapPackage: mapReference(active?.mapPackage),
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
  assertPersistedWorldV2(world, { acceptedSchemaVersions: [2, WORLD_SCHEMA_VERSION] });
  return Object.freeze({
    kind: 'world-v2',
    raw: state,
    ruleset: worldRulesetReference(world),
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
  if (![2, WORLD_SCHEMA_VERSION].includes(Number(source.schemaVersion))) {
    const error = new Error('Server World schema is incompatible');
    error.code = 'world_schema_incompatible';
    throw error;
  }
  return Object.freeze({
    kind,
    raw: null,
    remote: true,
    ruleset: defaultReference(source.ruleset),
    worldId: typeof source.worldId === 'string' ? source.worldId : null,
    worldName: typeof source.name === 'string' ? source.name : null,
    activeSceneId: typeof source.activeSceneId === 'string' ? source.activeSceneId : null,
    mapPackage: mapReference(source.mapPackage),
  });
}
