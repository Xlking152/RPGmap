import { assertStatusState } from './status-operations.mjs';
import { assertWorldV2, synchronizeWorldV2Mirror } from './world-v2.mjs';

// The release server applies these hostile-input limits before any permission
// projection or authoritative World mutation.
export const WORLD_LIMITS = Object.freeze({
  maxDepth: 24,
  maxNodes: 20_000,
  maxArrayLength: 1_000,
  maxStringLength: 65_536,
  maxObjectKeys: 256,
  maxChatMessages: 500,
});

function fail(message, code = 'invalid_world') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label, max = WORLD_LIMITS.maxArrayLength) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > max) fail(`${label} exceeds maximum length`, 'world_limit');
  return value;
}

function id(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') fail(`${label} requires an id`);
  const result = String(value).trim();
  if (result.length > 160) fail(`${label} id is too long`, 'world_limit');
  return result;
}

export function assertUniqueIds(items, label, { field = 'id' } = {}) {
  const source = array(items, label);
  const seen = new Set();
  for (let index = 0; index < source.length; index += 1) {
    const entry = object(source[index], `${label}[${index}]`);
    const value = id(entry[field], `${label}[${index}].${field}`);
    if (seen.has(value)) fail(`${label} contains duplicate ${field}: ${value}`, 'duplicate_id');
    seen.add(value);
  }
  return seen;
}

export function assertSafeJson(value, label = 'world') {
  let nodes = 0;
  const visit = (current, path, depth) => {
    nodes += 1;
    if (nodes > WORLD_LIMITS.maxNodes) fail(`${label} exceeds maximum node count`, 'world_limit');
    if (depth > WORLD_LIMITS.maxDepth) fail(`${path} exceeds maximum depth`, 'world_limit');
    if (current === null || ['boolean', 'number'].includes(typeof current)) {
      if (typeof current === 'number' && !Number.isFinite(current)) fail(`${path} must contain finite numbers`);
      return;
    }
    if (typeof current === 'string') {
      if (current.length > WORLD_LIMITS.maxStringLength) fail(`${path} contains an oversized string`, 'world_limit');
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > WORLD_LIMITS.maxArrayLength) fail(`${path} exceeds maximum length`, 'world_limit');
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!current || typeof current !== 'object') fail(`${path} is not JSON-safe`);
    const entries = Object.entries(current);
    if (entries.length > WORLD_LIMITS.maxObjectKeys) fail(`${path} has too many keys`, 'world_limit');
    for (const [key, entry] of entries) {
      if (key.length > 160) fail(`${path} has an oversized key`, 'world_limit');
      visit(entry, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, label, 0);
  return value;
}

export function assertWorldState(value) {
  assertSafeJson(value, 'state');
  const state = object(value, 'state');

  // SaveV2 may still carry a legacy Character array during one-way migration,
  // but World V2 runtime authority never requires or joins through it.
  const characters = state.characters === undefined ? [] : array(state.characters, 'state.characters');
  const markers = state.markers === undefined ? [] : array(state.markers, 'state.markers');
  const attackAreas = state.attackAreas === undefined ? [] : array(state.attackAreas, 'state.attackAreas');
  assertUniqueIds(characters, 'state.characters');
  assertUniqueIds(markers, 'state.markers');
  assertUniqueIds(attackAreas, 'state.attackAreas');

  const preferences = state.preferences === undefined ? {} : object(state.preferences, 'state.preferences');
  const entities = preferences.entitySystem;
  let actorIds = new Set();
  let tokenIds = new Set();
  if (entities !== undefined) {
    const entityState = object(entities, 'state.preferences.entitySystem');
    actorIds = assertUniqueIds(entityState.actors, 'entitySystem.actors');
    tokenIds = assertUniqueIds(entityState.tokens, 'entitySystem.tokens');
    for (const [index, token] of entityState.tokens.entries()) {
      const actorId = id(token.actorId, `entitySystem.tokens[${index}].actorId`);
      if (!actorIds.has(actorId)) fail(`Token references missing Actor: ${actorId}`, 'invalid_reference');
      // characterId is accepted only as inert legacy input. Canonical runtime
      // identity is token.id; there is no one-Character-per-Token invariant.
      if (token.characterId !== undefined && token.characterId !== null && String(token.characterId).trim() !== '') {
        id(token.characterId, `entitySystem.tokens[${index}].characterId`);
      }
      if (token.diameterMeters !== undefined && ![1, 5, 10, 20].includes(Number(token.diameterMeters))) {
        fail(`entitySystem.tokens[${index}].diameterMeters must be 1, 5, 10, or 20`);
      }
    }
    assertStatusState(entityState);
  }

  // World V2 is canonical. Flat entity/scene fields remain a temporary reducer
  // projection, so merge only mutable mechanical fields back into the active
  // Scene without routing placement through Character documents.
  const worldV2 = synchronizeWorldV2Mirror(state);
  if (worldV2) assertWorldV2(worldV2);

  const chat = preferences.chatSystem;
  if (chat !== undefined) {
    const messages = array(object(chat, 'state.preferences.chatSystem').messages, 'chatSystem.messages', WORLD_LIMITS.maxChatMessages);
    assertUniqueIds(messages, 'chatSystem.messages');
    for (const [index, message] of messages.entries()) {
      if (!['chat', 'system', 'combat', 'damage', 'healing', 'roll'].includes(String(message.type))) fail(`chatSystem.messages[${index}] has an invalid type`);
      if (typeof message.text !== 'string' || message.text.length > 4_000) fail(`chatSystem.messages[${index}].text is invalid`, 'world_limit');
      if (typeof message.createdAt !== 'string') fail(`chatSystem.messages[${index}].createdAt is invalid`);
    }
  }

  const combat = preferences.combatSystem?.combat;
  if (combat !== undefined && combat !== null) {
    const combatState = object(combat, 'combatSystem.combat');
    const combatants = array(combatState.combatants, 'combatSystem.combat.combatants');
    assertUniqueIds(combatants, 'combatSystem.combat.combatants');
    for (const [index, combatant] of combatants.entries()) {
      const tokenId = id(combatant.tokenId, `combatants[${index}].tokenId`);
      if (!tokenIds.has(tokenId)) fail(`Combatant references missing Token: ${tokenId}`, 'invalid_reference');
      if (combatant.actorId !== null && combatant.actorId !== undefined && !actorIds.has(String(combatant.actorId))) {
        fail(`Combatant references missing Actor: ${combatant.actorId}`, 'invalid_reference');
      }
    }
  }
  return value;
}

export function isSameChat(before, next) {
  return JSON.stringify(before?.preferences?.chatSystem ?? null) === JSON.stringify(next?.preferences?.chatSystem ?? null);
}
