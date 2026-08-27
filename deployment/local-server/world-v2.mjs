import { assertStatusState } from './status-operations.mjs';

export const WORLD_V2_SCHEMA_VERSION = 2;
export const WORLD_V2_STATE_KEY = 'worldV2';

function fail(message, code = 'invalid_world_v2') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function cleanId(value, label) {
  const result = String(value ?? '').trim();
  if (!result) fail(`${label} requires an id`);
  if (result.length > 160) fail(`${label} id is too long`, 'world_limit');
  return result;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be finite`);
  return number;
}

function unique(items, label) {
  const seen = new Set();
  array(items, label).forEach((entry, index) => {
    const value = cleanId(object(entry, `${label}[${index}]`).id, `${label}[${index}].id`);
    if (seen.has(value)) fail(`${label} contains duplicate id: ${value}`, 'duplicate_id');
    seen.add(value);
  });
  return seen;
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeValue(base, delta) {
  if (delta === undefined) return structuredClone(base);
  if (Array.isArray(delta)) return structuredClone(delta);
  if (!isObject(delta)) return structuredClone(delta);
  const result = isObject(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(delta)) result[key] = mergeValue(result[key], value);
  return result;
}

function syntheticActor(baseActor, actorDelta) {
  const actor = mergeValue(baseActor, actorDelta || {});
  actor.id = baseActor.id;
  return actor;
}

function entityState(state) {
  const value = state?.preferences?.entitySystem;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { actors: [], tokens: [], statusDefinitions: [] };
}

function runtimePlacement(character, token) {
  const location = character?.location && typeof character.location === 'object' ? character.location : {};
  if (location.type === 'building' && location.featureId != null) {
    return { placement: 'feature', x: null, y: null, featureId: String(location.featureId) };
  }
  const x = Number.isFinite(Number(location.x)) ? Number(location.x) : Number(token?.x || 0);
  const y = Number.isFinite(Number(location.y)) ? Number(location.y) : Number(token?.y || 0);
  return { placement: 'map', x, y, featureId: null };
}

function tokenFromRuntime(token, character, actorIds) {
  const tokenId = String(token?.id ?? token?.characterId ?? '').trim();
  const actorId = String(token?.actorId ?? '').trim();
  if (!tokenId || !actorId || !actorIds.has(actorId)) return null;
  return {
    id: tokenId,
    actorId,
    actorLink: token?.actorLink !== false,
    actorDelta: token?.actorDelta && typeof token.actorDelta === 'object' && !Array.isArray(token.actorDelta)
      ? structuredClone(token.actorDelta)
      : null,
    ...runtimePlacement(character, token),
    diameterMeters: Number(token?.diameterMeters ?? token?.size ?? 1),
    rotation: Number(token?.rotation || 0),
    elevationFt: Number(token?.elevationFt || 0),
    hidden: token?.hidden === true,
    locked: token?.locked === true,
    showName: token?.showName !== false,
    effects: Array.isArray(token?.effects) ? structuredClone(token.effects) : [],
  };
}

export function synchronizeWorldV2Mirror(state) {
  const raw = state?.preferences?.[WORLD_V2_STATE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const world = structuredClone(raw);
  const entity = entityState(state);
  const actors = Array.isArray(entity.actors) ? structuredClone(entity.actors) : [];
  const actorIds = new Set(actors.map(actor => String(actor?.id ?? '')).filter(Boolean));
  const characters = new Map((Array.isArray(state.characters) ? state.characters : [])
    .map(character => [String(character?.id ?? ''), character]));
  const tokens = (Array.isArray(entity.tokens) ? entity.tokens : []).flatMap(token => {
    const characterId = String(token?.characterId ?? token?.id ?? '');
    const next = tokenFromRuntime(token, characters.get(characterId), actorIds);
    return next ? [next] : [];
  });
  const scenes = Array.isArray(world.scenes) ? world.scenes : [];
  const activeSceneId = String(world.activeSceneId ?? '');
  const activeIndex = scenes.findIndex(scene => String(scene?.id ?? '') === activeSceneId);
  if (activeIndex >= 0) {
    scenes[activeIndex] = {
      ...scenes[activeIndex],
      tokens,
      markers: Array.isArray(state.markers) ? structuredClone(state.markers) : [],
      attackAreas: Array.isArray(state.attackAreas) ? structuredClone(state.attackAreas) : [],
      sceneEvents: Array.isArray(state.sceneEvents) ? structuredClone(state.sceneEvents) : [],
      settings: {
        ...(scenes[activeIndex]?.settings && typeof scenes[activeIndex].settings === 'object' ? scenes[activeIndex].settings : {}),
        gridVisible: state?.preferences?.gridVisible !== false,
      },
    };
  }
  world.schemaVersion = WORLD_V2_SCHEMA_VERSION;
  world.actors = actors;
  world.statusDefinitions = Array.isArray(entity.statusDefinitions) ? structuredClone(entity.statusDefinitions) : [];
  world.scenes = scenes;
  world.updatedAt = new Date().toISOString();
  state.preferences[WORLD_V2_STATE_KEY] = world;
  return world;
}

export function assertWorldV2(value) {
  const world = object(value, 'worldV2');
  if (Number(world.schemaVersion) !== WORLD_V2_SCHEMA_VERSION) fail('worldV2.schemaVersion must be 2');
  cleanId(world.id, 'worldV2.id');
  const ruleset = object(world.ruleset, 'worldV2.ruleset');
  cleanId(ruleset.id, 'worldV2.ruleset.id');
  if (typeof ruleset.version !== 'string' || !ruleset.version.trim()) fail('worldV2.ruleset.version is required');
  const actorIds = unique(world.actors, 'worldV2.actors');
  const actorById = new Map(world.actors.map(actor => [String(actor?.id ?? ''), actor]));
  const statusDefinitions = Array.isArray(world.statusDefinitions) ? world.statusDefinitions : [];
  const sceneIds = unique(world.scenes, 'worldV2.scenes');
  const activeSceneId = cleanId(world.activeSceneId, 'worldV2.activeSceneId');
  if (!sceneIds.has(activeSceneId)) fail(`worldV2.activeSceneId references missing Scene: ${activeSceneId}`, 'invalid_reference');

  for (const [sceneIndex, sceneRaw] of world.scenes.entries()) {
    const scene = object(sceneRaw, `worldV2.scenes[${sceneIndex}]`);
    const mapPackage = object(scene.mapPackage, `worldV2.scenes[${sceneIndex}].mapPackage`);
    cleanId(mapPackage.id, `worldV2.scenes[${sceneIndex}].mapPackage.id`);
    if (typeof mapPackage.version !== 'string' || !mapPackage.version.trim()) {
      fail(`worldV2.scenes[${sceneIndex}].mapPackage.version is required`);
    }
    unique(scene.tokens, `worldV2.scenes[${sceneIndex}].tokens`);
    for (const [tokenIndex, tokenRaw] of scene.tokens.entries()) {
      const token = object(tokenRaw, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}]`);
      const actorId = cleanId(token.actorId, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].actorId`);
      if (!actorIds.has(actorId)) fail(`World V2 Token references missing Actor: ${actorId}`, 'invalid_reference');
      if (typeof token.actorLink !== 'boolean') fail('worldV2 token.actorLink must be boolean');
      if (token.actorDelta !== null && token.actorDelta !== undefined
        && (!token.actorDelta || typeof token.actorDelta !== 'object' || Array.isArray(token.actorDelta))) {
        fail('worldV2 token.actorDelta must be an object or null');
      }

      // actorDelta is flexible for Ruleset data, but its resolved Actor effects
      // are still mechanical Status data. Rebuild the Synthetic Actor on the
      // server and run the same Status schema used for normal World Actors.
      // This makes atomic world.push authoritative rather than trusting the
      // browser to have produced a legal effect instance.
      if (token.actorLink === false && token.actorDelta) {
        const baseActor = actorById.get(actorId);
        const resolved = syntheticActor(baseActor, token.actorDelta);
        try {
          assertStatusState({
            schemaVersion: 3,
            statusDefinitions: structuredClone(statusDefinitions),
            actors: [resolved],
            tokens: [],
          });
        } catch (error) {
          error.message = `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].actorDelta: ${error.message}`;
          throw error;
        }
      }

      if (token.placement === 'feature') {
        cleanId(token.featureId, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].featureId`);
      } else if (token.placement === 'map') {
        finite(token.x, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].x`);
        finite(token.y, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].y`);
      } else {
        fail(`worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].placement is invalid`);
      }
      finite(token.diameterMeters, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].diameterMeters`);
      if (Number(token.diameterMeters) <= 0) fail('worldV2 token.diameterMeters must be positive');
    }
    array(scene.markers, `worldV2.scenes[${sceneIndex}].markers`);
    array(scene.attackAreas, `worldV2.scenes[${sceneIndex}].attackAreas`);
    array(scene.sceneEvents, `worldV2.scenes[${sceneIndex}].sceneEvents`);
  }
  return world;
}
