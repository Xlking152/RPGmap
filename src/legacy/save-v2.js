import {
  migrateSave as migrateLegacySchema,
  validateAndNormalizeSave as validateLegacySave,
} from '../engine/state.js';
import { migrateLegacyCharacters } from '../entities/model.js';
import { canonicalAttackAreas } from '../world/attack-anchors.js';
import { normalizeWorldV2, projectWorldV2ToRuntimeState, WORLD_STATE_KEY } from '../world/model.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function mapMetadata(mapPackage = {}) {
  const manifest = mapPackage?.manifest && typeof mapPackage.manifest === 'object'
    ? mapPackage.manifest
    : {};
  return {
    id: String(mapPackage.mapId ?? mapPackage.id ?? manifest.mapId ?? manifest.id ?? 'default-map'),
    version: String(mapPackage.mapVersion ?? mapPackage.version ?? manifest.mapVersion ?? manifest.version ?? '1'),
  };
}

function sceneIdForMap(mapId) {
  const slug = String(mapId || 'default-map').replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 120);
  return `scene-${slug || 'default'}`;
}

function legacyEntityState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const next = clone(raw);
  next.tokens = (Array.isArray(next.tokens) ? next.tokens : []).map(token => {
    if (!token || typeof token !== 'object' || Array.isArray(token)) return token;
    const migrated = { ...token, id: String(token.id ?? token.characterId ?? '').trim() };
    delete migrated.characterId;
    return migrated;
  });
  return next;
}

function legacyAttackAreas(rawAreas) {
  const converted = (Array.isArray(rawAreas) ? rawAreas : []).map(raw => {
    const area = clone(raw);
    const anchor = area?.anchor;
    if (anchor?.type === 'character' && anchor.characterId != null) {
      area.anchor = { type: 'token', tokenId: String(anchor.characterId) };
    }
    return area;
  });
  return canonicalAttackAreas(converted);
}

function legacyTokenToWorldToken(token, characterById) {
  const tokenId = String(token?.id ?? '').trim();
  const actorId = String(token?.actorId ?? '').trim();
  if (!tokenId || !actorId) return null;
  const character = characterById.get(tokenId) || null;
  const location = character?.location && typeof character.location === 'object'
    ? character.location
    : null;
  const featurePlaced = (location?.type === 'building' || location?.type === 'feature') && location?.featureId != null;
  const placement = token?.placement === 'feature' || token?.featureId != null || featurePlaced
    ? 'feature'
    : 'map';
  return {
    id: tokenId,
    actorId,
    actorLink: token.actorLink !== false,
    actorDelta: token.actorDelta && typeof token.actorDelta === 'object' && !Array.isArray(token.actorDelta)
      ? clone(token.actorDelta)
      : null,
    placement,
    x: placement === 'map' ? Number(token?.x ?? location?.x ?? 0) : null,
    y: placement === 'map' ? Number(token?.y ?? location?.y ?? 0) : null,
    featureId: placement === 'feature' ? String(token?.featureId ?? location?.featureId ?? '') : null,
    diameterMeters: Number(token?.diameterMeters ?? token?.size ?? 1),
    rotation: Number(token?.rotation ?? 0),
    elevationFt: Number(token?.elevationFt ?? 0),
    hidden: token?.hidden === true || character?.visible === false,
    locked: token?.locked === true,
    showName: token?.showName !== false,
    effects: clone(Array.isArray(token?.effects) ? token.effects : []),
  };
}

export function isLegacySaveV2Payload(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return false; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return !value.preferences?.[WORLD_STATE_KEY];
}

/**
 * The only Character -> Actor/Token migration boundary.
 *
 * Legacy SaveV1/V2 is parsed with the historical validator, converted to a
 * World V2 graph, and immediately projected into the modern reducer shell.
 * Character documents and Character-era Token/anchor fields never escape.
 */
export function migrateLegacySaveV2(raw, {
  mapPackage,
  ruleset,
  worldId = 'world-default',
  worldName = '',
} = {}) {
  if (!mapPackage) throw new TypeError('Legacy SaveV2 migration requires mapPackage');
  if (!ruleset?.id) throw new TypeError('Legacy SaveV2 migration requires ruleset');

  const schemaMigration = migrateLegacySchema(raw, mapPackage);
  const legacy = validateLegacySave(schemaMigration.save, mapPackage);
  const entityMigration = migrateLegacyCharacters(
    legacyEntityState(legacy.preferences?.entitySystem),
    legacy.characters || [],
  );
  const entity = entityMigration.state;
  const characterById = new Map((legacy.characters || []).map(character => [String(character.id), character]));
  const tokens = (entity.tokens || [])
    .map(token => legacyTokenToWorldToken(token, characterById))
    .filter(Boolean);
  const attackAreas = legacyAttackAreas(legacy.attackAreas || []);
  const mapRef = mapMetadata(mapPackage);
  const sceneId = sceneIdForMap(mapRef.id);
  const now = new Date().toISOString();
  const world = normalizeWorldV2({
    schemaVersion: 2,
    id: worldId,
    name: worldName || `${text(ruleset.title, 'RPGmap')} World`,
    ruleset: { id: ruleset.id, version: ruleset.version },
    activeSceneId: sceneId,
    actors: clone(entity.actors || []),
    statusDefinitions: clone(entity.statusDefinitions || []),
    scenes: [{
      id: sceneId,
      name: text(mapPackage.title ?? mapPackage.name, mapRef.id),
      mapPackage: mapRef,
      tokens,
      markers: clone(legacy.markers || []),
      attackAreas,
      sceneEvents: clone(legacy.sceneEvents || []),
      settings: { gridVisible: legacy.preferences?.gridVisible !== false },
    }],
    createdAt: now,
    updatedAt: now,
  }, { mapPackage, ruleset });

  const seed = {
    saveVersion: legacy.saveVersion,
    mapId: legacy.mapId,
    mapVersion: legacy.mapVersion,
    markers: clone(legacy.markers || []),
    attackAreas: clone(attackAreas),
    sceneEvents: clone(legacy.sceneEvents || []),
    preferences: clone(legacy.preferences || {}),
  };
  seed.preferences.entitySystem = clone(entity);
  seed.preferences[WORLD_STATE_KEY] = clone(world);
  const state = projectWorldV2ToRuntimeState(seed, world, { mapPackage, ruleset });
  delete state.characters;

  return Object.freeze({
    state,
    world: clone(world),
    migrated: true,
    migratedCharacters: entityMigration.migrated,
    fromVersion: schemaMigration.fromVersion,
    toVersion: schemaMigration.toVersion,
    warnings: Object.freeze([
      ...(schemaMigration.warnings || []),
      `旧 Character 已一次性转换为 ${tokens.length} 个 Scene Token`,
    ]),
  });
}
