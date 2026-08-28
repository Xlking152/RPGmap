import { canonicalAttackAreas } from './attack-anchors.js';
import { normalizeActorDocument } from '../actor/index.js';
import { createActorDelta, mergeActorDelta } from '../token/actor.js';

export const WORLD_SCHEMA_VERSION = 2;
export const WORLD_STATE_KEY = 'worldV2';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function id(value, fallback = '') {
  return text(value == null ? '' : String(value), fallback).slice(0, 160);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function rulesetStatusDefinitions(value, ruleset) {
  const source = array(value);
  const builtIns = array(ruleset?.statuses?.definitions).map(definition => ({ ...clone(definition), builtIn: true }));
  if (!builtIns.length) return clone(source);
  const builtInIds = new Set(builtIns.map(definition => String(definition.id)));
  const custom = source
    .filter(definition => definition && !builtInIds.has(String(definition.id)))
    .map(definition => ({ ...clone(definition), builtIn: false }));
  return [...builtIns, ...custom];
}

function mapMetadata(mapPackage = {}) {
  const manifest = object(mapPackage.manifest);
  const mapId = id(mapPackage.mapId ?? mapPackage.id ?? manifest.mapId ?? manifest.id, 'default-map');
  const version = text(mapPackage.mapVersion ?? mapPackage.version ?? manifest.mapVersion ?? manifest.version, '1');
  return { id: mapId, version };
}

function runtimeEntityState(state) {
  return object(state?.preferences?.entitySystem);
}

function sceneIdForMap(mapId) {
  const slug = String(mapId || 'default-map').replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 120);
  return `scene-${slug || 'default'}`;
}

function normalizeWorldToken(raw, actorIds, { rawActorsById = new Map(), actorsById = new Map(), ruleset = null } = {}) {
  const token = object(raw);
  const tokenId = id(token.id);
  const actorId = id(token.actorId);
  if (!tokenId || !actorId || !actorIds.has(actorId)) return null;
  const placement = token.placement === 'feature' || token.featureId != null ? 'feature' : 'map';
  let actorDelta = null;
  if (token.actorDelta && typeof token.actorDelta === 'object' && !Array.isArray(token.actorDelta)) {
    const rawBaseActor = rawActorsById.get(actorId) || actorsById.get(actorId);
    const baseActor = actorsById.get(actorId);
    if (rawBaseActor && baseActor) {
      const resolved = normalizeActorDocument(
        mergeActorDelta(rawBaseActor, token.actorDelta),
        ruleset ? { ruleset } : {},
      );
      actorDelta = createActorDelta(baseActor, resolved);
    } else actorDelta = clone(token.actorDelta);
  }
  return {
    id: tokenId,
    actorId,
    actorLink: token.actorLink !== false,
    actorDelta,
    placement,
    x: placement === 'map' ? finite(token.x, 0) : null,
    y: placement === 'map' ? finite(token.y, 0) : null,
    featureId: placement === 'feature' ? id(token.featureId) : null,
    diameterMeters: Math.max(0.1, finite(token.diameterMeters ?? token.size, 1)),
    rotation: finite(token.rotation, 0),
    elevationFt: finite(token.elevationFt, 0),
    hidden: token.hidden === true,
    locked: token.locked === true,
    showName: token.showName !== false,
    effects: clone(array(token.effects)),
  };
}

function normalizeScene(raw, {
  mapPackage = null,
  actorIds = new Set(),
  rawActorsById = new Map(),
  actorsById = new Map(),
  ruleset = null,
} = {}) {
  const source = object(raw);
  const fallbackMap = mapMetadata(mapPackage || {});
  const mapRef = object(source.mapPackage);
  const mapId = id(mapRef.id ?? mapRef.mapId, fallbackMap.id);
  const mapVersion = text(mapRef.version ?? mapRef.mapVersion, fallbackMap.version);
  const seen = new Set();
  const tokens = [];
  for (const candidate of array(source.tokens)) {
    const token = normalizeWorldToken(candidate, actorIds, { rawActorsById, actorsById, ruleset });
    if (!token || seen.has(token.id)) continue;
    seen.add(token.id);
    tokens.push(token);
  }
  return {
    id: id(source.id, sceneIdForMap(mapId)),
    name: text(source.name, text(mapPackage?.title ?? mapPackage?.name, mapId)),
    mapPackage: { id: mapId, version: mapVersion },
    tokens,
    markers: clone(array(source.markers)),
    attackAreas: canonicalAttackAreas(source.attackAreas),
    sceneEvents: clone(array(source.sceneEvents)),
    settings: { gridVisible: source.settings?.gridVisible !== false },
  };
}

