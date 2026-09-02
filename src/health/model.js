function presentation(ruleset) {
  return ruleset?.health?.presentation || {};
}

function compactHealthSummary(state, view) {
  if (view?.compactSummary === false) return '';
  if (typeof view?.compactSummary === 'string') return view.compactSummary;
  const segments = Array.isArray(view?.segments) ? view.segments : [];
  const current = Number(state?.current);
  const max = Number(state?.max);
  if (segments.length > 1 || !Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return '';
  return `${Math.max(0, current)}/${Math.max(0, max)}`;
}

function normalizeHealthView(state, view) {
  const source = view && typeof view === 'object' ? view : {};
  return {
    ...source,
    compactSummary: compactHealthSummary(state, source),
  };
}

export function healthModeOptions({ ruleset } = {}) {
  return presentation(ruleset).modes || [];
}

export function healthOperationPresentation(operation, { ruleset } = {}) {
  return presentation(ruleset).operations?.[operation] || { defaultType: '', types: [] };
}

export function describeHealth(state, { ruleset } = {}) {
  const describe = presentation(ruleset).describe;
  if (typeof describe === 'function') return normalizeHealthView(state, describe(state));
  const current = Number(state?.current) || 0;
  const max = Math.max(0, Number(state?.max) || 0);
  return normalizeHealthView(state, {
    summary: state ? `${current} / ${max}` : '—',
    status: String(state?.status || ''),
    danger: false,
    title: '生命系统',
    help: '',
    segments: state ? [{ id: 'current', label: '当前', value: current, color: '#4b9f69' }] : [],
    fields: [],
  });
}

export function healthTypeLabel(operation, type, { ruleset } = {}) {
  const options = healthOperationPresentation(operation, { ruleset }).types || [];
  return options.find(option => String(option.id) === String(type))?.label || String(type || '');
}
