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

export function synchronizeWorldV2Mirror(state) {
  const raw = state?.preferences?.[WORLD_V2_STATE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const world = structuredClone(raw);
  const scenes = Array.isArray(world.scenes) ? world.scenes : [];
  const activeSceneId = String(world.activeSceneId ?? '');
  const activeIndex = scenes.findIndex(scene => String(scene?.id ?? '') === activeSceneId);
  if (activeIndex >= 0) {
    const scene = scenes[activeIndex];
    const entity = state.preferences.entitySystem && typeof state.preferences.entitySystem === 'object'
      && !Array.isArray(state.preferences.entitySystem)
      ? state.preferences.entitySystem
      : {};
    state.preferences.entitySystem = {
      ...structuredClone(entity),
      schemaVersion: Math.max(3, Number(entity.schemaVersion) || 0),
      actors: structuredClone(Array.isArray(world.actors) ? world.actors : []),
      statusDefinitions: structuredClone(Array.isArray(world.statusDefinitions) ? world.statusDefinitions : []),
      tokens: structuredClone(Array.isArray(scene.tokens) ? scene.tokens : []),
    };
    state.markers = structuredClone(Array.isArray(scene.markers) ? scene.markers : []);
    state.attackAreas = structuredClone(Array.isArray(scene.attackAreas) ? scene.attackAreas : []);
    state.sceneEvents = structuredClone(Array.isArray(scene.sceneEvents) ? scene.sceneEvents : []);
    state.preferences.gridVisible = scene.settings?.gridVisible !== false;
  }
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
    const tokenIds = unique(scene.tokens, `worldV2.scenes[${sceneIndex}].tokens`);
    for (const [tokenIndex, tokenRaw] of scene.tokens.entries()) {
      const token = object(tokenRaw, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}]`);
      const actorId = cleanId(token.actorId, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].actorId`);
      if (!actorIds.has(actorId)) fail(`World V2 Token references missing Actor: ${actorId}`, 'invalid_reference');
      if (typeof token.actorLink !== 'boolean') fail('worldV2 token.actorLink must be boolean');
      if (token.actorDelta !== null && token.actorDelta !== undefined
        && (!token.actorDelta || typeof token.actorDelta !== 'object' || Array.isArray(token.actorDelta))) {
        fail('worldV2 token.actorDelta must be an object or null');
      }

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
    const attackAreas = array(scene.attackAreas, `worldV2.scenes[${sceneIndex}].attackAreas`);
    for (const [areaIndex, rawArea] of attackAreas.entries()) {
      const area = object(rawArea, `worldV2.scenes[${sceneIndex}].attackAreas[${areaIndex}]`);
      const anchor = area.anchor;
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) continue;
      if (anchor.type === 'token') {
        const tokenId = cleanId(anchor.tokenId, `worldV2.scenes[${sceneIndex}].attackAreas[${areaIndex}].anchor.tokenId`);
        if (!tokenIds.has(tokenId)) fail(`Attack area references missing Token: ${tokenId}`, 'invalid_reference');
      }
      if (anchor.type === 'character' || Object.hasOwn(anchor, 'characterId')) {
        fail('World V2 attack-area anchors must use tokenId', 'legacy_character_forbidden');
      }
    }
    array(scene.sceneEvents, `worldV2.scenes[${sceneIndex}].sceneEvents`);
  }
  return world;
}
