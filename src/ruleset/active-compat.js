import { getActiveRuleset } from './index.js';

/**
 * Compatibility boundary for callers that predate Runtime-scoped Rulesets.
 * Production Runtime paths pass api.ruleset explicitly and do not reach here.
 */
export function getCompatibilityRuleset(explicitRuleset = null) {
  return explicitRuleset || getActiveRuleset();
}
