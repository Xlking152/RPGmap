import { normalizeActorClassification } from '../actor/classification.js';
import { normalizeTokenAccess } from '../token/access.js';
import { normalizeFogState } from '../vision/fog.js';
import { normalizeLightweightMarker } from '../marker/model.js';
import { normalizeEntityStatusState, STATUS_SCHEMA_VERSION } from '../status/model.js';
import { upgradeBuiltInMapReference, upgradeBuiltInRulesetReference } from './package-upgrades.js';

export { upgradeBuiltInMapReference, upgradeBuiltInRulesetReference } from './package-upgrades.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export const FEET_TO_METERS = 0.3048;

export function feetToMeters(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    const error = new TypeError('Legacy feet value must be finite');
    error.code = 'world_metric_migration_invalid';
    throw error;
  }
  return number * FEET_TO_METERS;
}

function migrateFeetField(target, feetKey, metersKey) {
  if (!plainObject(target) || !Object.hasOwn(target, feetKey)) return;
  if (!Object.hasOwn(target, metersKey)) target[metersKey] = feetToMeters(target[feetKey]);
  delete target[feetKey];
}

function migrateMetricActor(actor) {
  const next = clone(actor);
  if (plainObject(next.prototypeToken)) migrateFeetField(next.prototypeToken, 'elevationFt', 'elevationMeters');
  return next;
}

function migrateMetricScene(scene, schemaVersion) {
  const next = clone(scene);
  next.mapPackage = { ...upgradeBuiltInMapReference(next.mapPackage, schemaVersion) };
  next.tokens = (Array.isArray(next.tokens) ? next.tokens : []).map(rawToken => {
    const token = clone(rawToken);
    migrateFeetField(token, 'elevationFt', 'elevationMeters');
    return token;
  });
  for (const state of Object.values(plainObject(next.featureStates) ? next.featureStates : {})) {
    if (plainObject(state?.custom)) migrateFeetField(state.custom, 'blockingHeightFt', 'blockingHeightMeters');
  }
  if (plainObject(next.combat?.turnOrigin)) migrateFeetField(next.combat.turnOrigin, 'elevationFt', 'elevationMeters');
  next.settings = plainObject(next.settings) ? next.settings : {};
  if (!Object.hasOwn(next.settings, 'lineOfSightEnabled')) next.settings.lineOfSightEnabled = false;
  return next;
}

export function migrateWorldSchema4State(rawState, { statusDefinitions = null } = {}) {
  const state = clone(rawState);
  const world = state?.preferences?.worldV2;
  if (!plainObject(world)) return Object.freeze({ state, migrated: false, fromSchemaVersion: null });
  const schemaVersion = Number(world.schemaVersion);
  if (![2, 3, 4].includes(schemaVersion)) {
    const error = new Error(`World schema ${world.schemaVersion ?? '(missing)'} is incompatible`);
    error.code = 'world_schema_incompatible';
    throw error;
  }

  const before = JSON.stringify(state);
  world.ruleset = { ...upgradeBuiltInRulesetReference(world.ruleset, schemaVersion) };
  world.actors = (Array.isArray(world.actors) ? world.actors : []).map(rawActor => {
    const actor = clone(rawActor);
    if (schemaVersion === 2) {
      const classification = normalizeActorClassification(actor, { legacy: true });
      actor.type = classification.type;
      actor.partyId = classification.partyId;
    }
    return migrateMetricActor(actor);
  });
  const actors = new Map(world.actors.map(actor => [String(actor?.id ?? ''), actor]));
  world.scenes = (Array.isArray(world.scenes) ? world.scenes : []).map(rawScene => {
    const scene = migrateMetricScene(rawScene, schemaVersion);
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
  if (normalizedStatus.tokens.length !== allTokens.length
    || normalizedStatus.tokens.some((token, index) => String(token.id) !== String(allTokens[index].id))) {
    throw Object.assign(new Error('Status migration changed Token identities'), { code: 'migration_token_identity_changed' });
  }
  // Status normalization preserves order; Token IDs are unique within a Scene,
  // not across the World. Rebuild the original Scene partitions without an ID map.
  let tokenOffset = 0;
  world.scenes = world.scenes.map(scene => ({ ...scene,
    tokens: normalizedStatus.tokens.slice(tokenOffset, tokenOffset += scene.tokens.length),
  }));
  world.schemaVersion = 4;
  state.preferences ||= {};
  if (plainObject(state.preferences.combatSystem?.combat?.turnOrigin)) {
    migrateFeetField(state.preferences.combatSystem.combat.turnOrigin, 'elevationFt', 'elevationMeters');
  }
  if (state.mapId === 'northern-song-lanzhou-1104' && ['1.0.5', '1.0.6'].includes(String(state.mapVersion))) {
    state.mapVersion = '1.1.0';
  }
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

// Historical name retained for third-party extensions during the v2.4 cycle.
export const migrateWorldSchema3State = migrateWorldSchema4State;
