import { normalizeActorClassification } from '../actor/classification.js';
import { normalizeTokenAccess } from '../token/access.js';
import { normalizeFogState } from '../vision/fog.js';
import { normalizeLightweightMarker } from '../marker/model.js';
import { normalizeEntityStatusState, STATUS_SCHEMA_VERSION } from '../status/model.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function migrateWorldSchema3State(rawState, { statusDefinitions = null } = {}) {
  const state = clone(rawState);
  const world = state?.preferences?.worldV2;
  if (!plainObject(world)) return Object.freeze({ state, migrated: false, fromSchemaVersion: null });
  const schemaVersion = Number(world.schemaVersion);
  if (![2, 3].includes(schemaVersion)) {
    const error = new Error(`World schema ${world.schemaVersion ?? '(missing)'} is incompatible`);
    error.code = 'world_schema_incompatible';
    throw error;
  }

  const before = JSON.stringify(state);
  world.actors = (Array.isArray(world.actors) ? world.actors : []).map(rawActor => {
    const actor = clone(rawActor);
    if (schemaVersion === 2) {
      const classification = normalizeActorClassification(actor, { legacy: true });
      actor.type = classification.type;
      actor.partyId = classification.partyId;
    }
    return actor;
  });
  const actors = new Map(world.actors.map(actor => [String(actor?.id ?? ''), actor]));
  world.scenes = (Array.isArray(world.scenes) ? world.scenes : []).map(rawScene => {
    const scene = clone(rawScene);
    scene.tokens = (Array.isArray(scene.tokens) ? scene.tokens : []).map(rawToken => {
      const token = clone(rawToken);
      const access = normalizeTokenAccess(token, { actor: actors.get(String(token.actorId ?? '')) || null });
      token.controllerUserIds = access.controllerUserIds;
      token.visibility = access.visibility;
      token.vision = access.vision;
      delete token.hidden;
      return token;
    });
    scene.markers = (Array.isArray(scene.markers) ? scene.markers : [])
      .map(rawMarker => normalizeLightweightMarker(rawMarker)).filter(marker => marker.id);
    scene.fog = normalizeFogState(scene.fog);
    return scene;
  });
  const configuredDefinitions = Array.isArray(statusDefinitions) ? statusDefinitions : [];
  const configuredIds = new Set(configuredDefinitions.map(definition => String(definition?.id || '')));
  const persistedDefinitions = Array.isArray(world.statusDefinitions) ? world.statusDefinitions : [];
  const definitions = configuredDefinitions.length
    ? [
      ...configuredDefinitions.map(definition => ({ ...clone(definition), builtIn: true })),
      ...persistedDefinitions.filter(definition => !configuredIds.has(String(definition?.id || '')))
        .map(definition => ({ ...clone(definition), builtIn: false })),
    ]
    : persistedDefinitions;
  const allTokens = world.scenes.flatMap(scene => scene.tokens || []);
  const normalizedStatus = normalizeEntityStatusState({
    schemaVersion: state.preferences?.entitySystem?.schemaVersion || 3,
    statusDefinitions: definitions,
    actors: world.actors,
    tokens: allTokens,
  });
  world.actors = normalizedStatus.actors;
  world.statusDefinitions = normalizedStatus.statusDefinitions;
  const tokensById = new Map(normalizedStatus.tokens.map(token => [String(token.id), token]));
  world.scenes = world.scenes.map(scene => ({
    ...scene,
    tokens: (scene.tokens || []).map(token => clone(tokensById.get(String(token.id)) || token)),
  }));
  world.schemaVersion = 3;
  state.preferences ||= {};
  const activeScene = world.scenes.find(scene => String(scene.id) === String(world.activeSceneId)) || world.scenes[0];
  state.preferences.entitySystem = {
    ...(plainObject(state.preferences.entitySystem) ? state.preferences.entitySystem : {}),
    schemaVersion: STATUS_SCHEMA_VERSION,
    actors: clone(world.actors),
    tokens: clone(activeScene?.tokens || []),
    statusDefinitions: clone(world.statusDefinitions),
  };
  const migrated = before !== JSON.stringify(state);
  return Object.freeze({ state, migrated, fromSchemaVersion: schemaVersion });
}
