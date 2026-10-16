import { RulesetRegistry } from './registry.js';
import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';

export { RULESET_API_VERSION, prepareRuleset } from './contract.js';
export { RulesetRegistry } from './registry.js';

export const rulesetRegistry = new RulesetRegistry([infiniteHorrorRuleset]);
// Internal read-only implementation identity, captured before any extension
// can replace a registry entry with another Ruleset using the same ID.
export const registeredInfiniteHorrorRuleset = rulesetRegistry.require(infiniteHorrorRuleset.id);

let activeRulesetReference = { id: infiniteHorrorRuleset.id, version: infiniteHorrorRuleset.version };

export function listRulesets() {
  return rulesetRegistry.list();
}

export function getActiveRuleset() {
  return rulesetRegistry.resolveReference(activeRulesetReference);
}

export function setActiveRuleset(reference) {
  const ruleset = typeof reference === 'string' ? rulesetRegistry.require(reference) : rulesetRegistry.resolveReference(reference);
  activeRulesetReference = { id: ruleset.id, version: ruleset.version };
  return ruleset;
}

export function resolveRulesetReference(reference) {
  return rulesetRegistry.resolveReference(reference);
}

export function activeRulesetIdValue() {
  return activeRulesetReference.id;
}
