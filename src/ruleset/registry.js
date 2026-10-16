import { prepareRuleset } from './contract.js';

const key = (id, version) => JSON.stringify([String(id), String(version)]);

export class RulesetRegistry {
  constructor(initialRulesets = []) {
    this.rulesets = new Map();
    for (const ruleset of initialRulesets) this.register(ruleset);
  }

  register(rawRuleset) {
    const ruleset = prepareRuleset(rawRuleset);
    this.rulesets.set(key(ruleset.id, ruleset.version), ruleset);
    return ruleset;
  }

  has(id, version = null) {
    return Boolean(this.get(id, version));
  }

  get(id, version = null) {
    if (id && typeof id === 'object') return this.get(id.id, id.version);
    if (version) return this.rulesets.get(key(id, version)) || null;
    // Legacy tools may select by ID. World references always resolve an exact version.
    return [...this.rulesets.values()].filter(ruleset => ruleset.id === String(id)).at(-1) || null;
  }

  require(id, version = null) {
    const ruleset = this.get(id, version);
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
    const ruleset = this.get(id, version);
    if (!ruleset) {
      const error = new Error(`Ruleset ${id}@${version} is not installed`);
      error.code = this.has(id) ? 'ruleset_version_incompatible' : 'unknown_ruleset';
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

  unregister(reference) {
    if (!reference?.id || !reference?.version) throw new Error('Removing a ruleset requires id and version');
    return this.rulesets.delete(key(reference.id, reference.version));
  }
}
