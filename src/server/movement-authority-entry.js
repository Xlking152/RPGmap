import { createMovementAuthority } from '../movement/authority.js';
import { normalizeActorDocument } from '../actor/model.js';
import { resolveStatuses } from '../status/model.js';
import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';

// The verified package store owns immutable map defaults. Scene changes remain
// separate mutable inputs; this entry never imports authoring map data.
let resolveInstalledMap = () => null;

/** The authority receives maps from the verified, versioned package store. */
export function setServerMapResolver(resolve) {
  if (typeof resolve !== 'function') throw new TypeError('Map resolver must be a function');
  resolveInstalledMap = resolve;
}

export function mapForScene(scene) {
  const reference = scene?.mapPackage || {};
  const mapPackage = resolveInstalledMap(scene) || null;
  if (!mapPackage) return null;
  if (String(mapPackage.id) !== String(reference.id ?? reference.mapId ?? '')) return null;
  const requestedVersion = String(reference.version ?? reference.mapVersion ?? '');
  const actualVersion = String(mapPackage.version ?? mapPackage.mapVersion ?? '');
  return requestedVersion && requestedVersion !== actualVersion ? null : mapPackage;
}

// Only the fixed bundled ruleset may reuse status derivation. Custom hooks,
// imports and mutable input follow the original resolver on every call.
// Coordinates, collision geometry, movement budgets and permissions are
// checked independently below; this cache contains no audience projection.
const canonicalMovementInputs = new Map();
let canonicalMovementScope = null;
const borrowMovementInputs = Symbol('borrowMovementInputs');

function frozenDataValue(object, key) {
  if (!object || !Object.isFrozen(object)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
}

function hasFixedMovementInputHooks(ruleset) {
  // Re-preparing the server's built-in package preserves these function
  // identities. Frozen own data prevents getters replacing a hook after this
  // check. Custom normalizers/derivers may retain references to their outputs.
  const actor = frozenDataValue(ruleset, 'actor');
  const statuses = frozenDataValue(ruleset, 'statuses');
  const movement = frozenDataValue(ruleset, 'movement');
  return ['migrateLegacy', 'normalizeSystem', 'derive'].every(key =>
    frozenDataValue(actor, key) === infiniteHorrorRuleset.actor[key])
    && frozenDataValue(statuses, 'derive') === infiniteHorrorRuleset.statuses.derive
    && frozenDataValue(movement, 'describe') === infiniteHorrorRuleset.movement.describe
    && frozenDataValue(movement, 'calculateCost') === infiniteHorrorRuleset.movement.calculateCost;
}

function freezeMovementInputs(value) {
  const visiting = new WeakSet(), complete = new WeakSet(), nodes = [];
  const inspect = current => {
    if (current === null || ['string', 'boolean'].includes(typeof current)) return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (!current || typeof current !== 'object' || visiting.has(current)) return false;
    if (complete.has(current)) return true;
    const array = Array.isArray(current), prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(current);
    if (array && keys.length !== current.length + 1) return false;
    visiting.add(current);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (array && key !== (index === current.length ? 'length' : String(index))) return false;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')
        || !(array && key === 'length') && !descriptor.enumerable || !inspect(descriptor.value)) return false;
    }
    visiting.delete(current); complete.add(current); nodes.push(current);
    return true;
  };
  if (!inspect(value)) return false;
  for (const node of nodes) Object.freeze(node);
  return true;
}

export function prepareCanonicalMovementInputs({ world, scene, token, ruleset, isCanonicalData, canonicalMovementRuleset = null }, mode = null) {
  // Server bundles carry distinct copies of the same prepared ruleset. The
  // host supplies its fixed instance through this internal context only.
  if (ruleset !== (canonicalMovementRuleset || infiniteHorrorRuleset) || typeof isCanonicalData !== 'function') return null;
  if (scene?.tokens?.find(item => String(item?.id) === String(token?.id)) !== token) return null;
  const actor = world?.actors?.find(item => String(item?.id) === String(token?.actorId));
  const definitions = world?.statusDefinitions;
  if (!actor || isCanonicalData(actor) !== true || isCanonicalData(token) !== true || isCanonicalData(definitions) !== true) return null;
  // Legacy defaults may acquire fresh timestamps on normalization, and
  // synthetic documents must keep their complete per-instance resolution.
  if (token.actorLink !== true || ![actor.createdAt, actor.updatedAt]
    .every(value => typeof value === 'string' && value.trim().length > 0)) return null;
  if (!canonicalMovementScope || canonicalMovementScope.worldId !== world.id || canonicalMovementScope.sceneId !== scene.id
    || canonicalMovementScope.definitions !== definitions
    || canonicalMovementScope.ruleset !== ruleset) {
    canonicalMovementInputs.clear();
    canonicalMovementScope = { worldId: world.id, sceneId: scene.id, definitions, ruleset };
  }
  const key = JSON.stringify([actor.id, token.id]);
  let entry = canonicalMovementInputs.get(key);
  // An unrelated Actor update replaces the collection, not this document.
  // The fresh first-match lookup and exact Actor dependency below still
  // invalidate replacement, reordering of duplicate IDs and same-ID imports.
  if (!entry || entry.ruleset !== ruleset || entry.actor !== actor || entry.definitions !== definitions
    || entry.actorLink !== token.actorLink || entry.actorDelta !== token.actorDelta || entry.effects !== token.effects) {
    // The guarded linked Token already selected this exact first-match Actor.
    // Run the same complete normalization without building the resolver's
    // discarded Token/baseActor copies. Status and returned copies stay fresh.
    const resolvedActor = normalizeActorDocument(actor, { ruleset });
    const status = resolveStatuses({ schemaVersion: 4, actors: [resolvedActor], tokens: [token], statusDefinitions: definitions },
      { actorId: token.actorId, tokenId: token.id, ruleset });
    entry = { ruleset, actor, definitions, actorLink: token.actorLink, actorDelta: token.actorDelta, effects: token.effects,
      resolvedActor, status };
  }
  // Callers receive private mutable copies. Keep one version per Actor/Token
  // key and at most 64 entries, including after imports or scene changes.
  canonicalMovementInputs.delete(key);
  canonicalMovementInputs.set(key, entry);
  if (canonicalMovementInputs.size > 64) canonicalMovementInputs.delete(canonicalMovementInputs.keys().next().value);
  const borrow = mode === borrowMovementInputs && hasFixedMovementInputHooks(ruleset);
  if (borrow && entry.readOnlyInputs) return entry.readOnlyInputs;
  const detached = { actor: structuredClone(entry.resolvedActor), status: structuredClone(entry.status) };
  // Only this module's authority borrows the snapshot. The public preparation
  // API still returns independent mutable copies, including after a loan.
  if (borrow && freezeMovementInputs(detached)) entry.readOnlyInputs = detached;
  return detached;
}

export const validateAuthoritativeTokenMovePath = createMovementAuthority(mapForScene,
  { prepareActorInputs: args => prepareCanonicalMovementInputs(args, borrowMovementInputs) });
