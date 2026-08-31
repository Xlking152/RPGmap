export const FOG_SCHEMA_VERSION = 1;
export const FOG_CELL_SIZE_METERS = 5;

const MAX_ROW_SPANS = 4096;
const MAX_UNBOUNDED_FOG_RADIUS_METERS = 10000;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mapScale(map = {}) {
  return Math.max(0.000001, finite(map.metersPerUnit, 1));
}

function effectiveRadiusMeters(radiusMeters, map = {}) {
  const requested = Math.max(0, finite(radiusMeters));
  const width = Number(map.width);
  const height = Number(map.height);
  if (Number.isFinite(width) && width >= 0 && Number.isFinite(height) && height >= 0) {
    return Math.min(requested, Math.hypot(width, height) * mapScale(map));
  }
  return Math.min(requested, MAX_UNBOUNDED_FOG_RADIUS_METERS);
}

function normalizeSpan(raw) {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const rawStart = Math.floor(finite(raw[0], -1));
  const rawEnd = Math.floor(finite(raw[1], -1));
  if (rawStart < 0 || rawEnd < rawStart) return null;
  return [rawStart, rawEnd];
}

function mergeSpans(spans = []) {
  const ordered = spans.map(normalizeSpan).filter(Boolean).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (!previous || span[0] > previous[1] + 1) merged.push([...span]);
    else previous[1] = Math.max(previous[1], span[1]);
    if (merged.length > MAX_ROW_SPANS) throw Object.assign(new Error('Fog row has too many spans'), { code: 'fog_limit' });
  }
  return merged;
}

function normalizeRows(raw) {
  const rows = {};
  for (const [rowKey, value] of Object.entries(object(raw))) {
    const row = Number(rowKey);
    if (!Number.isSafeInteger(row) || row < 0) continue;
    const spans = mergeSpans(Array.isArray(value) ? value : []);
    if (spans.length) rows[String(row)] = spans;
  }
  return rows;
}

export function normalizeFogState(raw = {}) {
  const source = object(raw);
  const exploredByParty = {};
  for (const [rawPartyId, record] of Object.entries(object(source.exploredByParty))) {
    const partyId = String(rawPartyId).trim().slice(0, 80);
    if (!partyId) continue;
    exploredByParty[partyId] = {
      ...clone(object(record)),
      rows: normalizeRows(record?.rows),
    };
  }
  return {
    ...clone(source),
    schemaVersion: FOG_SCHEMA_VERSION,
    cellSizeMeters: FOG_CELL_SIZE_METERS,
    exploredByParty,
  };
}

function partyRows(fog, partyId) {
  const id = String(partyId ?? '').trim().slice(0, 80);
  if (!id) throw Object.assign(new Error('Fog operation requires partyId'), { code: 'fog_party_required' });
  fog.exploredByParty[id] ||= { rows: {} };
  fog.exploredByParty[id].rows ||= {};
  return fog.exploredByParty[id].rows;
}

function addSpan(rows, row, start, end) {
  rows[String(row)] = mergeSpans([...(rows[String(row)] || []), [start, end]]);
}

function removeSpan(rows, row, start, end) {
  const next = [];
  for (const [left, right] of rows[String(row)] || []) {
    if (right < start || left > end) next.push([left, right]);
    else {
      if (left < start) next.push([left, start - 1]);
      if (right > end) next.push([end + 1, right]);
    }
  }
  if (next.length) rows[String(row)] = next;
  else delete rows[String(row)];
}

function rasterCircle(rows, circle, mode, map = {}) {
  const metersPerUnit = mapScale(map);
  const cellUnits = FOG_CELL_SIZE_METERS / metersPerUnit;
  const cx = finite(circle?.x);
  const cy = finite(circle?.y);
  const radiusUnits = effectiveRadiusMeters(circle?.radiusMeters, map) / metersPerUnit;
  const width = Number.isFinite(Number(map.width)) ? Math.max(0, Number(map.width)) : Infinity;
  const height = Number.isFinite(Number(map.height)) ? Math.max(0, Number(map.height)) : Infinity;
  const minRow = Math.max(0, Math.floor((cy - radiusUnits) / cellUnits));
  const maxRow = Math.min(Math.ceil(height / cellUnits) - 1, Math.floor((cy + radiusUnits) / cellUnits));
  const maxColumn = Math.ceil(width / cellUnits) - 1;
  for (let row = minRow; row <= maxRow; row += 1) {
    const y = (row + 0.5) * cellUnits;
    const remaining = radiusUnits ** 2 - (y - cy) ** 2;
    if (remaining < 0) continue;
    const dx = Math.sqrt(remaining);
    const start = Math.max(0, Math.floor((cx - dx) / cellUnits));
    const end = Math.min(maxColumn, Math.floor((cx + dx) / cellUnits));
    if (end < start) continue;
    if (mode === 'remove') removeSpan(rows, row, start, end);
    else addSpan(rows, row, start, end);
  }
}

export function exploreFogCircle(rawFog, partyId, circle, map = {}) {
  const fog = normalizeFogState(rawFog);
  rasterCircle(partyRows(fog, partyId), circle, 'add', map);
  return fog;
}

export function exploreFogSweep(rawFog, partyId, from, to, radiusMeters, map = {}) {
  const fog = normalizeFogState(rawFog);
  const rows = partyRows(fog, partyId);
  const metersPerUnit = mapScale(map);
  const distanceMeters = Math.hypot(finite(to?.x) - finite(from?.x), finite(to?.y) - finite(from?.y)) * metersPerUnit;
  const steps = Math.max(1, Math.ceil(distanceMeters / (FOG_CELL_SIZE_METERS / 2)));
  const safeRadiusMeters = effectiveRadiusMeters(radiusMeters, map);
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    rasterCircle(rows, {
      x: finite(from?.x) + (finite(to?.x) - finite(from?.x)) * ratio,
      y: finite(from?.y) + (finite(to?.y) - finite(from?.y)) * ratio,
      radiusMeters: safeRadiusMeters,
    }, 'add', map);
  }
  return fog;
}

export function hideFogCircle(rawFog, partyId, circle, map = {}) {
  const fog = normalizeFogState(rawFog);
  rasterCircle(partyRows(fog, partyId), circle, 'remove', map);
  return fog;
}

export function resetFogParty(rawFog, partyId) {
  const fog = normalizeFogState(rawFog);
  delete fog.exploredByParty[String(partyId ?? '').trim()];
  return fog;
}

export function isFogCellExplored(rawFog, partyId, point, { metersPerUnit = 1 } = {}) {
  const fog = normalizeFogState(rawFog);
  const rows = fog.exploredByParty[String(partyId ?? '')]?.rows || {};
  const cellUnits = FOG_CELL_SIZE_METERS / Math.max(0.000001, finite(metersPerUnit, 1));
  const row = Math.max(0, Math.floor(finite(point?.y) / cellUnits));
  const column = Math.max(0, Math.floor(finite(point?.x) / cellUnits));
  return (rows[String(row)] || []).some(([start, end]) => column >= start && column <= end);
}
