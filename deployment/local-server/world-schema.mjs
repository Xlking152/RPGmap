import { assertCanonicalStatusState, assertStatusState } from './status-operations.mjs';
import { assertCanonicalWorldV2, assertWorldV2 } from './world-v2.mjs';

// The release server applies these hostile-input limits before any permission
// projection or authoritative World mutation.
export const WORLD_LIMITS = Object.freeze({
  maxDepth: 24,
  maxNodes: 200_000,
  maxArrayLength: 1_000,
  maxStringLength: 65_536,
  maxObjectKeys: 256,
  maxFogRowKeys: 32_768,
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

function objectKeyLimit(path) {
  // Fog is stored as a sparse row dictionary. Large sight radii are clipped to
  // the real map rectangle before persistence, so row growth follows map size
  // rather than vision radius. Keep a much larger final safety ceiling only for
  // canonical Fog rows (32768 × 5 m = 163.84 km vertically); the global node
  // budget and the multiplayer 8 MB payload budget remain additional bounds.
  return path.endsWith('.rows') && path.includes('.fog.exploredByParty.')
    ? WORLD_LIMITS.maxFogRowKeys
    : WORLD_LIMITS.maxObjectKeys;
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
    if (!current || typeof current !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(current))) fail(`${path} is not JSON-safe`);
    const entries = Object.entries(current);
    if (entries.length > objectKeyLimit(path)) fail(`${path} has too many keys`, 'world_limit');
    for (const [key, entry] of entries) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${path} contains an unsafe key`);
      if (key.length > 160) fail(`${path} has an oversized key`, 'world_limit');
      visit(entry, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, label, 0);
  return value;
}

function assertWorldStateStructure(value, documentCache = null) {
  const state = object(value, 'state');
  const preferences = state.preferences === undefined ? {} : object(state.preferences, 'state.preferences');
  const hasWorldV2 = preferences.worldV2 !== undefined && preferences.worldV2 !== null;
  const worldV2 = hasWorldV2 ? preferences.worldV2 : null;

  // Character documents are accepted only while reading a pre-World legacy
  // save. Once World V2 exists they are forbidden, even as an empty tombstone.
  if (hasWorldV2 && Object.hasOwn(state, 'characters')) {
    fail('World V2 state must not contain state.characters', 'legacy_character_forbidden');
  }
  const characters = !hasWorldV2 && state.characters !== undefined
    ? array(state.characters, 'state.characters')
    : [];
  const markers = state.markers === undefined ? [] : array(state.markers, 'state.markers');
  const attackAreas = state.attackAreas === undefined ? [] : array(state.attackAreas, 'state.attackAreas');
  assertUniqueIds(characters, 'state.characters');
  assertUniqueIds(markers, 'state.markers');
  assertUniqueIds(attackAreas, 'state.attackAreas');

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
      if (!documentCache?.verified('entityToken', token, hasWorldV2)) {
        if (hasWorldV2 && Object.hasOwn(token, 'characterId')) {
          fail(`entitySystem.tokens[${index}].characterId is forbidden in World V2`, 'legacy_character_forbidden');
        }
        if (!hasWorldV2 && token.characterId !== undefined && token.characterId !== null && String(token.characterId).trim() !== '') {
          id(token.characterId, `entitySystem.tokens[${index}].characterId`);
        }
        if (token.diameterMeters !== undefined && ![1, 5, 10, 20].includes(Number(token.diameterMeters))) {
          fail(`entitySystem.tokens[${index}].diameterMeters must be 1, 5, 10, or 20`);
        }
        documentCache?.stage('entityToken', token, hasWorldV2);
      }
    }
    if (documentCache) assertCanonicalStatusState(entityState, documentCache);
    else assertStatusState(entityState);
  }

  // World V2 is canonical. Flat entity/scene fields remain a reducer projection,
  // but placement and identity never route through Character documents.
  if (worldV2) {
    if (documentCache) assertCanonicalWorldV2(worldV2, documentCache);
    else assertWorldV2(worldV2);
  }

  const chat = preferences.chatSystem;
  if (chat !== undefined) {
    const messages = array(object(chat, 'state.preferences.chatSystem').messages, 'chatSystem.messages', WORLD_LIMITS.maxChatMessages);
    assertUniqueIds(messages, 'chatSystem.messages');
    for (const [index, message] of messages.entries()) {
      if (!['chat', 'system', 'combat', 'damage', 'healing', 'roll'].includes(String(message.type))) fail(`chatSystem.messages[${index}].type has an invalid type`);
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

export function assertWorldState(value) {
  assertSafeJson(value, 'state');
  return assertWorldStateStructure(value);
}

// This validator belongs to one server's canonical state stream. It is never
// used for client messages, imports, persisted JSON or replay patches. A branch
// enters the cache only after the entire canonical candidate passes validation,
// and is recursively frozen, so reference reuse is evidence of immutability.
// Summaries still count every occurrence of a shared branch against the global
// node/depth budgets, and are path-specific because Fog row dictionaries have
// a different key limit. Global uniqueness/reference checks still run on every
// result; only local checks of previously accepted frozen documents are reused.
export function createCanonicalWorldValidator() {
  const summaries = new WeakMap();
  const byteSizes = new WeakMap();
  const verifiedDocuments = new WeakMap();
  const validate = value => {
    const pending = [];
    const pendingDocuments = [];
    const documentCache = {
      verified(kind, document, ...dependencies) {
        if (!document || typeof document !== 'object' || !Object.isFrozen(document)) return false;
        const accepted = verifiedDocuments.get(document)?.get(kind);
        return accepted?.length === dependencies.length
          && accepted.every((dependency, index) => dependency === dependencies[index]);
      },
      stage(kind, document, ...dependencies) {
        if (document && typeof document === 'object') pendingDocuments.push({ kind, document, dependencies });
      },
    };
    let nodes = 0;
    const consume = (summary, path, depth) => {
      nodes += summary.nodes;
      if (nodes > WORLD_LIMITS.maxNodes) fail('state exceeds maximum node count', 'world_limit');
      if (depth + summary.depth > WORLD_LIMITS.maxDepth) fail(`${path} exceeds maximum depth`, 'world_limit');
    };
    const visit = (current, path, depth) => {
      if (current && typeof current === 'object') {
        const cached = summaries.get(current)?.get(path);
        if (cached) { consume(cached, path, depth); return cached; }
      }
      consume({ nodes: 1, depth: 0 }, path, depth);
      const summary = { nodes: 1, depth: 0, bytes: 0 };
      if (current === null || ['boolean', 'number'].includes(typeof current)) {
        if (typeof current === 'number' && !Number.isFinite(current)) fail(`${path} must contain finite numbers`);
        summary.bytes = Buffer.byteLength(JSON.stringify(current));
        return summary;
      }
      if (typeof current === 'string') {
        if (current.length > WORLD_LIMITS.maxStringLength) fail(`${path} contains an oversized string`, 'world_limit');
        summary.bytes = Buffer.byteLength(JSON.stringify(current));
        return summary;
      }
      let entries;
      if (Array.isArray(current)) {
        if (current.length > WORLD_LIMITS.maxArrayLength) fail(`${path} exceeds maximum length`, 'world_limit');
        entries = current.map((entry, index) => [index, entry]);
      } else {
        if (!current || typeof current !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(current))) fail(`${path} is not JSON-safe`);
        entries = Object.entries(current);
        if (entries.length > objectKeyLimit(path)) fail(`${path} has too many keys`, 'world_limit');
      }
      summary.bytes = 2 + Math.max(0, entries.length - 1);
      for (const [key, entry] of entries) {
        if (!Array.isArray(current)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${path} contains an unsafe key`);
          if (key.length > 160) fail(`${path} has an oversized key`, 'world_limit');
        }
        const child = visit(entry, Array.isArray(current) ? `${path}[${key}]` : `${path}.${key}`, depth + 1);
        summary.nodes += child.nodes;
        summary.depth = Math.max(summary.depth, child.depth + 1);
        summary.bytes += child.bytes + (Array.isArray(current) ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
      }
      pending.push({ value: current, path, summary });
      return summary;
    };
    visit(value, 'state', 0);
    assertWorldStateStructure(value, documentCache);
    // Children precede parents. No rejected candidate can seed trusted entries.
    for (const entry of pending) {
      Object.freeze(entry.value);
      let byPath = summaries.get(entry.value);
      if (!byPath) { byPath = new Map(); summaries.set(entry.value, byPath); }
      if (byPath.size >= 8 && !byPath.has(entry.path)) byPath.delete(byPath.keys().next().value);
      byPath.set(entry.path, entry.summary);
      byteSizes.set(entry.value, entry.summary.bytes);
    }
    for (const entry of pendingDocuments) {
      let records = verifiedDocuments.get(entry.document);
      if (!records) { records = new Map(); verifiedDocuments.set(entry.document, records); }
      // A document has only a fixed set of validator kinds. Replacing its last
      // dependency tuple avoids retaining every historical Actor/definition.
      records.set(entry.kind, entry.dependencies);
    }
    return value;
  };
  validate.serializedBytes = (value, { omitPreferencesKeys = [] } = {}) => {
    const bytesFor = current => {
      if (current === null || typeof current !== 'object') return Buffer.byteLength(JSON.stringify(current));
      if (!byteSizes.has(current) || !Object.isFrozen(current)) fail('JSON size requires a verified canonical branch', 'unverified_canonical');
      return byteSizes.get(current);
    };
    let bytes = bytesFor(value);
    const preferences = value?.preferences;
    const omitted = [...new Set(omitPreferencesKeys)].filter(key => Object.hasOwn(preferences || {}, key));
    if (omitted.length) {
      const fields = Object.keys(preferences).length;
      bytes -= Math.min(omitted.length, Math.max(0, fields - 1));
      for (const key of omitted) bytes -= Buffer.byteLength(JSON.stringify(key)) + 1 + bytesFor(preferences[key]);
    }
    return bytes;
  };
  return validate;
}

