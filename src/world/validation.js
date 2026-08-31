import { WORLD_SCHEMA_VERSION } from './constants.js';
import { assertFeatureStatePatch, isPlainObject } from './feature-states.js';

const ACTOR_TYPES = new Set(['pc', 'monster', 'npc', 'summon', 'other']);
const VISIBILITY_MODES = new Set(['public', 'party', 'gm', 'users']);

function fail(message, code = 'invalid_world') {
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

function identifier(value, label) {
  const result = value == null ? '' : String(value).trim();
  if (!result) fail(`${label} requires an id`);
  return result;
}

function uniqueIds(items, label) {
  const seen = new Set();
  for (const [index, item] of array(items, label).entries()) {
    const value = identifier(object(item, `${label}[${index}]`).id, `${label}[${index}].id`);
    if (seen.has(value)) fail(`${label} contains duplicate id: ${value}`, 'duplicate_id');
    seen.add(value);
  }
  return seen;
}

function stringIds(value, label) {
  const seen = new Set();
  for (const [index, item] of array(value, label).entries()) {
    const id = identifier(item, `${label}[${index}]`);
    if (seen.has(id)) fail(`${label} contains duplicate id: ${id}`, 'duplicate_id');
    seen.add(id);
  }
}

function assertFog(value, label) {
  const fog = object(value, label);
  if (Number(fog.schemaVersion) !== 1 || Number(fog.cellSizeMeters) !== 5) fail(`${label} schema is incompatible`, 'fog_schema_incompatible');
  const parties = object(fog.exploredByParty, `${label}.exploredByParty`);
  for (const [partyId, record] of Object.entries(parties)) {
    identifier(partyId, `${label}.partyId`);
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

function assertSchema3Actor(actor, label) {
  if (!ACTOR_TYPES.has(String(actor.type))) fail(`${label}.type is invalid`);
  if (actor.partyId !== null && typeof actor.partyId !== 'string') fail(`${label}.partyId must be a string or null`);
}

function assertSchema3Token(token, actor, label) {
  if (typeof token.actorLink !== 'boolean') fail(`${label}.actorLink must be boolean`);
  if (['monster', 'npc', 'summon'].includes(String(actor.type)) && token.actorLink !== false) fail(`${label} cannot link an independent Actor`, 'instance_link_forbidden');
  stringIds(token.controllerUserIds, `${label}.controllerUserIds`);
  const visibility = object(token.visibility, `${label}.visibility`);
  if (!VISIBILITY_MODES.has(String(visibility.mode))) fail(`${label}.visibility.mode is invalid`);
  stringIds(visibility.userIds, `${label}.visibility.userIds`);
  const vision = object(token.vision, `${label}.vision`);
  if (typeof vision.enabled !== 'boolean') fail(`${label}.vision.enabled must be boolean`);
  if (vision.rangeOverrideMeters !== null && (!Number.isFinite(Number(vision.rangeOverrideMeters))
    || Number(vision.rangeOverrideMeters) < 0 || Number(vision.rangeOverrideMeters) > 120)) {
    fail(`${label}.vision.rangeOverrideMeters is invalid`);
  }
  stringIds(vision.overrideUserIds, `${label}.vision.overrideUserIds`);
  if (Object.hasOwn(token, 'hidden')) fail(`${label}.hidden is legacy-only`, 'legacy_token_hidden_forbidden');
}

function assertMarker(marker, label) {
  if (!['trap', 'target', 'area', 'note'].includes(String(marker.kind))) fail(`${label}.kind is invalid`);
  if (!Number.isFinite(Number(marker.x)) || !Number.isFinite(Number(marker.y))) fail(`${label} requires finite x/y`);
  stringIds(marker.controllerUserIds, `${label}.controllerUserIds`);
  const visibility = object(marker.visibility, `${label}.visibility`);
  if (!VISIBILITY_MODES.has(String(visibility.mode))) fail(`${label}.visibility.mode is invalid`);
  stringIds(visibility.userIds, `${label}.visibility.userIds`);
  if (marker.partyId !== null && typeof marker.partyId !== 'string') fail(`${label}.partyId must be a string or null`);
}

export function worldRulesetReference(rawWorld) {
  const world = object(rawWorld, 'worldV2');
  if (!world.ruleset || typeof world.ruleset !== 'object' || Array.isArray(world.ruleset)) {
    fail('worldV2.ruleset is required', 'world_ruleset_missing');
  }
  const reference = world.ruleset;
  const id = reference.id == null ? '' : String(reference.id).trim();
  const version = typeof reference.version === 'string' ? reference.version.trim() : '';
  if (!id || !version) fail('worldV2.ruleset id and version are required', 'world_ruleset_missing');
  return Object.freeze({ id, version });
}

export function assertWorldRuleset(rawWorld, ruleset) {
  const reference = worldRulesetReference(rawWorld);
  if (!ruleset?.id || String(ruleset.id) !== reference.id) {
    fail(`World requires ruleset ${reference.id}`, 'world_ruleset_reload_required');
  }
  if (String(ruleset.version || '') !== reference.version) {
    fail(
      `World requires ruleset ${reference.id} v${reference.version}; installed version is ${ruleset.version || '(missing)'}`,
      'ruleset_version_incompatible',
    );
  }
  return reference;
}

export function assertPersistedWorldV2(rawWorld, { acceptedSchemaVersions = [2, WORLD_SCHEMA_VERSION] } = {}) {
  const world = object(rawWorld, 'worldV2');
  const accepted = new Set(acceptedSchemaVersions.map(Number));
  if (!accepted.has(Number(world.schemaVersion))) {
    fail(`worldV2.schemaVersion must be one of: ${[...accepted].join(', ')}`, 'world_schema_incompatible');
  }
  identifier(world.id, 'worldV2.id');
  worldRulesetReference(world);
  const actorIds = uniqueIds(world.actors, 'worldV2.actors');
  const actorsById = new Map(world.actors.map(actor => [String(actor.id), actor]));
  if (Number(world.schemaVersion) === WORLD_SCHEMA_VERSION) {
    world.actors.forEach((actor, index) => assertSchema3Actor(actor, `worldV2.actors[${index}]`));
  }
  const sceneIds = uniqueIds(world.scenes, 'worldV2.scenes');
  const activeSceneId = identifier(world.activeSceneId, 'worldV2.activeSceneId');
  if (!sceneIds.has(activeSceneId)) {
    fail(`worldV2.activeSceneId references missing Scene: ${activeSceneId}`, 'invalid_reference');
  }

  for (const [sceneIndex, rawScene] of world.scenes.entries()) {
    const scene = object(rawScene, `worldV2.scenes[${sceneIndex}]`);
    const mapPackage = object(scene.mapPackage, `worldV2.scenes[${sceneIndex}].mapPackage`);
    identifier(mapPackage.id, `worldV2.scenes[${sceneIndex}].mapPackage.id`);
    if (typeof mapPackage.version !== 'string' || !mapPackage.version.trim()) {
      fail(`worldV2.scenes[${sceneIndex}].mapPackage.version is required`);
    }
    if (scene.featureStates !== undefined) {
      if (!isPlainObject(scene.featureStates)) fail(`worldV2.scenes[${sceneIndex}].featureStates must be an object`);
      for (const [featureId, state] of Object.entries(scene.featureStates)) {
        identifier(featureId, `worldV2.scenes[${sceneIndex}].featureStates key`);
        if (!isPlainObject(state)) fail(`worldV2.scenes[${sceneIndex}].featureStates.${featureId} must be an object`);
        assertFeatureStatePatch(state);
      }
    }
    uniqueIds(scene.tokens, `worldV2.scenes[${sceneIndex}].tokens`);
    for (const [tokenIndex, rawToken] of scene.tokens.entries()) {
      const token = object(rawToken, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}]`);
      const actorId = identifier(token.actorId, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].actorId`);
      if (!actorIds.has(actorId)) {
        fail(`World V2 Token references missing Actor: ${actorId}`, 'invalid_reference');
      }
      if (Number(world.schemaVersion) === WORLD_SCHEMA_VERSION) {
        assertSchema3Token(token, actorsById.get(actorId), `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}]`);
      }
    }
    if (Number(world.schemaVersion) === WORLD_SCHEMA_VERSION) assertFog(scene.fog, `worldV2.scenes[${sceneIndex}].fog`);
    if (Number(world.schemaVersion) === WORLD_SCHEMA_VERSION) {
      uniqueIds(scene.markers, `worldV2.scenes[${sceneIndex}].markers`);
      scene.markers.forEach((marker, markerIndex) => assertMarker(marker, `worldV2.scenes[${sceneIndex}].markers[${markerIndex}]`));
    }
  }
  return world;
}
