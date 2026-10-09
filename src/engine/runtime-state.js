import { deriveSceneState } from './state.js';
import { normalizeEntityState } from '../entities/model.js';
import { canonicalAttackAreas } from '../world/attack-anchors.js';
import {
  WORLD_STATE_KEY,
  WORLD_SCHEMA_VERSION,
  projectWorldV2ToRuntimeState,
} from '../world/model.js';
import { isLegacySaveV2Payload, migrateLegacySaveV2 } from '../legacy/save-v2.js';
import { assertPersistedWorldV2, assertWorldRuleset } from '../world/validation.js';
import { migrateDetachedWorldSchema4State } from '../world/migration.js';
import { finishWorkSync, finishWorkAsync } from '../vision/work.js';
import {
  FEATURE_STATE_KEY,
  LEGACY_FEATURE_INTERACTION_STATE_KEY,
  isPlainObject,
  migrateDetachedLegacySceneFeatureStates,
} from '../world/feature-states.js';

export const RUNTIME_SAVE_VERSION = 2;

const clone = structuredClone;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function mapMetadata(mapPackage = {}) {
  const manifest = mapPackage?.manifest && typeof mapPackage.manifest === 'object'
    ? mapPackage.manifest
    : {};
  const id = String(mapPackage.mapId ?? mapPackage.id ?? manifest.mapId ?? manifest.id ?? '').trim();
  const version = String(mapPackage.mapVersion ?? mapPackage.version ?? manifest.mapVersion ?? manifest.version ?? '').trim();
  if (!id || !version) throw new TypeError('MapPackage requires id and version');
  return { id, version };
}

