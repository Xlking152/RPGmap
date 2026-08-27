import { getActiveRuleset } from '../ruleset/index.js';

function presentation() {
  return getActiveRuleset().health?.presentation || {};
}

export function healthModeOptions() {
  return presentation().modes || [];
}

export function healthOperationPresentation(operation) {
  return presentation().operations?.[operation] || { defaultType: '', types: [] };
}

export function describeHealth(state) {
  const describe = presentation().describe;
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

export function healthTypeLabel(operation, type) {
  const options = healthOperationPresentation(operation).types || [];
  return options.find(option => String(option.id) === String(type))?.label || String(type || '');
}
