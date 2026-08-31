import { normalizeActorClassification } from '../actor/classification.js';
import { normalizeTokenAccess } from '../token/access.js';
import { normalizeFogState } from '../vision/fog.js';
import { normalizeLightweightMarker } from '../marker/model.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function migrateWorldSchema3State(rawState) {
  const state = clone(rawState);
  const world = state?.preferences?.worldV2;
  if (!plainObject(world)) return Object.freeze({ state, migrated: false, fromSchemaVersion: null });
  const schemaVersion = Number(world.schemaVersion);
  if (schemaVersion === 3) return Object.freeze({ state, migrated: false, fromSchemaVersion: 3 });
  if (schemaVersion !== 2) {
    const error = new Error(`World schema ${world.schemaVersion ?? '(missing)'} is incompatible`);
    error.code = 'world_schema_incompatible';
    throw error;
  }

  world.actors = (Array.isArray(world.actors) ? world.actors : []).map(rawActor => {
    const actor = clone(rawActor);
    const classification = normalizeActorClassification(actor, { legacy: true });
    actor.type = classification.type;
    actor.partyId = classification.partyId;
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
  world.schemaVersion = 3;
  return Object.freeze({ state, migrated: true, fromSchemaVersion: 2 });
}