function cleanMarkers(markers) {
  const seen = new Set();
  return array(markers ?? [], 'state.markers').map((raw, index) => {
    const source = object(raw, `state.markers[${index}]`);
    const id = String(source.id ?? '').trim();
    if (!id || seen.has(id)) throw new TypeError(`Invalid or duplicate marker id: ${id || '(missing)'}`);
    seen.add(id);
    const x = Number(source.x);
    const y = Number(source.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError(`Marker ${id} requires finite x/y`);
    return {
      ...clone(source),
      id,
      name: String(source.name || `标记 ${index + 1}`).slice(0, 80),
      x,
      y,
      color: /^#[0-9a-f]{6}$/i.test(String(source.color || '')) ? String(source.color) : '#3498db',
      visible: source.visible !== false,
    };
  });
}

function cleanAttackAreas(areas) {
  const normalized = canonicalAttackAreas(array(areas ?? [], 'state.attackAreas'));
  const seen = new Set();
  for (const [index, area] of normalized.entries()) {
    if (!area || typeof area !== 'object' || Array.isArray(area)) throw new TypeError(`state.attackAreas[${index}] must be an object`);
    const id = String(area.id ?? '').trim();
    if (!id || seen.has(id)) throw new TypeError(`Invalid or duplicate attack area id: ${id || '(missing)'}`);
    seen.add(id);
    if (area.anchor?.type === 'character' || area.anchor?.characterId !== undefined) {
      throw new TypeError(`Attack area ${id} contains retired Character anchor data`);
    }
  }
  return normalized;
}

function cleanSceneEvents(events) {
  const next = clone(array(events ?? [], 'state.sceneEvents'));
  // Reuse the battle-tested scene replay validator without importing the old
  // Character document schema into the modern state boundary.
  deriveSceneState(next);
  return next;
}

function cleanPreferences(raw, ruleset, { normalizeCanonicalWorld = false } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const { entitySystem, [WORLD_STATE_KEY]: world, ...metadata } = source;
  if (typeof entitySystem === 'function' || typeof entitySystem === 'symbol') clone(entitySystem);
  const copied = clone(metadata);
  const preferences = Object.fromEntries(Object.keys(source).map(key => [key, copied[key]]));
  // The canonical World is normalized below before it can leave the validator.
  // Avoid copying its Actors, Scenes and Fog immediately before that work.
  if (Object.hasOwn(source, WORLD_STATE_KEY)) preferences[WORLD_STATE_KEY] = normalizeCanonicalWorld ? world : clone(world);
  preferences.entitySystem = normalizeEntityState(entitySystem, ruleset ? { ruleset } : {});
  for (const token of preferences.entitySystem.tokens) {
    if ('characterId' in token) delete token.characterId;
  }
  return preferences;
}

export function createInitialRuntimeState(mapPackage, { ruleset } = {}) {
  const metadata = mapMetadata(mapPackage);
  const defaults = mapPackage.defaultPreferences ?? mapPackage.preferences ?? {};
  const preferences = cleanPreferences(defaults, ruleset);
  return {
    saveVersion: RUNTIME_SAVE_VERSION,
    mapId: metadata.id,
    mapVersion: metadata.version,
    markers: [],
    attackAreas: [],
    sceneEvents: [],
    preferences,
  };
}

// Internal save preparation preserves every raw-input read and rejection before
// transferring an already owned canonical snapshot to another execution realm.
export function prepareRuntimeStateValidationInput(raw, { mapPackage } = {}) {
  let source = object(raw, 'state');
  const metadata = mapMetadata(mapPackage);
  const hasCanonicalWorld = Boolean(source.preferences?.[WORLD_STATE_KEY]);
  let hasLegacy = false;
  if (hasCanonicalWorld) {
    assertPersistedWorldV2(source.preferences[WORLD_STATE_KEY], {
      acceptedSchemaVersions: [2, 3, WORLD_SCHEMA_VERSION],
    });
    if (!isPlainObject(source)) throw new TypeError('Feature State migration requires a state object');
    hasLegacy = isPlainObject(source.preferences)
      && (Object.hasOwn(source.preferences, FEATURE_STATE_KEY)
        || Object.hasOwn(source.preferences, LEGACY_FEATURE_INTERACTION_STATE_KEY));
    source = clone(source);
  }
  return { source, metadata, hasCanonicalWorld, hasLegacy };
}

function* validatePreparedRuntimeStateSteps(prepared, { mapPackage, ruleset } = {}) {
  let { source } = prepared;
  const { metadata, hasCanonicalWorld, hasLegacy } = prepared;
  if (hasCanonicalWorld) {
    // Each migration still validates and applies its complete compatibility
    // rules. They can share this one exclusively owned snapshot.
    source = migrateDetachedWorldSchema4State(migrateDetachedLegacySceneFeatureStates(source, { hasLegacy }).state, {
      statusDefinitions: ruleset?.statuses?.definitions,
    }).state;
    // The complete authority input is detached before asynchronous execution
    // can yield. Compatibility migration still runs for schema 4 as well.
    yield 'migration';
  }
  const mapId = hasCanonicalWorld ? metadata.id : String(source.mapId ?? metadata.id).trim();
  const mapVersion = hasCanonicalWorld ? metadata.version : String(source.mapVersion ?? metadata.version).trim();
  if (mapId !== metadata.id) throw new TypeError('state.mapId does not match MapPackage');
  if (mapVersion !== metadata.version) throw new TypeError('state.mapVersion does not match MapPackage');

  const { markers: _markers, attackAreas: _areas, sceneEvents: _events, preferences: _preferences,
    ...metadataFields } = source;
  // The original full-state copy rejected unsupported values even when an
  // invalid preference container would subsequently be replaced by defaults.
  if (_preferences && (typeof _preferences !== 'object' || Array.isArray(_preferences))) clone(_preferences);
  const copiedMetadata = clone(metadataFields);
  let next = {
    ...Object.fromEntries(Object.keys(source).map(key => [key, copiedMetadata[key]])),
    saveVersion: RUNTIME_SAVE_VERSION,
    mapId,
    mapVersion,
    markers: cleanMarkers(source.markers ?? []),
    attackAreas: cleanAttackAreas(source.attackAreas ?? []),
    sceneEvents: cleanSceneEvents(source.sceneEvents ?? []),
    preferences: cleanPreferences(source.preferences, ruleset, { normalizeCanonicalWorld: hasCanonicalWorld }),
  };
  delete next.characters;
  // This belongs to the local persistence envelope, never runtime/public state.
  delete next._localExploration;
  // Without a canonical World this is the first yield: all caller-owned input
  // has already been read and copied into the complete runtime snapshot.
  yield 'runtime-content';

  const rawWorld = next.preferences?.[WORLD_STATE_KEY];
  if (rawWorld) {
    assertWorldRuleset(rawWorld, ruleset);
    // Projection already performs the complete canonical World normalization.
    next = projectWorldV2ToRuntimeState(next, rawWorld, { mapPackage, ruleset });
    // Finish all projected content checks in this owned phase. There is no
    // later validation work that needs an additional paint opportunity.
    next.markers = cleanMarkers(next.markers ?? []);
    next.attackAreas = cleanAttackAreas(next.attackAreas ?? []);
    next.sceneEvents = cleanSceneEvents(next.sceneEvents ?? []);
    delete next.characters;
  }
  return next;
}

function* validateRuntimeStateSteps(raw, { mapPackage, ruleset } = {}) {
  const options = { mapPackage, ruleset };
  return yield* validatePreparedRuntimeStateSteps(prepareRuntimeStateValidationInput(raw, options), options);
}

export function validateRuntimeState(raw, options = {}) {
  return finishWorkSync(validateRuntimeStateSteps(raw, options));
}

/** Yield after a paint opportunity; hidden pages also make timely progress. */
export function yieldRuntimeValidationFrame({ signal, view = globalThis } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let frame = null, fallback = null, afterFrame = null, settled = false;
    const clear = () => {
      if (frame !== null) view.cancelAnimationFrame?.(frame);
      if (fallback !== null) clearTimeout(fallback);
      if (afterFrame !== null) clearTimeout(afterFrame);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = () => {
      if (settled) return;
      settled = true; clear(); resolve();
    };
    const aborted = () => {
      if (settled) return;
      settled = true; clear();
      reject(signal.reason ?? new DOMException('Runtime validation cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
    // Resolve in a task following RAF, so the next validation phase does not
    // execute as a microtask before the same frame is painted.
    if (typeof view.requestAnimationFrame === 'function') {
      try { frame = view.requestAnimationFrame(() => { afterFrame = setTimeout(finish, 0); }); }
      catch { frame = null; }
    }
    fallback = setTimeout(finish, frame === null ? 0 : 32);
  });
}

export function prepareRuntimeState(raw, { mapPackage, ruleset } = {}) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); }
    catch { throw new TypeError('save is not valid JSON'); }
  }
  if (isLegacySaveV2Payload(parsed)) {
    return migrateLegacySaveV2(parsed, { mapPackage, ruleset });
  }
  const migratedFeatureState = Boolean(parsed?.preferences
    && (Object.prototype.hasOwnProperty.call(parsed.preferences, FEATURE_STATE_KEY)
      || Object.prototype.hasOwnProperty.call(parsed.preferences, LEGACY_FEATURE_INTERACTION_STATE_KEY)));
  const migratedCharacters = Object.prototype.hasOwnProperty.call(parsed, 'characters');
  const migratedWorldSchema = [2, 3].includes(Number(parsed?.preferences?.[WORLD_STATE_KEY]?.schemaVersion));
  const state = validateRuntimeState(parsed, { mapPackage, ruleset });
  return Object.freeze({
    state,
    world: clone(state.preferences?.[WORLD_STATE_KEY] || null),
    migrated: migratedCharacters || migratedFeatureState || migratedWorldSchema,
    migratedWorldSchema,
    migratedCharacters: 0,
    fromVersion: String(parsed.mapVersion ?? state.mapVersion),
    toVersion: state.mapVersion,
    warnings: Object.freeze(Object.prototype.hasOwnProperty.call(parsed, 'characters')
      ? ['已移除旧角色运行时字段']
      : []),
  });
}

