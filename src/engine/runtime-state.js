import { deriveSceneState } from './state.js';
import { normalizeEntityState } from '../entities/model.js';
import { canonicalAttackAreas } from '../world/attack-anchors.js';
import {
  WORLD_STATE_KEY,
  normalizeWorldV2,
  projectWorldV2ToRuntimeState,
} from '../world/model.js';
import { isLegacySaveV2Payload, migrateLegacySaveV2 } from '../legacy/save-v2.js';

export const RUNTIME_SAVE_VERSION = 2;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

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

function cleanPreferences(raw) {
  const preferences = raw && typeof raw === 'object' && !Array.isArray(raw) ? clone(raw) : {};
  preferences.entitySystem = normalizeEntityState(preferences.entitySystem);
  for (const token of preferences.entitySystem.tokens) {
    if ('characterId' in token) delete token.characterId;
  }
  return preferences;
}

export function createInitialRuntimeState(mapPackage) {
  const metadata = mapMetadata(mapPackage);
  const defaults = mapPackage.defaultPreferences ?? mapPackage.preferences ?? {};
  const preferences = cleanPreferences(defaults);
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

export function validateRuntimeState(raw, { mapPackage, ruleset } = {}) {
  const source = object(raw, 'state');
  const metadata = mapMetadata(mapPackage);
  const mapId = String(source.mapId ?? metadata.id).trim();
  const mapVersion = String(source.mapVersion ?? metadata.version).trim();
  if (mapId !== metadata.id) throw new TypeError('state.mapId does not match MapPackage');
  if (mapVersion !== metadata.version) throw new TypeError('state.mapVersion does not match MapPackage');

  let next = {
    ...clone(source),
    saveVersion: RUNTIME_SAVE_VERSION,
    mapId,
    mapVersion,
    markers: cleanMarkers(source.markers ?? []),
    attackAreas: cleanAttackAreas(source.attackAreas ?? []),
    sceneEvents: cleanSceneEvents(source.sceneEvents ?? []),
    preferences: cleanPreferences(source.preferences),
  };
  delete next.characters;

  const rawWorld = next.preferences?.[WORLD_STATE_KEY];
  if (rawWorld) {
    const world = normalizeWorldV2(rawWorld, { mapPackage, ruleset });
    next = projectWorldV2ToRuntimeState(next, world, { mapPackage, ruleset });
    next.markers = cleanMarkers(next.markers ?? []);
    next.attackAreas = cleanAttackAreas(next.attackAreas ?? []);
    next.sceneEvents = cleanSceneEvents(next.sceneEvents ?? []);
    delete next.characters;
  }
  return next;
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
  const state = validateRuntimeState(parsed, { mapPackage, ruleset });
  return Object.freeze({
    state,
    world: clone(state.preferences?.[WORLD_STATE_KEY] || null),
    migrated: Object.prototype.hasOwnProperty.call(parsed, 'characters'),
    migratedCharacters: 0,
    fromVersion: String(parsed.mapVersion ?? state.mapVersion),
    toVersion: state.mapVersion,
    warnings: Object.freeze(Object.prototype.hasOwnProperty.call(parsed, 'characters')
      ? ['已移除旧 Character 运行时字段']
      : []),
  });
}

export function exportRuntimeState(state, { mapPackage, ruleset } = {}) {
  const next = validateRuntimeState(state, { mapPackage, ruleset });
  delete next.characters;
  for (const token of next.preferences?.entitySystem?.tokens || []) delete token.characterId;
  return next;
}
