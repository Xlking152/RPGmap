const MARKER_KINDS = new Set(['trap', 'target', 'area', 'note']);
const VISIBILITY_MODES = new Set(['public', 'party', 'gm', 'users']);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function userIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item ?? '').trim().slice(0, 160)).filter(Boolean))].slice(0, 64);
}

export function normalizeLightweightMarker(raw, { fallbackId = '' } = {}) {
  const source = object(raw);
  const kind = MARKER_KINDS.has(String(source.kind)) ? String(source.kind) : 'note';
  const fallbackVisibility = kind === 'trap' || source.hidden === true ? 'gm' : 'public';
  const requestedMode = String(source.visibility?.mode || '');
  const mode = VISIBILITY_MODES.has(requestedMode) ? requestedMode : fallbackVisibility;
  const marker = {
    ...clone(source),
    id: String(source.id ?? fallbackId).trim().slice(0, 160),
    kind,
    name: String(source.name || ({ trap: '陷阱', target: '目标点', area: '区域', note: '注释' })[kind]).trim().slice(0, 80),
    x: Number.isFinite(Number(source.x)) ? Number(source.x) : 0,
    y: Number.isFinite(Number(source.y)) ? Number(source.y) : 0,
    partyId: source.partyId == null || source.partyId === '' ? null : String(source.partyId).trim().slice(0, 80) || null,
    controllerUserIds: userIds(source.controllerUserIds),
    visibility: {
      ...clone(object(source.visibility)),
      mode,
      userIds: userIds(source.visibility?.userIds),
    },
  };
  delete marker.hidden;
  return marker;
}
