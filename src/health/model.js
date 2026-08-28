import { getCompatibilityRuleset } from '../ruleset/active-compat.js';

function presentation(ruleset = getCompatibilityRuleset()) {
  return ruleset?.health?.presentation || {};
}

export function healthModeOptions({ ruleset = getCompatibilityRuleset() } = {}) {
  return presentation(ruleset).modes || [];
}

export function healthOperationPresentation(operation, { ruleset = getCompatibilityRuleset() } = {}) {
  return presentation(ruleset).operations?.[operation] || { defaultType: '', types: [] };
}

export function describeHealth(state, { ruleset = getCompatibilityRuleset() } = {}) {
  const describe = presentation(ruleset).describe;
  if (typeof describe === 'function') return describe(state);
  const current = Number(state?.current) || 0;
  const max = Math.max(0, Number(state?.max) || 0);
  return {
    summary: state ? `${current} / ${max}` : '—',
    status: String(state?.status || ''),
    danger: false,
    hideBaseResource: false,
    title: '生命系统',
    help: '',
    segments: state ? [{ id: 'current', label: '当前', value: current, color: '#4b9f69' }] : [],
    fields: [],
  };
}

export function healthTypeLabel(operation, type, { ruleset = getCompatibilityRuleset() } = {}) {
  const options = healthOperationPresentation(operation, { ruleset }).types || [];
  return options.find(option => String(option.id) === String(type))?.label || String(type || '');
}
