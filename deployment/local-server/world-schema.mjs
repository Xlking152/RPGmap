import { types } from 'node:util';
import { performance } from 'node:perf_hooks';
import { assertCanonicalStatusState, assertStatusState } from './status-operations.mjs';
import { assertCanonicalWorldV2, assertWorldV2 } from './world-v2.mjs';
const diagnosticNow = performance.now.bind(performance);

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

const ONE_JSON_NODE = Object.freeze({ nodes: 1, depth: 0 });
function ownDescriptorField(descriptor, field) {
  return descriptor && Object.hasOwn(descriptor, field) ? descriptor[field] : undefined;
}
const standardArrayMap = ownDescriptorField(Object.getOwnPropertyDescriptor(Array.prototype, 'map'), 'value');
const standardArrayIterator = ownDescriptorField(Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator), 'value');
const standardArraySpecies = ownDescriptorField(Object.getOwnPropertyDescriptor(Array, Symbol.species), 'get');
const snapshotDescriptorReader = Object.getOwnPropertyDescriptor;
const snapshotHasOwn = Object.hasOwn;
const snapshotTraversalHooks = [
  [Object, 'entries', Object.entries], [Object, 'getPrototypeOf', Object.getPrototypeOf],
  [Object, 'getOwnPropertyDescriptor', Object.getOwnPropertyDescriptor],
  [Object, 'getOwnPropertyDescriptors', Object.getOwnPropertyDescriptors],
  [Object, 'getOwnPropertyNames', Object.getOwnPropertyNames], [Object, 'hasOwn', Object.hasOwn],
  [Object, 'isFrozen', Object.isFrozen], [types, 'isProxy', types.isProxy],
  [Reflect, 'ownKeys', Reflect.ownKeys], [Array, 'isArray', Array.isArray],
  [Number, 'isFinite', Number.isFinite], [Math, 'max', Math.max], [JSON, 'stringify', JSON.stringify],
  [globalThis, 'WeakSet', WeakSet],
  [WeakSet.prototype, 'has', WeakSet.prototype.has], [WeakSet.prototype, 'add', WeakSet.prototype.add],
  [WeakSet.prototype, 'delete', WeakSet.prototype.delete],
  [WeakMap.prototype, 'get', WeakMap.prototype.get], [WeakMap.prototype, 'has', WeakMap.prototype.has],
  [WeakMap.prototype, 'set', WeakMap.prototype.set], [WeakMap.prototype, 'delete', WeakMap.prototype.delete],
  [Map.prototype, 'get', Map.prototype.get], [Map.prototype, 'has', Map.prototype.has],
  [Map.prototype, 'set', Map.prototype.set], [Map.prototype, 'delete', Map.prototype.delete],
  [Map.prototype, 'keys', Map.prototype.keys],
  [Array.prototype, 'includes', Array.prototype.includes], [Array.prototype, 'every', Array.prototype.every],
  [Array.prototype, 'push', Array.prototype.push],
  [String.prototype, 'endsWith', String.prototype.endsWith], [String.prototype, 'includes', String.prototype.includes],
  [Buffer, 'byteLength', Buffer.byteLength],
];
const standardSnapshotTraversal = (() => {
  for (let index = 0; index < snapshotTraversalHooks.length; index++) {
    const entry = snapshotTraversalHooks[index], method = entry[2];
    if (entry[0] !== Buffer && (typeof method !== 'function'
      || !Function.prototype.toString.call(method).includes('[native code]'))) return false;
  }
  return true;
})();
const standardArrayMethods = typeof standardArrayMap === 'function'
  && Function.prototype.toString.call(standardArrayMap) === 'function map() { [native code] }'
  && typeof standardArrayIterator === 'function'
  && Function.prototype.toString.call(standardArrayIterator) === 'function values() { [native code] }'
  && typeof standardArraySpecies === 'function'
  && Function.prototype.toString.call(standardArraySpecies) === 'function get [Symbol.species]() { [native code] }';

