import { WORLD_STATE_KEY } from './model.js';
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

export function readWorldBootstrap(raw, { defaultRuleset } = {}) {
  const state = parseState(raw);
  if (!state) {
    return Object.freeze({ kind: 'empty', raw: null, ruleset: defaultReference(defaultRuleset) });
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    const error = new TypeError('save root must be an object');
    error.code = 'invalid_world';
    throw error;
  }
  const world = state.preferences?.[WORLD_STATE_KEY];
  if (!world) {
    return Object.freeze({ kind: 'legacy', raw: state, ruleset: defaultReference(defaultRuleset) });
  }
  assertPersistedWorldV2(world);
  return Object.freeze({
    kind: 'world-v2',
    raw: state,
    ruleset: worldRulesetReference(world),
  });
}

export function readServerWorldBootstrap(metadata, { defaultRuleset } = {}) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const kind = ['empty', 'legacy', 'world-v2'].includes(source.kind)
    ? source.kind
    : (source.initialized ? 'legacy' : 'empty');
  if (kind !== 'world-v2') {
    return Object.freeze({ kind, raw: null, remote: true, ruleset: defaultReference(defaultRuleset) });
  }
  if (Number(source.schemaVersion) !== 2) {
    const error = new Error('Server World schema is incompatible');
    error.code = 'world_schema_incompatible';
    throw error;
  }
  return Object.freeze({
    kind,
    raw: null,
    remote: true,
    ruleset: defaultReference(source.ruleset),
  });
}
