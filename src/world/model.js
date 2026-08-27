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

function mapMetadata(mapPackage = {}) {
  const manifest = object(mapPackage.manifest);
  const mapId = id(mapPackage.mapId ?? mapPackage.id ?? manifest.mapId ?? manifest.id, 'default-map');
  const version = text(mapPackage.mapVersion ?? mapPackage.version ?? manifest.mapVersion ?? manifest.version, '1');
  return { id: mapId, version };
}

function activeForm(actor) {
  const forms = array(actor?.forms);
  return forms.find(form => String(form?.id) === String(actor?.currentFormId)) || forms[0] || null;
}

function sceneIdForMap(mapId) {
  const slug = String(mapId || 'default-map').replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 120);
  return `scene-${slug || 'default'}`;
}

function runtimeEntityState(state) {
  return object(state?.preferences?.entitySystem);
}

function placementFromCharacter(character, token = {}) {
  const location = object(character?.location);
  if (location.type === 'building' && location.featureId != null) {
    return {
      placement: 'feature',
      featureId: id(location.featureId),
      x: null,
      y: null,
    };
  }
  const tokenX = Number(token.x);
  const tokenY = Number(token.y);
  return {
    placement: 'map',
    featureId: null,
    x: finite(location.x, Number.isFinite(tokenX) ? tokenX : 0),
    y: finite(location.y, Number.isFinite(tokenY) ? tokenY : 0),
  };
}

function normalizeWorldToken(raw, actorIds) {
  const token = object(raw);
  const tokenId = id(token.id ?? token.characterId);
  const actorId = id(token.actorId);
  if (!tokenId || !actorId || !actorIds.has(actorId)) return null;
  const placement = token.placement === 'feature' || token.featureId != null ? 'feature' : 'map';
  return {
    id: tokenId,
    actorId,
    actorLink: token.actorLink !== false,
    actorDelta: token.actorDelta && typeof token.actorDelta === 'object' && !Array.isArray(token.actorDelta)
      ? clone(token.actorDelta)
      : null,
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

function worldTokenFromRuntime(token, character, actorIds) {
  const tokenId = id(token?.id ?? token?.characterId ?? character?.id);
  const actorId = id(token?.actorId);
  if (!tokenId || !actorId || !actorIds.has(actorId)) return null;
  return {
    id: tokenId,
    actorId,
    actorLink: token?.actorLink !== false,
    actorDelta: token?.actorDelta && typeof token.actorDelta === 'object' && !Array.isArray(token.actorDelta)
      ? clone(token.actorDelta)
      : null,
    ...placementFromCharacter(character, token),
    diameterMeters: Math.max(0.1, finite(token?.diameterMeters ?? token?.size, 1)),
    rotation: finite(token?.rotation, 0),
    elevationFt: finite(token?.elevationFt, 0),
    hidden: token?.hidden === true,
    locked: token?.locked === true,
    showName: token?.showName !== false,
    effects: clone(array(token?.effects)),
  };
}

function normalizeScene(raw, { mapPackage = null, actorIds = new Set() } = {}) {
  const source = object(raw);
  const fallbackMap = mapMetadata(mapPackage || {});
  const mapRef = object(source.mapPackage);
  const mapId = id(mapRef.id ?? mapRef.mapId, fallbackMap.id);
  const mapVersion = text(mapRef.version ?? mapRef.mapVersion, fallbackMap.version);
  const seen = new Set();
  const tokens = [];
  for (const candidate of array(source.tokens)) {
    const token = normalizeWorldToken(candidate, actorIds);
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
    attackAreas: clone(array(source.attackAreas)),
    sceneEvents: clone(array(source.sceneEvents)),
    settings: {
      gridVisible: source.settings?.gridVisible !== false,
    },
  };
}

export function normalizeWorldV2(raw, { mapPackage = null, ruleset = null } = {}) {
  const source = object(raw);
  const actors = clone(array(source.actors));
  const actorIds = new Set(actors.map(actor => id(actor?.id)).filter(Boolean));
  const scenes = array(source.scenes).map(scene => normalizeScene(scene, { mapPackage, actorIds }));
  const fallbackMap = mapMetadata(mapPackage || {});
  if (!scenes.length) {
    scenes.push(normalizeScene({
      id: sceneIdForMap(fallbackMap.id),
      mapPackage: fallbackMap,
    }, { mapPackage, actorIds }));
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
    statusDefinitions: clone(array(source.statusDefinitions)),
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

export function createWorldV2FromRuntimeState(state, { mapPackage, ruleset, worldId = 'world-default', worldName = '' } = {}) {
  const entity = runtimeEntityState(state);
  const actors = clone(array(entity.actors));
  const actorIds = new Set(actors.map(actor => id(actor?.id)).filter(Boolean));
  const characterById = new Map(array(state?.characters).map(character => [String(character?.id), character]));
  const tokens = array(entity.tokens).flatMap(token => {
    const characterId = String(token?.characterId ?? token?.id ?? '');
    const normalized = worldTokenFromRuntime(token, characterById.get(characterId), actorIds);
    return normalized ? [normalized] : [];
  });
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
      attackAreas: clone(array(state?.attackAreas)),
      sceneEvents: clone(array(state?.sceneEvents)),
      settings: { gridVisible: state?.preferences?.gridVisible !== false },
    }],
    createdAt: now,
    updatedAt: now,
  }, { mapPackage, ruleset });
}