const standardArrayIteratorState = (() => {
  if (!standardArrayMethods) return null;
  try {
    const iterator = Reflect.apply(standardArrayIterator, [], []);
    const prototype = Object.getPrototypeOf(iterator);
    const next = ownDescriptorField(Object.getOwnPropertyDescriptor(prototype, 'next'), 'value');
    if (typeof next !== 'function' || Function.prototype.toString.call(next) !== 'function next() { [native code] }'
      || Reflect.apply(next, iterator, []).done !== true) return null;
    let chain = null, current = prototype;
    while (current) {
      const parent = Object.getPrototypeOf(current);
      chain = { prototype: current, parent, next: chain };
      current = parent;
    }
    return { prototype, next, chain };
  } catch { return null; }
})();

function standardArrayIteration() {
  const state = standardArrayIteratorState;
  if (!state || ownDescriptorField(Object.getOwnPropertyDescriptor(state.prototype, 'next'), 'value') !== state.next) return false;
  for (let entry = state.chain; entry; entry = entry.next) {
    if (Object.getPrototypeOf(entry.prototype) !== entry.parent
      || Object.getOwnPropertyDescriptor(entry.prototype, 'return')) return false;
  }
  return true;
}

// This proof is local to one snapshot attempt. An accepted immutable document
// needs no scan; a new graph must contain only ordinary own JSON data, so no
// child can change iterator hooks while the optimized loop is running.
function readOnlyJsonGraph(value, immutableData, acceptedNode = null, proven = null, leanDescriptors = false) {
  const visiting = new WeakSet(), accepted = new WeakSet();
  let nodes = 0;
  const inspect = (current, depth) => {
    if (++nodes > WORLD_LIMITS.maxNodes || depth > WORLD_LIMITS.maxDepth) return false;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (!current || typeof current !== 'object' || types.isProxy(current)) return false;
    if (immutableData.has(current) || accepted.has(current)) return true;
    if (acceptedNode && !acceptedNode(current)) return false;
    if (visiting.has(current)) return false;
    const arrayValue = Array.isArray(current), prototype = Object.getPrototypeOf(current);
    if (arrayValue ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    if (arrayValue && current.length > WORLD_LIMITS.maxArrayLength) return false;
    const keys = Reflect.ownKeys(current);
    const descriptors = leanDescriptors ? null : Object.getOwnPropertyDescriptors(current);
    if (arrayValue && (keys.length !== current.length + 1 || keys[current.length] !== 'length')) return false;
    visiting.add(current);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index], descriptor = descriptors ? descriptors[key] : Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')
        || !(arrayValue && key === 'length') && !descriptor.enumerable) return false;
      if (!(arrayValue && key === 'length') && !inspect(descriptor.value, depth + 1)) return false;
    }
    visiting.delete(current);
    accepted.add(current);
    if (proven) proven.push(current);
    return true;
  };
  return inspect(value, 0);
}

// map() reads every Array value before the visitor descends into any child.
// Keep that snapshot order, but avoid a separate [index, value] allocation for
// every dense ordinary data slot. Descriptor checks do not read a map getter;
// unusual Arrays retain the complete original map/iterator path below.
function standardArrayDataHooks() {
  if (!standardArrayMethods || !standardArrayIteration()) return false;
  const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const constructor = Object.getOwnPropertyDescriptor(Array.prototype, 'constructor');
  const species = Object.getOwnPropertyDescriptor(Array, Symbol.species);
  if (ownDescriptorField(map, 'value') !== standardArrayMap || ownDescriptorField(iterator, 'value') !== standardArrayIterator
    || ownDescriptorField(constructor, 'value') !== Array || ownDescriptorField(species, 'get') !== standardArraySpecies
    || ownDescriptorField(species, 'set')) return false;
  return true;
}