// This counter owns only server-derived snapshot metadata. Freeze and memoize
// its immutable branches; never use it to validate messages, imports or WAL.
function createPrivateSnapshotByteCounter() {
  const cached = new WeakMap();
  return value => {
    const pending = [];
    const visit = current => {
      if (current === null) return 4;
      if (['undefined', 'function', 'symbol'].includes(typeof current)) return undefined;
      if (typeof current !== 'object') return Buffer.byteLength(JSON.stringify(current));
      if (cached.has(current)) return cached.get(current);
      if (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current)))
        fail('Snapshot metadata must contain plain JSON objects', 'invalid_snapshot');
      let bytes = 2, count = 0;
      if (Array.isArray(current)) {
        for (let index = 0; index < current.length; index++) { bytes += (visit(current[index]) ?? 4) + (index ? 1 : 0); }
      } else {
        for (const [key, entry] of Object.entries(current)) {
          const child = visit(entry);
          if (child === undefined) continue;
          bytes += Buffer.byteLength(JSON.stringify(key)) + 1 + child + (count++ ? 1 : 0);
        }
      }
      pending.push({ value: current, bytes });
      return bytes;
    };
    const bytes = visit(value);
    for (const entry of pending) { Object.freeze(entry.value); cached.set(entry.value, entry.bytes); }
    return bytes;
  };
}