export function synchronizeWorldV2FromRuntimeState(state, { mapPackage, ruleset, existingWorld = null } = {}) {
  const base = existingWorld || state?.preferences?.[WORLD_STATE_KEY];
  if (!base) return createWorldV2FromRuntimeState(state, { mapPackage, ruleset });
  const world = normalizeWorldV2(base, { mapPackage, ruleset });
  const entity = runtimeEntityState(state);
  const actors = clone(array(entity.actors));
  const actorIds = new Set(actors.map(actor => id(actor?.id)).filter(Boolean));
  const characterById = new Map(array(state?.characters).map(character => [String(character?.id), character]));
  const runtimeTokens = array(entity.tokens).flatMap(token => {
    const characterId = String(token?.characterId ?? token?.id ?? '');
    const normalized = worldTokenFromRuntime(token, characterById.get(characterId), actorIds);
    return normalized ? [normalized] : [];
  });
  const scene = activeWorldScene(world);
  const nextScenes = world.scenes.map(item => String(item.id) === String(scene?.id)
    ? {
        ...item,
        mapPackage: mapMetadata(mapPackage || item.mapPackage),
        tokens: runtimeTokens,
        markers: clone(array(state?.markers)),
        attackAreas: clone(array(state?.attackAreas)),
        sceneEvents: clone(array(state?.sceneEvents)),
        settings: { ...object(item.settings), gridVisible: state?.preferences?.gridVisible !== false },
      }
    : item);
  return normalizeWorldV2({
    ...world,
    actors,
    statusDefinitions: clone(array(entity.statusDefinitions)),
    scenes: nextScenes,
    updatedAt: new Date().toISOString(),
  }, { mapPackage, ruleset });
}

function runtimeCharacterFromToken(token, actor) {
  const form = activeForm(actor);
  const location = token.placement === 'feature' && token.featureId
    ? { type: 'building', featureId: token.featureId }
    : { type: 'map', x: finite(token.x, 0), y: finite(token.y, 0) };
  return {
    id: token.id,
    name: text(actor?.name, '未命名角色'),
    color: text(form?.tokenAppearance?.color, '#3d9b63'),
    avatarDataUrl: form?.avatarDataUrl || null,
    visible: token.hidden !== true,
    location,
  };
}

function runtimeTokenFromWorld(token) {
  return {
    id: token.id,
    characterId: token.id,
    actorId: token.actorId,
    actorLink: token.actorLink !== false,
    actorDelta: token.actorDelta ? clone(token.actorDelta) : null,
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
  const actorById = new Map(world.actors.map(actor => [String(actor?.id), actor]));
  const tokens = scene.tokens.filter(token => actorById.has(String(token.actorId)));
  const next = clone(state || {});
  next.markers = clone(scene.markers);
  next.attackAreas = clone(scene.attackAreas);
  next.sceneEvents = clone(scene.sceneEvents);
  next.characters = tokens.map(token => runtimeCharacterFromToken(token, actorById.get(String(token.actorId))));
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