export function normalizeWorldV2(raw, { mapPackage = null, ruleset = null } = {}) {
  const source = object(raw);
  const rawActors = array(source.actors).filter(Boolean);
  const actors = rawActors
    .map(actor => normalizeActorDocument(actor, ruleset ? { ruleset } : {}));
  const actorIds = new Set(actors.map(actor => id(actor?.id)).filter(Boolean));
  const rawActorsById = new Map(rawActors.map(actor => [id(actor?.id), actor]));
  const actorsById = new Map(actors.map(actor => [id(actor?.id), actor]));
  const scenes = array(source.scenes).map(scene => normalizeScene(scene, {
    mapPackage, actorIds, rawActorsById, actorsById, ruleset,
  }));
  const fallbackMap = mapMetadata(mapPackage || {});
  if (!scenes.length) {
    scenes.push(normalizeScene({
      id: sceneIdForMap(fallbackMap.id),
      mapPackage: fallbackMap,
    }, { mapPackage, actorIds, rawActorsById, actorsById, ruleset }));
  }
  const sceneIds = new Set(scenes.map(scene => scene.id));
  const activeSceneId = sceneIds.has(id(source.activeSceneId)) ? id(source.activeSceneId) : scenes[0].id;
  const rulesetRef = object(source.ruleset);
  const now = new Date().toISOString();
  return {
    schemaVersion: WORLD_SCHEMA_VERSION,
    id: id(source.id, 'world-default'),
    name: text(source.name, `${text(ruleset?.title, 'RPGmap')} World`),
    ruleset: {
      id: id(rulesetRef.id, id(ruleset?.id, 'infinite-horror')),
      version: text(rulesetRef.version, text(ruleset?.version, '1.0.0')),
    },
    activeSceneId,
    actors,
    statusDefinitions: rulesetStatusDefinitions(source.statusDefinitions, ruleset),
    scenes,
    createdAt: text(source.createdAt, now),
    updatedAt: text(source.updatedAt, now),
  };
}

export function activeWorldScene(world) {
  const normalized = object(world);
  return array(normalized.scenes).find(scene => String(scene?.id) === String(normalized.activeSceneId))
    || array(normalized.scenes)[0]
    || null;
}

/**
 * Construct a new World from the modern reducer shell. Legacy Character input
 * is converted before this boundary by src/legacy/save-v2.js.
 */
export function createWorldV2FromRuntimeState(state, { mapPackage, ruleset, worldId = 'world-default', worldName = '' } = {}) {
  const entity = runtimeEntityState(state);
  const actors = array(entity.actors).filter(Boolean)
    .map(actor => normalizeActorDocument(actor, ruleset ? { ruleset } : {}));
  const actorIds = new Set(actors.map(actor => id(actor?.id)).filter(Boolean));
  const tokens = array(entity.tokens)
    .map(token => normalizeWorldToken(token, actorIds, {
      rawActorsById: new Map(actors.map(actor => [id(actor?.id), actor])),
      actorsById: new Map(actors.map(actor => [id(actor?.id), actor])),
      ruleset,
    }))
    .filter(Boolean);
  const mapRef = mapMetadata(mapPackage || {});
  const sceneId = sceneIdForMap(mapRef.id);
  const now = new Date().toISOString();
  return normalizeWorldV2({
    schemaVersion: WORLD_SCHEMA_VERSION,
    id: worldId,
    name: worldName || `${text(ruleset?.title, 'RPGmap')} World`,
    ruleset: { id: ruleset?.id, version: ruleset?.version },
    activeSceneId: sceneId,
    actors,
    statusDefinitions: clone(array(entity.statusDefinitions)),
    scenes: [{
      id: sceneId,
      name: text(mapPackage?.title ?? mapPackage?.name, mapRef.id),
      mapPackage: mapRef,
      tokens,
      markers: clone(array(state?.markers)),
      attackAreas: canonicalAttackAreas(state?.attackAreas),
      sceneEvents: clone(array(state?.sceneEvents)),
      settings: { gridVisible: state?.preferences?.gridVisible !== false },
    }],
    createdAt: now,
    updatedAt: now,
  }, { mapPackage, ruleset });
}

function mergeRuntimeTokenFields(canonicalToken, runtimeToken) {
  if (!runtimeToken || String(runtimeToken.id) !== String(canonicalToken.id)) return canonicalToken;
  return {
    ...canonicalToken,
    actorLink: runtimeToken.actorLink !== false,
    actorDelta: runtimeToken.actorDelta && typeof runtimeToken.actorDelta === 'object' && !Array.isArray(runtimeToken.actorDelta)
      ? clone(runtimeToken.actorDelta)
      : canonicalToken.actorDelta,
    diameterMeters: Math.max(0.1, finite(runtimeToken.diameterMeters, canonicalToken.diameterMeters)),
    rotation: finite(runtimeToken.rotation, canonicalToken.rotation),
    elevationFt: finite(runtimeToken.elevationFt, canonicalToken.elevationFt),
    hidden: runtimeToken.hidden === true,
    locked: runtimeToken.locked === true,
    showName: runtimeToken.showName !== false,
    effects: clone(array(runtimeToken.effects)),
  };
}