export function createWorldSnapshotSizeValidator(canonicalValidator, {
  maxStateBytes = 8 * 1024 * 1024,
  maxExplorationBytes = 32 * 1024 * 1024,
  maxSnapshotBytes = maxStateBytes + maxExplorationBytes,
} = {}) {
  const privateBytes = createPrivateSnapshotByteCounter();
  return snapshot => {
    const stateBytes = canonicalValidator.serializedBytes(snapshot.state, {
      omitPreferencesKeys: ['featureStates', 'featureInteractions'],
    });
    if (stateBytes > maxStateBytes) fail('World state is too large', 'state_too_large');
    const explorationBytes = snapshot.exploration === undefined ? 0 : privateBytes(snapshot.exploration);
    if (explorationBytes > maxExplorationBytes) fail('Exploration backlog is full; retry after it has drained', 'exploration_backlog');
    const envelope = { ...snapshot, state: null,
      ...(snapshot.exploration === undefined ? {} : { exploration: null }) };
    const snapshotBytes = privateBytes(envelope) + stateBytes - 4
      + (snapshot.exploration === undefined ? 0 : explorationBytes - 4);
    if (snapshotBytes > maxSnapshotBytes) fail('World snapshot is too large', 'state_too_large');
    return { stateBytes, explorationBytes, snapshotBytes };
  };
}

export function isSameChat(before, next) {
  return JSON.stringify(before?.preferences?.chatSystem ?? null) === JSON.stringify(next?.preferences?.chatSystem ?? null);
}