function stripExportedRuntimeState(next) {
  // Validation owns this fully detached result; stripping presentation fields
  // need not copy its Actors, Scenes, Fog and history a second time.
  delete next.preferences[FEATURE_STATE_KEY];
  delete next.preferences[LEGACY_FEATURE_INTERACTION_STATE_KEY];
  delete next.characters;
  for (const token of next.preferences?.entitySystem?.tokens || []) delete token.characterId;
  return next;
}

export function exportRuntimeState(state, options = {}) {
  return stripExportedRuntimeState(validateRuntimeState(state, options));
}

/** Internal full-validation save path; synchronous public exports stay intact. */
export async function exportRuntimeStateAsync(state, options = {}, {
  signal,
  budgetMs = 0,
  yieldTask = () => yieldRuntimeValidationFrame({ signal }),
} = {}) {
  return stripExportedRuntimeState(await finishWorkAsync(validateRuntimeStateSteps(state, options), {
    signal, budgetMs, yieldTask,
  }));
}

// Internal continuations consume the prefix's owned snapshot. They perform all
// remaining validation; public callers keep the original raw-input boundary.
export function exportPreparedRuntimeState(prepared, options = {}) {
  return stripExportedRuntimeState(finishWorkSync(validatePreparedRuntimeStateSteps(prepared, options)));
}

export async function exportPreparedRuntimeStateAsync(prepared, options = {}, scheduler = {}) {
  return stripExportedRuntimeState(await finishWorkAsync(validatePreparedRuntimeStateSteps(prepared, options), {
    budgetMs: 0, ...scheduler,
  }));
}

// Only for a state just committed from validated canonical Document changes.
// Public exports, imports and migrations still run exportRuntimeState above.
export function stringifyTrustedRuntimeState(state, { mapPackage } = {}) {
  const source = object(state, 'state');
  const preferences = object(source.preferences, 'state.preferences');
  const metadata = mapMetadata(mapPackage);
  if (source.mapId !== metadata.id || source.mapVersion !== metadata.version || !preferences[WORLD_STATE_KEY]) {
    throw new TypeError('Trusted World state does not match the active MapPackage');
  }
  const savedPreferences = { ...preferences };
  delete savedPreferences[FEATURE_STATE_KEY];
  delete savedPreferences[LEGACY_FEATURE_INTERACTION_STATE_KEY];
  const tokens = savedPreferences.entitySystem?.tokens;
  if (Array.isArray(tokens) && tokens.some(token => Object.hasOwn(token, 'characterId'))) {
    savedPreferences.entitySystem = { ...savedPreferences.entitySystem, tokens: tokens.map(token => {
      const next = { ...token };
      delete next.characterId;
      return next;
    }) };
  }
  const saved = { ...source, preferences: savedPreferences };
  delete saved.characters;
  delete saved._localExploration;
  return JSON.stringify(saved);
}
