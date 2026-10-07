import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';
import { INFINITE_HORROR_ACTOR_SYSTEM_VERSION } from '../rulesets/infinite-horror/actor.js';

const movementDescribe = infiniteHorrorRuleset.movement.describe;
const legacyActorFields = ['forms', 'currentFormId', 'runtime'];
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)));

// The fixed server movement descriptor reads only runtime movement grants and
// the current Token grants. Its Actor normalizer preserves those runtime grants.
// Reuse an already accepted immutable linked Actor for that descriptor alone;
// effects, permissions, vision and final World validation keep their own paths.
export function createServerMovementAdjudicationActorResolver({ isCanonicalData } = {}) {
  return ({ world, token, ruleset } = {}) => {
    if (ruleset !== infiniteHorrorRuleset || ruleset.movement.describe !== movementDescribe
      || typeof isCanonicalData !== 'function' || world?.schemaVersion !== 4
      || world.ruleset?.id !== ruleset.id || world.ruleset?.version !== ruleset.version
      || token?.actorLink !== true || !Array.isArray(world.actors)) return null;
    try {
      // Keep the public resolver's first matching Actor precedence. Changed
      // Actor documents have no accepted proof and use the original resolver.
      const actor = world.actors.find(candidate => String(candidate?.id ?? '') === String(token.actorId));
      if (!actor || !Object.isFrozen(actor) || isCanonicalData(actor) !== true
        || legacyActorFields.some(field => Object.hasOwn(actor, field))) return null;
      const system = actor.system;
      if (!plain(system) || system.schemaVersion !== INFINITE_HORROR_ACTOR_SYSTEM_VERSION
        || !plain(system.runtime) || !Array.isArray(system.forms)
        || system.runtime.movementCapabilities != null && !plain(system.runtime.movementCapabilities)
        || ruleset.actor.validateSystem(system).length) return null;
      return actor;
    } catch {
      // Qualification cannot suppress the original resolution/error behavior.
      return null;
    }
  };
}
