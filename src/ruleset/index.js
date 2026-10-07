import { RulesetRegistry } from './registry.js';
import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';

export { RULESET_API_VERSION, prepareRuleset } from './contract.js';
export { RulesetRegistry } from './registry.js';

export const rulesetRegistry = new RulesetRegistry([infiniteHorrorRuleset]);
// Internal read-only implementation identity, captured before any extension
// can replace a registry entry with another Ruleset using the same ID.
export const registeredInfiniteHorrorRuleset = rulesetRegistry.require(infiniteHorrorRuleset.id);

let activeRulesetId = infiniteHorrorRuleset.id;

export function listRulesets() {
  return rulesetRegistry.list();
}

export function getActiveRuleset() {
  return rulesetRegistry.require(activeRulesetId);
}

export function setActiveRuleset(id) {
  const ruleset = rulesetRegistry.require(id);
  activeRulesetId = ruleset.id;
  return ruleset;
}

export function resolveRulesetReference(reference) {
  return rulesetRegistry.resolveReference(reference);
}

export function activeRulesetIdValue() {
  return activeRulesetId;
}