export function synchronizeWorldV2FromRuntimeState(state, { mapPackage, ruleset, existingWorld = null } = {}) {
  const base = existingWorld || state?.preferences?.[WORLD_STATE_KEY];
  if (!base) return createWorldV2FromRuntimeState(state, { mapPackage, ruleset });
  const world = normalizeWorldV2(base, { mapPackage, ruleset });
  const entity = runtimeEntityState(state);
  const actors = (array(entity.actors).length ? entity.actors : world.actors)
    .filter(Boolean)
    .map(actor => normalizeActorDocument(actor, ruleset ? { ruleset } : {}));
  const actorIds = new Set(actors.map(actor => id(actor?.id)).filter(Boolean));
  const runtimeTokens = new Map(array(entity.tokens).map(token => [String(token?.id ?? ''), token]));
  const scene = activeWorldScene(world);
  const nextScenes = world.scenes.map(item => String(item.id) === String(scene?.id)
    ? {
        ...item,
        mapPackage: mapMetadata(mapPackage || item.mapPackage),
        // Placement/id/Actor binding are canonical Scene data. Flat Entity drafts may update
        // effects/property fields, but can never move or rebind a Scene Token.
        tokens: item.tokens
          .filter(token => actorIds.has(String(token.actorId)))
          .map(token => mergeRuntimeTokenFields(token, runtimeTokens.get(String(token.id)))),
        markers: clone(array(state?.markers)),
        attackAreas: canonicalAttackAreas(state?.attackAreas),
        sceneEvents: clone(array(state?.sceneEvents)),
        settings: { ...object(item.settings), gridVisible: state?.preferences?.gridVisible !== false },
      }
    : item);
  return normalizeWorldV2({
    ...world,
    actors,
    statusDefinitions: clone(Array.isArray(entity.statusDefinitions) ? entity.statusDefinitions : world.statusDefinitions),
    scenes: nextScenes,
    updatedAt: new Date().toISOString(),
  }, { mapPackage, ruleset });
}

function runtimeTokenFromWorld(token) {
  return {
    id: token.id,
    actorId: token.actorId,
    actorLink: token.actorLink !== false,
    actorDelta: token.actorDelta ? clone(token.actorDelta) : null,
    placement: token.placement,
    x: token.placement === 'map' ? finite(token.x, 0) : null,
    y: token.placement === 'map' ? finite(token.y, 0) : null,
    featureId: token.placement === 'feature' ? token.featureId : null,
    diameterMeters: token.diameterMeters,
    rotation: token.rotation,
    elevationFt: token.elevationFt,
    hidden: token.hidden,
    locked: token.locked,
    showName: token.showName,
    effects: clone(array(token.effects)),
  };
}

export function projectWorldV2ToRuntimeState(state, rawWorld, { mapPackage, ruleset } = {}) {
  const world = normalizeWorldV2(rawWorld, { mapPackage, ruleset });
  const scene = activeWorldScene(world);
  if (!scene) return clone(state);
  const currentMap = mapMetadata(mapPackage || {});
  if (scene.mapPackage.id !== currentMap.id) {
    const error = new Error(`Scene ${scene.id} requires MapPackage ${scene.mapPackage.id}; current runtime loaded ${currentMap.id}`);
    error.code = 'world_scene_map_reload_required';
    throw error;
  }
  const actorIds = new Set(world.actors.map(actor => String(actor?.id)));
  const tokens = scene.tokens.filter(token => actorIds.has(String(token.actorId)));
  const next = clone(state || {});
  next.markers = clone(scene.markers);
  next.attackAreas = canonicalAttackAreas(scene.attackAreas);
  next.sceneEvents = clone(scene.sceneEvents);
  delete next.characters;
  next.preferences ||= {};
  next.preferences.gridVisible = scene.settings?.gridVisible !== false;
  next.preferences.entitySystem = {
    schemaVersion: Math.max(3, Number(next.preferences.entitySystem?.schemaVersion) || 0),
    statusDefinitions: clone(world.statusDefinitions),
    actors: clone(world.actors),
    tokens: tokens.map(runtimeTokenFromWorld),
  };
  next.preferences[WORLD_STATE_KEY] = clone(world);
  return next;
}

export function attachWorldV2(state, world) {
  const next = clone(state || {});
  delete next.characters;
  next.preferences ||= {};
  next.preferences[WORLD_STATE_KEY] = clone(world);
  return next;
}

export function createEmptyWorldScene(world, { mapPackage, id: sceneId, name = '' } = {}) {
  const normalized = normalizeWorldV2(world, { mapPackage });
  const mapRef = mapMetadata(mapPackage || {});
  const candidate = id(sceneId, sceneIdForMap(`${mapRef.id}-${normalized.scenes.length + 1}`));
  if (normalized.scenes.some(scene => scene.id === candidate)) throw new Error(`Scene already exists: ${candidate}`);
  const scene = normalizeScene({
    id: candidate,
    name: name || `Scene ${normalized.scenes.length + 1}`,
    mapPackage: mapRef,
    tokens: [], markers: [], attackAreas: [], sceneEvents: [],
    settings: { gridVisible: true },
  }, { mapPackage, actorIds: new Set(normalized.actors.map(actor => String(actor.id))) });
  return normalizeWorldV2({ ...normalized, scenes: [...normalized.scenes, scene], updatedAt: new Date().toISOString() }, { mapPackage });
}
