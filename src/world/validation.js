import { WORLD_SCHEMA_VERSION } from './model.js';

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

export function worldRulesetReference(rawWorld) {
  const world = object(rawWorld, 'worldV2');
  const reference = object(world.ruleset, 'worldV2.ruleset');
  const id = identifier(reference.id, 'worldV2.ruleset.id');
  const version = typeof reference.version === 'string' ? reference.version.trim() : '';
  if (!version) fail('worldV2.ruleset.version is required', 'world_ruleset_missing');
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

export function assertPersistedWorldV2(rawWorld) {
  const world = object(rawWorld, 'worldV2');
  if (Number(world.schemaVersion) !== WORLD_SCHEMA_VERSION) {
    fail(`worldV2.schemaVersion must be ${WORLD_SCHEMA_VERSION}`, 'world_schema_incompatible');
  }
  identifier(world.id, 'worldV2.id');
  worldRulesetReference(world);
  const actorIds = uniqueIds(world.actors, 'worldV2.actors');
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
    uniqueIds(scene.tokens, `worldV2.scenes[${sceneIndex}].tokens`);
    for (const [tokenIndex, rawToken] of scene.tokens.entries()) {
      const token = object(rawToken, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}]`);
      const actorId = identifier(token.actorId, `worldV2.scenes[${sceneIndex}].tokens[${tokenIndex}].actorId`);
      if (!actorIds.has(actorId)) {
        fail(`World V2 Token references missing Actor: ${actorId}`, 'invalid_reference');
      }
    }
  }
  return world;
}
