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

export function createActorFromImport(imported, { id = uid('actor'), formId, formName } = {}) {
  return createActorFromRulesetImport(imported, {
    id,
    variantId: formId,
    variantName: formName,
  });
}

export function createFormFromImport(imported, { id, name } = {}) {
  return deriveActorDocument(createActorFromRulesetImport(imported, {
    variantId: id,
    variantName: name,
  }))?.form || null;
}

/** Legacy SaveV2 migration helper only. */
export function createLegacyActor(character, { actorId = uid('actor'), ruleset } = {}) {
  return createActorFromRulesetImport({
    formName: '默认形态',
    identity: { name: character?.name || '未命名角色' },
    avatarDataUrl: character?.avatarDataUrl || null,
    tokenAppearance: { color: character?.color || '#3d9b63', scale: 1 },
    source: { type: 'legacy-character', legacyId: character?.id },
  }, { id: actorId, variantName: '默认形态', ...(ruleset ? { ruleset } : {}) });
}

export function createTokenForActor(actorId, tokenId, overrides = {}) {
  return {
    id: String(tokenId),
    actorId: String(actorId),
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
        next.id = String(next.id ?? next.characterId ?? '');
        delete next.characterId;
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
    schemaVersion: STATUS_SCHEMA_VERSION,
    statusDefinitions: normalizedStatuses.statusDefinitions,
    actors: normalizedStatuses.actors.map(actor => normalizeActorDocument(actor, ruleset ? { ruleset } : {})),
    tokens: normalizedStatuses.tokens.map(token => {
      const next = clone(token);
      delete next.characterId;
      return next;
    }),
  };
}

/**
 * Explicit import boundary for pre-World saves. Modern runtime code must never
 * call this after WorldSystem has hydrated the canonical Actor/Token graph.
 */
export function migrateLegacyCharacters(entityState, characters = [], { ruleset } = {}) {
  const next = normalizeEntityState(entityState, ruleset ? { ruleset } : {});
  const linkedIds = new Set(next.tokens.map(token => String(token.id)));
  let migrated = 0;
  for (const character of characters || []) {
    if (!character?.id || linkedIds.has(String(character.id))) continue;
    const actor = createLegacyActor(character, { ruleset });
    next.actors.push(actor);
    next.tokens.push(createTokenForActor(actor.id, character.id));
    linkedIds.add(String(character.id));
    migrated += 1;
  }
  return { state: next, migrated };
}

export function actorForToken(entityState, tokenId) {
  const token = entityState.tokens.find(item => String(item.id) === String(tokenId));
  if (!token) return null;
  return entityState.actors.find(actor => String(actor.id) === String(token.actorId)) || null;
}

export function currentForm(actor) {
  return deriveActorDocument(actor)?.form || null;
}

export function addFormToActor(actor, imported, options = {}) {
  return performActorOperation(actor, {
    type: 'variant.add',
    imported,
    variantId: options.id,
    variantName: options.name,
  }).value || null;
}
