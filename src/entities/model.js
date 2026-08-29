import { normalizeElevationFt, normalizeTokenDiameterMeters } from '../elevation/model.js';
import { normalizeEntityStatusState, STATUS_SCHEMA_VERSION } from '../status/model.js';
import {
  createActorFromRulesetImport,
  deriveActorDocument,
  normalizeActorDocument,
  performActorOperation,
} from '../actor/index.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function uid(prefix) {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `${prefix}-${value}`;
}

export function createEmptyEntityState() {
  return { schemaVersion: STATUS_SCHEMA_VERSION, statusDefinitions: [], actors: [], tokens: [] };
}

export function createActorFromImport(imported, { id = uid('actor'), formId, formName, ruleset } = {}) {
  return createActorFromRulesetImport(imported, {
    id,
    variantId: formId,
    variantName: formName,
    ...(ruleset ? { ruleset } : {}),
  });
}

export function createFormFromImport(imported, { id, name, ruleset } = {}) {
  return deriveActorDocument(createActorFromRulesetImport(imported, {
    variantId: id,
    variantName: name,
    ...(ruleset ? { ruleset } : {}),
  }), ruleset ? { ruleset } : {})?.form || null;
}

export function createTokenForActor(actorId, tokenId, overrides = {}) {
  return {
    id: String(tokenId),
    actorId: String(actorId),
    texture: overrides.texture && typeof overrides.texture === 'object' ? clone(overrides.texture) : { src: null },
    color: typeof overrides.color === 'string' ? overrides.color : null,
    diameterMeters: normalizeTokenDiameterMeters(overrides.diameterMeters ?? overrides.size, 1),
    rotation: finite(overrides.rotation, 0),
    elevationFt: normalizeElevationFt(overrides.elevationFt, 0),
    hidden: Boolean(overrides.hidden),
    locked: Boolean(overrides.locked),
    showName: overrides.showName !== false,
    effects: Array.isArray(overrides.effects) ? clone(overrides.effects) : [],
  };
}

export function normalizeEntityState(raw, { ruleset } = {}) {
  if (!raw || typeof raw !== 'object') return createEmptyEntityState();
  const actors = Array.isArray(raw.actors)
    ? raw.actors.filter(Boolean).map(actor => normalizeActorDocument(actor, ruleset ? { ruleset } : {}))
    : [];
  const actorIds = new Set(actors.map(actor => String(actor.id)));
  const tokens = Array.isArray(raw.tokens)
    ? raw.tokens
      .filter(token => token && actorIds.has(String(token.actorId)))
      .map(token => {
        const next = clone(token);
        next.id = String(next.id ?? '');
        const diameterMeters = normalizeTokenDiameterMeters(next.diameterMeters ?? next.size, 1);
        delete next.size;
        return { ...next, diameterMeters, elevationFt: normalizeElevationFt(next.elevationFt, 0) };
      })
      .filter(token => token.id)
    : [];
  const normalizedStatuses = normalizeEntityStatusState({
    schemaVersion: raw.schemaVersion,
    statusDefinitions: raw.statusDefinitions,
    actors,
    tokens,
  });
  return {
    ...clone(raw),
    schemaVersion: STATUS_SCHEMA_VERSION,
    statusDefinitions: normalizedStatuses.statusDefinitions,
    actors: normalizedStatuses.actors.map(actor => normalizeActorDocument(actor, ruleset ? { ruleset } : {})),
    tokens: normalizedStatuses.tokens.map(clone),
  };
}

export function actorForToken(entityState, tokenId) {
  const token = entityState.tokens.find(item => String(item.id) === String(tokenId));
  if (!token) return null;
  return entityState.actors.find(actor => String(actor.id) === String(token.actorId)) || null;
}

export function currentForm(actor, { ruleset } = {}) {
  return deriveActorDocument(actor, ruleset ? { ruleset } : {})?.form || null;
}

export function addFormToActor(actor, imported, options = {}) {
  return performActorOperation(actor, {
    type: 'variant.add',
    imported,
    variantId: options.id,
    variantName: options.name,
  }, options.ruleset ? { ruleset: options.ruleset } : {}).value || null;
}
