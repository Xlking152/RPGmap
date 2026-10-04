import { createMovementAuthority } from '../movement/authority.js';
import { createMinimalReferencePackage } from '../../reference/maps/minimal/package.js';
import lanzhouMapPackage from '../../reference/maps/lanzhou/runtime.json' with { type: 'json' };
import { resolveTokenActor } from '../token/actor.js';
import { resolveStatuses } from '../status/model.js';
import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';

const packages = new Map([
  [String(lanzhouMapPackage.id), lanzhouMapPackage],
]);
const minimal = createMinimalReferencePackage();
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
    || canonicalMovementScope.actors !== world.actors || canonicalMovementScope.definitions !== definitions
    || canonicalMovementScope.ruleset !== ruleset) {
    canonicalMovementInputs.clear();
    canonicalMovementScope = { worldId: world.id, sceneId: scene.id, actors: world.actors, definitions, ruleset };
  }
  const key = JSON.stringify([actor.id, token.id]);
  let entry = canonicalMovementInputs.get(key);
  if (!entry || entry.ruleset !== ruleset || entry.actor !== actor || entry.definitions !== definitions
    || entry.actorLink !== token.actorLink || entry.actorDelta !== token.actorDelta || entry.effects !== token.effects) {
    const resolvedActor = resolveTokenActor({ ...world, activeSceneId: scene.id, scenes: [scene] }, token.id, { ruleset }).actor;
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