function wholeSnapshotProofAllowed() {
  if (!standardSnapshotTraversal) return false;
  for (let index = 0; index < snapshotTraversalHooks.length; index++) {
    const entry = snapshotTraversalHooks[index], owner = entry[0], key = entry[1], method = entry[2];
    const descriptor = snapshotDescriptorReader(owner, key);
    if (!descriptor || !snapshotHasOwn(descriptor, 'value') || descriptor.value !== method) return false;
  }
  // Native push still uses inherited setters on the private pending/proof
  // Arrays. Any numeric prototype property can change input after this proof,
  // so keep the complete per-Array fallback when one is present.
  const prototypes = [Array.prototype, Object.prototype];
  for (let prototypeIndex = 0; prototypeIndex < prototypes.length; prototypeIndex++) {
    const names = Object.getOwnPropertyNames(prototypes[prototypeIndex]);
    for (let index = 0; index < names.length; index++) {
      if (names[index].length && Number.isFinite(+names[index])) return false;
    }
  }
  return standardArrayDataHooks();
}

function denseArrayDataSnapshot(value, immutableData) {
  if (!standardArrayDataHooks() || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  if (!readOnlyJsonGraph(value, immutableData)) return null;
  // Native map creates own data slots, preserving its species/property rules
  // and avoiding inherited numeric setters while allocating only this copy.
  return value.map(entry => entry);
}

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
    actorIds = documentCache?.collection('entityActorIds', entityState.actors);
    if (!actorIds) {
      actorIds = assertUniqueIds(entityState.actors, 'entitySystem.actors');
      documentCache?.stageCollection('entityActorIds', entityState.actors, actorIds);
    }
    const tokenIndex = documentCache?.collection('entityTokens', entityState.tokens, entityState.actors, hasWorldV2);
    tokenIds = tokenIndex || assertUniqueIds(entityState.tokens, 'entitySystem.tokens');
    if (!tokenIndex) for (const [index, token] of entityState.tokens.entries()) {
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
    if (!tokenIndex) documentCache?.stageCollection('entityTokens', entityState.tokens, tokenIds, entityState.actors, hasWorldV2);
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
// a different key limit. Unchanged, immutable Actor/definition arrays reuse
// their private structural indexes; new Token collections and all references
// still use the current candidate. Getter/Proxy branches never seed a cache.
export function createCanonicalWorldValidator({ diagnostics = false, compactMetadata = false } = {}) {
  // The fixed server reducer owns these derived facts. One weak record per
  // accepted JSON object avoids repeatedly resizing separate weak tables during
  // large Fog commits. Public validators keep their original intrinsic calls.
  // Spread new identities across four smaller weak tables. A large Fog history
  // should not make a tiny movement pause while one whole table grows. Each
  // object still owns exactly one record; lookup reads identities only.
  const metadataTables = compactMetadata ? [new WeakMap(), new WeakMap(), new WeakMap(), new WeakMap()] : null;
  let nextMetadataTable = 0;
  const metadata = metadataTables ? {
    get(value) {
      return metadataTables[0].get(value) || metadataTables[1].get(value)
        || metadataTables[2].get(value) || metadataTables[3].get(value);
    },
    set(value, record) {
      metadataTables[nextMetadataTable].set(value, record);
      nextMetadataTable = (nextMetadataTable + 1) % metadataTables.length;
    },
  } : null;
  const missingMetadata = metadata ? Symbol('missing canonical metadata') : null;
  const recordFor = value => {
    let record = metadata.get(value);
    if (!record) {
      // Fixed own slots avoid a separate property dictionary on every node.
      // The sentinel retains Map.has/delete semantics, including stored undefined.
      record = { summaries: missingMetadata, singlePath: missingMetadata, singleSummary: missingMetadata, bytes: missingMetadata,
        immutable: false, accepted: false, pure: false, documents: missingMetadata, collections: missingMetadata };
      metadata.set(value, record);
    }
    return record;
  };
  const weakMap = field => metadata ? {
    get(value) { const entry = metadata.get(value)?.[field]; return entry === missingMetadata ? undefined : entry; },
    has: value => { const record = metadata.get(value); return Boolean(record && record[field] !== missingMetadata); },
    set(value, entry) { recordFor(value)[field] = entry; },
    delete(value) {
      const record = metadata.get(value);
      if (!record || record[field] === missingMetadata) return false;
      record[field] = missingMetadata; return true;
    },
  } : new WeakMap();
  const weakSet = field => metadata ? {
    has: value => metadata.get(value)?.[field] === true,
    add(value) { recordFor(value)[field] = true; },
  } : new WeakSet();
  const summaries = weakMap('summaries');
  // Most frozen JSON branches recur at one canonical path. Avoid allocating
  // a Map for every Token/Fog row; aliases still promote to the original
  // bounded path map, so global occurrence/depth/key accounting is unchanged.
  const singleSummaries = metadata ? null : new WeakMap();
  const byteSizes = weakMap('bytes');
  const immutableData = weakSet('immutable');
  const acceptedData = weakSet('accepted');
  const immutableDataProofs = weakSet('pure');
  const isImmutableData = value => {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
    const record = metadata?.get(value);
    if (metadata ? !record?.accepted : !acceptedData.has(value)) return false;
    if (metadata ? record.pure : immutableDataProofs.has(value)) return true;
    const proven = [];
    if (!readOnlyJsonGraph(value, immutableDataProofs,
      current => acceptedData.has(current) && Object.isFrozen(current), proven)) return false;
    // A later getter in an accepted candidate may have replaced an earlier
    // data slot. Freeze alone does not prove purity; commit this separate
    // descriptor-only proof only after the complete graph passes.
    for (let index = 0; index < proven.length; index++) immutableDataProofs.add(proven[index]);
    return true;
  };
  const acceptedDataProof = { has: isImmutableData };
  const verifiedDocuments = weakMap('documents');
  const verifiedCollections = weakMap('collections');
  const measurements = [];
  const validate = value => {
    const times = diagnostics ? { start: diagnosticNow() } : null;
    const pending = [];
    const pendingDocuments = [];
    const pendingCollections = [];
    // No input hook may run in this synchronous JSON visitor when the whole
    // root is ordinary data and traversal intrinsics remain standard. Share
    // that one proof only within this call; a partial or failed proof seeds
    // neither this memo nor the accepted/frozen graph caches.
    let snapshotData = acceptedDataProof, singleSummaryAllowed = false;
    if (wholeSnapshotProofAllowed()) {
      const proven = [];
      if (readOnlyJsonGraph(value, acceptedDataProof, null, proven, true)) {
        const localProof = new WeakSet(proven);
        snapshotData = { has: current => localProof.has(current) || acceptedDataProof.has(current) };
        singleSummaryAllowed = true;
      }
    }
    if (times) times.proof = diagnosticNow();
    const documentCache = {
      verified(kind, document, ...dependencies) {
        if (!document || typeof document !== 'object' || !immutableData.has(document)) return false;
        const accepted = verifiedDocuments.get(document)?.get(kind);
        return accepted?.length === dependencies.length
          && accepted.every((dependency, index) => dependency === dependencies[index]);
      },
      stage(kind, document, ...dependencies) {
        if (document && typeof document === 'object') pendingDocuments.push({ kind, document, dependencies });
      },
      collection(kind, collection, ...dependencies) {
        const accepted = verifiedCollections.get(collection)?.get(kind);
        if (!accepted || accepted.dependencies.length !== dependencies.length
          || !accepted.dependencies.every((dependency, index) => dependency === dependencies[index])) return null;
        return accepted.value;
      },
      stageCollection(kind, collection, index, ...dependencies) {
        if (Array.isArray(collection)) pendingCollections.push({ kind, collection, value: index, dependencies });
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
        let cached;
        if (metadata) {
          const record = metadata.get(current);
          cached = record?.singlePath === path ? record.singleSummary
            : record && record.summaries !== missingMetadata ? record.summaries.get(path) : null;
        } else {
          const single = singleSummaries.get(current);
          cached = single?.path === path ? single.summary : summaries.get(current)?.get(path);
        }
        if (cached) { consume(cached, path, depth); return cached; }
      }
      consume(ONE_JSON_NODE, path, depth);
      const summary = { nodes: 1, depth: 0, bytes: 0, cacheable: true };
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
      let entries, dataSnapshot = null;
      if (Array.isArray(current)) {
        if (current.length > WORLD_LIMITS.maxArrayLength) fail(`${path} exceeds maximum length`, 'world_limit');
        dataSnapshot = denseArrayDataSnapshot(current, snapshotData);
        entries = dataSnapshot || current.map((entry, index) => [index, entry]);
      } else {
        if (!current || typeof current !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(current))) fail(`${path} is not JSON-safe`);
        entries = Object.entries(current);
        if (entries.length > objectKeyLimit(path)) fail(`${path} has too many keys`, 'world_limit');
      }
      // Freezing an accessor or Proxy does not make its observed values
      // immutable. Only ordinary own enumerable data properties (and an
      // Array's length) may enter either the JSON or structural caches.
      const arrayValue = dataSnapshot ? true : Array.isArray(current);
      summary.cacheable = Boolean(dataSnapshot) || !types.isProxy(current)
        && (arrayValue ? Object.getPrototypeOf(current) === Array.prototype
          : [Object.prototype, null].includes(Object.getPrototypeOf(current)))
        && Reflect.ownKeys(current).length === entries.length + (arrayValue ? 1 : 0);
      summary.bytes = 2 + Math.max(0, entries.length - 1);
      if (dataSnapshot) {
        for (let index = 0; index < dataSnapshot.length; index++) {
          const child = visit(dataSnapshot[index], `${path}[${index}]`, depth + 1);
          summary.nodes += child.nodes;
          summary.depth = Math.max(summary.depth, child.depth + 1);
          summary.bytes += child.bytes;
          if (!child.cacheable) summary.cacheable = false;
        }
      } else for (const [key, entry] of entries) {
        if (summary.cacheable) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) summary.cacheable = false;
        }
        if (!Array.isArray(current)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${path} contains an unsafe key`);
          if (key.length > 160) fail(`${path} has an oversized key`, 'world_limit');
        }
        const child = visit(entry, Array.isArray(current) ? `${path}[${key}]` : `${path}.${key}`, depth + 1);
        summary.nodes += child.nodes;
        summary.depth = Math.max(summary.depth, child.depth + 1);
        summary.bytes += child.bytes + (Array.isArray(current) ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
        if (!child.cacheable) summary.cacheable = false;
      }
      pending.push(metadata ? { value: current, path, summary, metadataRecord: null }
        : { value: current, path, summary });
      return summary;
    };
    visit(value, 'state', 0);
    if (times) times.json = diagnosticNow();
    assertWorldStateStructure(value, documentCache);
    if (times) times.structure = diagnosticNow();
    // Children precede parents. No rejected candidate can seed trusted entries.
    for (const entry of pending) {
      Object.freeze(entry.value);
      if (metadata) {
        // One lookup per newly frozen branch; retain the same bounded alias
        // summaries and delay acceptance until every branch has frozen.
        const record = recordFor(entry.value);
        entry.metadataRecord = record;
        if (entry.summary.cacheable) {
          record.immutable = true;
          let byPath = record.summaries === missingMetadata ? null : record.summaries;
          const hasSingle = record.singlePath !== missingMetadata;
          if (!byPath && (record.singlePath === entry.path || !hasSingle && singleSummaryAllowed)) {
            // Keep the path and summary in this existing weak record. Ordinary
            // Fog spans need no separate wrapper object for their one path.
            record.singlePath = entry.path; record.singleSummary = entry.summary;
          } else {
            if (!byPath) {
              byPath = new Map(); record.summaries = byPath;
              if (hasSingle) {
                byPath.set(record.singlePath, record.singleSummary);
                record.singlePath = missingMetadata; record.singleSummary = missingMetadata;
              }
            }
            if (byPath.size >= 8 && !byPath.has(entry.path)) byPath.delete(byPath.keys().next().value);
            byPath.set(entry.path, entry.summary);
          }
        }
        record.bytes = entry.summary.cacheable ? entry.summary.bytes : null;
        continue;
      }
      if (entry.summary.cacheable) {
        immutableData.add(entry.value);
        let byPath = summaries.get(entry.value);
        const single = singleSummaries.get(entry.value);
        if (!byPath && (single?.path === entry.path || !single && singleSummaryAllowed)) {
          if (single) single.summary = entry.summary;
          else singleSummaries.set(entry.value, { path: entry.path, summary: entry.summary });
        } else {
          if (!byPath) {
            byPath = new Map(); summaries.set(entry.value, byPath);
            if (single) { byPath.set(single.path, single.summary); singleSummaries.delete(entry.value); }
          }
          if (byPath.size >= 8 && !byPath.has(entry.path)) byPath.delete(byPath.keys().next().value);
          byPath.set(entry.path, entry.summary);
        }
      }
      // A null entry proves whole-candidate acceptance without trusting an
      // accessor/Proxy branch's earlier observed serialized size.
      byteSizes.set(entry.value, entry.summary.cacheable ? entry.summary.bytes : null);
    }
    if (times) times.freeze = diagnosticNow();
    const immutableDependencies = dependencies => dependencies.every(dependency =>
      !dependency || typeof dependency !== 'object' || immutableData.has(dependency));
    for (const entry of pendingDocuments) {
      if (!immutableData.has(entry.document) || !immutableDependencies(entry.dependencies)) continue;
      let records = verifiedDocuments.get(entry.document);
      if (!records) { records = new Map(); verifiedDocuments.set(entry.document, records); }
      // A document has only a fixed set of validator kinds. Replacing its last
      // dependency tuple avoids retaining every historical Actor/definition.
      records.set(entry.kind, entry.dependencies);
    }
    for (const entry of pendingCollections) {
      if (!immutableData.has(entry.collection) || !immutableDependencies(entry.dependencies)) continue;
      let records = verifiedCollections.get(entry.collection);
      if (!records) { records = new Map(); verifiedCollections.set(entry.collection, records); }
      // Indexes are private derived data. Keep only the latest dependency
      // tuple for each fixed validator kind, never a history of old Worlds.
      records.set(entry.kind, { value: entry.value, dependencies: entry.dependencies });
    }
    for (let index = 0; index < pending.length; index++) {
      if (metadata) pending[index].metadataRecord.accepted = true;
      else acceptedData.add(pending[index].value);
    }
    if (times) {
      measurements.push({ objects: pending.length, documents: pendingDocuments.length,
        collections: pendingCollections.length, proofMs: times.proof - times.start,
        jsonMs: times.json - times.proof, structureMs: times.structure - times.json,
        freezeMs: times.freeze - times.structure, metadataMs: diagnosticNow() - times.freeze });
      if (measurements.length > 256) measurements.shift();
    }
    return value;
  };
  // Data graphs are proved lazily; repeated queries are O(1). Consumers never
  // receive the private set, and rejected or accessor/Proxy graphs cannot seed it.
  const immutableProofDescriptor = Object.create(null);
  immutableProofDescriptor.value = isImmutableData;
  Object.defineProperty(validate, 'isImmutableData', immutableProofDescriptor);
  if (diagnostics) validate.getDiagnostics = () => measurements.map(entry => ({ ...entry }));
  validate.serializedBytes = (value, { omitPreferencesKeys = [] } = {}) => {
    const bytesFor = current => {
      if (current === null || typeof current !== 'object') return Buffer.byteLength(JSON.stringify(current));
      if (!byteSizes.has(current) || !Object.isFrozen(current)) fail('JSON size requires a verified canonical branch', 'unverified_canonical');
      return immutableData.has(current) ? byteSizes.get(current) : Buffer.byteLength(JSON.stringify(current));
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
