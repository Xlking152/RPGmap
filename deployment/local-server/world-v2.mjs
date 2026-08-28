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

function canonicalAttackArea(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return structuredClone(raw);
  const area = structuredClone(raw);
  const anchor = area.anchor;
  if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)
    && anchor.type === 'character' && anchor.characterId != null) {
    area.anchor = { type: 'token', tokenId: String(anchor.characterId) };
  }
  return area;
}

function mergeRuntimeTokenFields(canonicalToken, runtimeToken) {
  if (!runtimeToken || String(runtimeToken.id ?? '') !== String(canonicalToken.id ?? '')) {
    return structuredClone(canonicalToken);
  }
  const next = structuredClone(canonicalToken);
  next.actorLink = runtimeToken.actorLink !== false;
  if (runtimeToken.actorDelta && typeof runtimeToken.actorDelta === 'object' && !Array.isArray(runtimeToken.actorDelta)) {
    next.actorDelta = structuredClone(runtimeToken.actorDelta);
  }
  if (runtimeToken.actorDelta === null) next.actorDelta = null;
  if (runtimeToken.diameterMeters !== undefined) next.diameterMeters = Number(runtimeToken.diameterMeters);
  if (runtimeToken.rotation !== undefined) next.rotation = Number(runtimeToken.rotation);
  if (runtimeToken.elevationFt !== undefined) next.elevationFt = Number(runtimeToken.elevationFt);
  if (runtimeToken.hidden !== undefined) next.hidden = runtimeToken.hidden === true;
  if (runtimeToken.locked !== undefined) next.locked = runtimeToken.locked === true;
  if (runtimeToken.showName !== undefined) next.showName = runtimeToken.showName !== false;
  if (Array.isArray(runtimeToken.effects)) next.effects = structuredClone(runtimeToken.effects);
  return next;
}

export function synchronizeWorldV2Mirror(state) {
  const raw = state?.preferences?.[WORLD_V2_STATE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const world = structuredClone(raw);
  const entity = entityState(state);
  const actors = Array.isArray(entity.actors) && entity.actors.length
    ? structuredClone(entity.actors)
    : (Array.isArray(world.actors) ? structuredClone(world.actors) : []);
  const actorIds = new Set(actors.map(actor => String(actor?.id ?? '')).filter(Boolean));
  const runtimeTokens = new Map((Array.isArray(entity.tokens) ? entity.tokens : [])
    .filter(token => token?.id != null)
    .map(token => [String(token.id), token]));
  const scenes = Array.isArray(world.scenes) ? world.scenes : [];
  const activeSceneId = String(world.activeSceneId ?? '');
  const activeIndex = scenes.findIndex(scene => String(scene?.id ?? '') === activeSceneId);
  if (activeIndex >= 0) {
    const canonicalTokens = Array.isArray(scenes[activeIndex]?.tokens) ? scenes[activeIndex].tokens : [];
    scenes[activeIndex] = {
      ...scenes[activeIndex],
      // Placement/id/Actor binding are canonical Scene data. Flat Entity state
      // can only feed reducer-owned mechanical/display fields back into them.
      tokens: canonicalTokens
        .filter(token => actorIds.has(String(token?.actorId ?? '')))
        .map(token => mergeRuntimeTokenFields(token, runtimeTokens.get(String(token?.id ?? '')))),
      markers: Array.isArray(state.markers) ? structuredClone(state.markers) : [],
      attackAreas: Array.isArray(state.attackAreas) ? state.attackAreas.map(canonicalAttackArea) : [],
      sceneEvents: Array.isArray(state.sceneEvents) ? structuredClone(state.sceneEvents) : [],
      settings: {
        ...(scenes[activeIndex]?.settings && typeof scenes[activeIndex].settings === 'object' ? scenes[activeIndex].settings : {}),
        gridVisible: state?.preferences?.gridVisible !== false,
      },
    };
  }
  world.schemaVersion = WORLD_V2_SCHEMA_VERSION;
  world.actors = actors;
  world.statusDefinitions = Array.isArray(entity.statusDefinitions)
    ? structuredClone(entity.statusDefinitions)
    : (Array.isArray(world.statusDefinitions) ? structuredClone(world.statusDefinitions) : []);
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
    }
    array(scene.sceneEvents, `worldV2.scenes[${sceneIndex}].sceneEvents`);
  }
  return world;
}
