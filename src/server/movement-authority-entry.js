import { createMovementAuthority } from '../movement/authority.js';
import { createMinimalReferencePackage } from '../../reference/maps/minimal/package.js';
import lanzhouMapPackage from '../../reference/maps/lanzhou/runtime.json' with { type: 'json' };
import { normalizeActorDocument } from '../actor/model.js';
import { resolveStatuses } from '../status/model.js';
import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';

// Own the fixed bundled data before freezing it. Imported JSON and reference
// factories also serve public mutable adapters; freezing their shared inputs
// would change those contracts. Scene changes remain separate mutable inputs.
function ownBundledMap(source) {
  const { createSvg, ...data } = source;
  const owned = structuredClone(data);
  function freezeData(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freezeData);
      Object.freeze(value);
    }
    return value;
  }
  freezeData(owned);
  // Only the minimal map has this fixed renderer. Preserve its function and
  // top-level key order while all geometry and light data stays privately owned.
  return Object.freeze(Object.fromEntries(Object.keys(source).map(key =>
    [key, key === 'createSvg' ? createSvg : owned[key]])));
}
const lanzhou = ownBundledMap(lanzhouMapPackage);
const packages = new Map([
  [String(lanzhou.id), lanzhou],
]);
const minimal = ownBundledMap(createMinimalReferencePackage());
packages.set(String(minimal.id), minimal);

export function mapForScene(scene) {
  const reference = scene?.mapPackage || {};
  const mapPackage = packages.get(String(reference.id ?? reference.mapId ?? '')) || null;
  if (!mapPackage) return null;
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
