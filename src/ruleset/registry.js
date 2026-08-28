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

  resolveReference(reference = {}) {
    const id = typeof reference?.id === 'string' ? reference.id.trim() : '';
    const version = typeof reference?.version === 'string' ? reference.version.trim() : '';
    if (!id || !version) {
      const error = new Error('World ruleset id and version are required');
      error.code = 'world_ruleset_missing';
      throw error;
    }
    const ruleset = this.get(id);
    if (!ruleset) {
      const error = new Error(`Unknown ruleset: ${id}`);
      error.code = 'unknown_ruleset';
      throw error;
    }
    if (String(ruleset.version) !== version) {
      const error = new Error(`Ruleset ${id} v${version} is incompatible with installed v${ruleset.version}`);
      error.code = 'ruleset_version_incompatible';
      throw error;
    }
    return ruleset;
  }

  list() {
    return [...this.rulesets.values()];
  }
}
