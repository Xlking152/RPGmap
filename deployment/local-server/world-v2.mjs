import { assertStatusState, STATUS_SCHEMA_VERSION } from './status-operations.mjs';
import { assertFeatureStatePatch, isPlainObject } from './world-operations.mjs';

const ACTOR_TYPES = new Set(['pc', 'monster', 'npc', 'summon', 'other']);
const VISIBILITY_MODES = new Set(['public', 'party', 'gm', 'users']);

export const WORLD_V2_SCHEMA_VERSION = 3;
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
      schemaVersion: STATUS_SCHEMA_VERSION,
      actors: structuredClone(Array.isArray(world.actors) ? world.actors : []),
      statusDefinitions: structuredClone(Array.isArray(world.statusDefinitions) ? world.statusDefinitions : []),
      tokens: structuredClone(Array.isArray(scene.tokens) ? scene.tokens : []),
    };
    state.markers = structuredClone(Array.isArray(scene.markers) ? scene.markers : []);
    state.attackAreas = structuredClone(Array.isArray(scene.attackAreas) ? scene.attackAreas : []);
    state.sceneEvents = structuredClone(Array.isArray(scene.sceneEvents) ? scene.sceneEvents : []);
    state.preferences.featureStates = structuredClone(isPlainObject(scene.featureStates) ? scene.featureStates : {});
    delete state.preferences.featureInteractions;
    state.preferences.gridVisible = scene.settings?.gridVisible !== false;
  }
  return world;
}

function stringIds(value, label) {
  const seen = new Set();
  for (const [index, item] of array(value, label).entries()) {
    const id = cleanId(item, `${label}[${index}]`);
    if (seen.has(id)) fail(`${label} contains duplicate id: ${id}`, 'duplicate_id');
    seen.add(id);
  }
}

function assertFog(value, label) {
  const fog = object(value, label);
  if (Number(fog.schemaVersion) !== 1 || Number(fog.cellSizeMeters) !== 5) fail(`${label} schema is incompatible`, 'fog_schema_incompatible');
  for (const [partyId, record] of Object.entries(object(fog.exploredByParty, `${label}.exploredByParty`))) {
    cleanId(partyId, `${label}.partyId`);
    const rows = object(object(record, `${label}.${partyId}`).rows, `${label}.${partyId}.rows`);
    for (const [rowId, spans] of Object.entries(rows)) {
      if (!/^\d+$/.test(rowId)) fail(`${label}.${partyId}.rows contains an invalid row`);
      let previousEnd = -2;
      for (const span of array(spans, `${label}.${partyId}.rows.${rowId}`)) {
        if (!Array.isArray(span) || span.length !== 2) fail(`${label} contains an invalid span`);
        const [start, end] = span.map(Number);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start <= previousEnd + 1) {
          fail(`${label} contains a non-canonical span`);
        }
        previousEnd = end;
      }
    }
  }
}

function assertTokenAccess(token, actor, label) {
  if (['monster', 'npc', 'summon'].includes(String(actor.type)) && token.actorLink !== false) fail(`${label} cannot link an independent Actor`, 'instance_link_forbidden');
  stringIds(token.controllerUserIds, `${label}.controllerUserIds`);
  const visibility = object(token.visibility, `${label}.visibility`);
  if (!VISIBILITY_MODES.has(String(visibility.mode))) fail(`${label}.visibility.mode is invalid`);
  stringIds(visibility.userIds, `${label}.visibility.userIds`);
  const vision = object(token.vision, `${label}.vision`);
  if (typeof vision.enabled !== 'boolean') fail(`${label}.vision.enabled must be boolean`);
  for (const field of ['preciseRangeOverrideMeters', 'vagueRangeOverrideMeters']) {
    if (vision[field] !== null && (!Number.isFinite(Number(vision[field]))
      || Number(vision[field]) < 0)) fail(`${label}.vision.${field} is invalid`);
  }
  if (vision.preciseRangeOverrideMeters !== null && vision.vagueRangeOverrideMeters !== null
    && Number(vision.vagueRangeOverrideMeters) < Number(vision.preciseRangeOverrideMeters)) {
    fail(`${label}.vision vague range cannot be smaller than precise range`);
  }
  if (Object.hasOwn(vision, 'rangeOverrideMeters')) fail(`${label}.vision.rangeOverrideMeters is legacy-only`);
  stringIds(vision.overrideUserIds, `${label}.vision.overrideUserIds`);
  if (Object.hasOwn(token, 'hidden')) fail(`${label}.hidden is legacy-only`, 'legacy_token_hidden_forbidden');
}

