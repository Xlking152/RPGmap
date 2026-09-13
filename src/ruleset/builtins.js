import { listBuiltInRulesets as listBuiltInRulesetMetadata } from './metadata.js';

function rulesetError(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function listBuiltInRulesets() {
  return listBuiltInRulesetMetadata();
}

export function resolveBuiltInRulesetReference(reference = {}) {
  const id = typeof reference?.id === 'string' ? reference.id.trim() : '';
  const version = typeof reference?.version === 'string' ? reference.version.trim() : '';
  if (!id || !version) rulesetError('World ruleset id and version are required', 'world_ruleset_missing');
  const metadata = listBuiltInRulesetMetadata().find(item => item.id === id);
  if (!metadata) rulesetError(`Unknown ruleset: ${id}`, 'unknown_ruleset');
  if (metadata.version !== version) {
    rulesetError(
      `Ruleset ${id} v${version} is incompatible with installed v${metadata.version}`,
      'ruleset_version_incompatible',
    );
  }
  return { ...metadata };
}

export async function loadBuiltInRulesetReference(reference) {
  const metadata = resolveBuiltInRulesetReference(reference);
  if (metadata.id !== 'infinite-horror') rulesetError(`Unknown ruleset: ${metadata.id}`, 'unknown_ruleset');
  const registry = await import('./index.js');
  const ruleset = registry.resolveRulesetReference(metadata);
  registry.setActiveRuleset(ruleset.id);
  return ruleset;
}
