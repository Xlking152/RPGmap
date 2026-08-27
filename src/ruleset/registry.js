import { prepareRuleset } from './contract.js';

export class RulesetRegistry {
  constructor(initialRulesets = []) {
    this.rulesets = new Map();
    for (const ruleset of initialRulesets) this.register(ruleset);
  }

  register(rawRuleset) {
    const ruleset = prepareRuleset(rawRuleset);
    this.rulesets.set(ruleset.id, ruleset);
    return ruleset;
  }

  has(id) {
    return this.rulesets.has(String(id));
  }

  get(id) {
    return this.rulesets.get(String(id)) || null;
  }

  require(id) {
    const ruleset = this.get(id);
    if (!ruleset) throw new Error(`Unknown ruleset: ${id}`);
    return ruleset;
  }

  list() {
    return [...this.rulesets.values()];
  }
}