function assertMarker(marker, label) {
  if (!['trap', 'target', 'area', 'note'].includes(String(marker.kind))) fail(`${label}.kind is invalid`);
  finite(marker.x, `${label}.x`);
  finite(marker.y, `${label}.y`);
  stringIds(marker.controllerUserIds, `${label}.controllerUserIds`);
  const visibility = object(marker.visibility, `${label}.visibility`);
  if (!VISIBILITY_MODES.has(String(visibility.mode))) fail(`${label}.visibility.mode is invalid`);
  stringIds(visibility.userIds, `${label}.visibility.userIds`);
  if (marker.partyId !== null && typeof marker.partyId !== 'string') fail(`${label}.partyId must be a string or null`);
}

export function assertWorldV2(value) {
  const world = object(value, 'worldV2');
  if (Number(world.schemaVersion) !== WORLD_V2_SCHEMA_VERSION) fail('worldV2.schemaVersion must be 3');
  cleanId(world.id, 'worldV2.id');
  const ruleset = object(world.ruleset, 'worldV2.ruleset');
  cleanId(ruleset.id, 'worldV2.ruleset.id');
  if (typeof ruleset.version !== 'string' || !ruleset.version.trim()) fail('worldV2.ruleset.version is required');
  const actorIds = unique(world.actors, 'worldV2.actors');
  const actorById = new Map(world.actors.map(actor => [String(actor?.id ?? ''), actor]));
  world.actors.forEach((actor, index) => {
    if (!ACTOR_TYPES.has(String(actor.type))) fail(`worldV2.actors[${index}].type is invalid`);
    if (actor.partyId !== null && typeof actor.partyId !== 'string') fail(`worldV2.actors[${index}].partyId must be a string or null`);
  });
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
    if (scene.featureStates !== undefined) {
      if (!isPlainObject(scene.featureStates)) fail(`worldV2.scenes[${sceneIndex}].featureStates must be an object`);
      for (const [featureId, state] of Object.entries(scene.featureStates)) {
        cleanId(featureId, `worldV2.scenes[${sceneIndex}].featureStates key`);
        if (!isPlainObject(state)) fail(`worldV2.scenes[${sceneIndex}].featureStates.${featureId} must be an object`);
        assertFeatureStatePatch(state);
      }
    }
    const tokenIds = unique(scene.tokens, `worldV2.scenes[${sceneIndex}].tokens`);
    for (const [tokenIndex, tokenRaw] of scene.tokens.entries()) {
      const token = object(tokenRaw, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}]`);
      const actorId = cleanId(token.actorId, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].actorId`);
      if (!actorIds.has(actorId)) fail(`World V2 Token references missing Actor: ${actorId}`, 'invalid_reference');
      if (typeof token.actorLink !== 'boolean') fail('worldV2 token.actorLink must be boolean');
      assertTokenAccess(token, actorById.get(actorId), `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}]`);
      if (token.actorDelta !== null && token.actorDelta !== undefined
        && (!token.actorDelta || typeof token.actorDelta !== 'object' || Array.isArray(token.actorDelta))) {
        fail('worldV2 token.actorDelta must be an object or null');
      }

      if (token.actorLink === false && token.actorDelta) {
        const baseActor = actorById.get(actorId);
        const resolved = syntheticActor(baseActor, token.actorDelta);
        try {
          assertStatusState({
            schemaVersion: STATUS_SCHEMA_VERSION,
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
    unique(scene.markers, `worldV2.scenes[${sceneIndex}].markers`);
    scene.markers.forEach((marker, markerIndex) => assertMarker(marker, `worldV2.scenes[${sceneIndex}].markers[${markerIndex}]`));
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
    assertFog(scene.fog, `worldV2.scenes[${sceneIndex}].fog`);
  }
  return world;
}
