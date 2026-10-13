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
export function prepareCanonicalMovementInputs({ world, scene, token, ruleset, isCanonicalData, canonicalMovementRuleset = null }) {
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
  return { actor: structuredClone(entry.resolvedActor), status: structuredClone(entry.status) };
}

export const validateAuthoritativeTokenMovePath = createMovementAuthority(mapForScene,
  { prepareActorInputs: prepareCanonicalMovementInputs });
