const BUILT_IN_RULESETS = Object.freeze([Object.freeze({
  id: 'infinite-horror',
  title: '无限跑团',
  version: '1.1.0',
})]);

export function listBuiltInRulesets() {
  return BUILT_IN_RULESETS.map(item => ({ ...item }));
}

