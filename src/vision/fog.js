export const FOG_SCHEMA_VERSION = 1;
export const FOG_CELL_SIZE_METERS = 5;

const MAX_ROW_SPANS = 4096;
// This fallback is used only when no trusted map dimensions are available.
// Known maps are bounded by their actual rectangle and therefore have no
// Ruleset-facing sight-radius ceiling.
const MAX_UNBOUNDED_FOG_RADIUS_METERS = 50000;

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

function optionalNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function mapScale(map = {}) {
  return Math.max(0.000001, finite(map.metersPerUnit, 1));
}

function mapGrid(map = {}) {
  const metersPerUnit = mapScale(map);
  const cellUnits = FOG_CELL_SIZE_METERS / metersPerUnit;
  const width = optionalNonNegative(map.width);
  const height = optionalNonNegative(map.height);
  const bounded = width !== null && height !== null;
  return {
    metersPerUnit,
    cellUnits,
    width,
    height,
    bounded,
    maxRow: bounded ? Math.ceil(height / cellUnits) - 1 : Infinity,
    maxColumn: bounded ? Math.ceil(width / cellUnits) - 1 : Infinity,
  };
}

function farthestMapCornerUnits(point, grid) {
  if (!grid.bounded) return Infinity;
  const x = finite(point?.x);
  const y = finite(point?.y);
  return Math.max(
    Math.hypot(x, y),
    Math.hypot(x - grid.width, y),
    Math.hypot(x, y - grid.height),
    Math.hypot(x - grid.width, y - grid.height),
  );
}

function effectiveRadiusMeters(radiusMeters, map = {}, center = null) {
  const requested = Math.max(0, finite(radiusMeters));
  const grid = mapGrid(map);
  if (grid.bounded) {
    const usefulUnits = center
      ? farthestMapCornerUnits(center, grid)
      : Math.hypot(grid.width, grid.height);
    return Math.min(requested, usefulUnits * grid.metersPerUnit);
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

function normalizeRows(raw, map = {}) {
  const rows = {};
  const grid = mapGrid(map);
  for (const [rowKey, value] of Object.entries(object(raw))) {
    const row = Number(rowKey);
    if (!Number.isSafeInteger(row) || row < 0) continue;
    if (grid.bounded && (grid.maxRow < 0 || row > grid.maxRow)) continue;
    let spans = mergeSpans(Array.isArray(value) ? value : []);
    if (grid.bounded) {
      if (grid.maxColumn < 0) continue;
      spans = mergeSpans(spans.flatMap(([start, end]) => {
        const clippedStart = Math.max(0, start);
        const clippedEnd = Math.min(grid.maxColumn, end);
        return clippedEnd >= clippedStart ? [[clippedStart, clippedEnd]] : [];
      }));
    }
    if (spans.length) rows[String(row)] = spans;
  }
  return rows;
}

export function normalizeFogState(raw = {}, map = {}) {
  const source = object(raw);
  const exploredByParty = {};
  for (const [rawPartyId, record] of Object.entries(object(source.exploredByParty))) {
    const partyId = String(rawPartyId).trim().slice(0, 80);
    if (!partyId) continue;
    exploredByParty[partyId] = {
      ...clone(object(record)),
      rows: normalizeRows(record?.rows, map),
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

function applyFullMap(rows, mode, grid) {
  if (!grid.bounded || grid.maxRow < 0 || grid.maxColumn < 0) return;
  for (let row = 0; row <= grid.maxRow; row += 1) {
    if (mode === 'remove') removeSpan(rows, row, 0, grid.maxColumn);
    else addSpan(rows, row, 0, grid.maxColumn);
  }
}

function circleCoversMap(circle, grid) {
  if (!grid.bounded || grid.maxRow < 0 || grid.maxColumn < 0) return false;
  const radiusUnits = Math.max(0, finite(circle?.radiusMeters)) / grid.metersPerUnit;
  return radiusUnits >= farthestMapCornerUnits(circle, grid);
}

function rasterCircle(rows, circle, mode, map = {}) {
  const grid = mapGrid(map);
  if (grid.bounded && (grid.maxRow < 0 || grid.maxColumn < 0)) return;
  if (circleCoversMap(circle, grid)) {
    applyFullMap(rows, mode, grid);
    return;
  }

  const cx = finite(circle?.x);
  const cy = finite(circle?.y);
  const radiusUnits = effectiveRadiusMeters(circle?.radiusMeters, map, circle) / grid.metersPerUnit;
  const minRow = Math.max(0, Math.floor((cy - radiusUnits) / grid.cellUnits));
  const maxRow = Math.min(grid.maxRow, Math.floor((cy + radiusUnits) / grid.cellUnits));
  for (let row = minRow; row <= maxRow; row += 1) {
    const y = (row + 0.5) * grid.cellUnits;
    const remaining = radiusUnits ** 2 - (y - cy) ** 2;
    if (remaining < 0) continue;
    const dx = Math.sqrt(remaining);
    const start = Math.max(0, Math.floor((cx - dx) / grid.cellUnits));
    const end = Math.min(grid.maxColumn, Math.floor((cx + dx) / grid.cellUnits));
    if (end < start) continue;
    if (mode === 'remove') removeSpan(rows, row, start, end);
    else addSpan(rows, row, start, end);
  }
}

export function exploreFogCircle(rawFog, partyId, circle, map = {}) {
  const fog = normalizeFogState(rawFog, map);
  rasterCircle(partyRows(fog, partyId), circle, 'add', map);
  return fog;
}

export function exploreFogSweep(rawFog, partyId, from, to, radiusMeters, map = {}) {
  const fog = normalizeFogState(rawFog, map);
  const rows = partyRows(fog, partyId);
  const grid = mapGrid(map);
  const fromCircle = { x: finite(from?.x), y: finite(from?.y), radiusMeters };
  const toCircle = { x: finite(to?.x), y: finite(to?.y), radiusMeters };

  // If either endpoint already sees the whole map, the union of the sweep is
  // the whole map as well. Avoid thousands of redundant intermediate circles.
  if (circleCoversMap(fromCircle, grid)) {
    applyFullMap(rows, 'add', grid);
    return fog;
  }
  if (circleCoversMap(toCircle, grid)) {
    applyFullMap(rows, 'add', grid);
    return fog;
  }

  const distanceMeters = Math.hypot(finite(to?.x) - finite(from?.x), finite(to?.y) - finite(from?.y)) * grid.metersPerUnit;
  const steps = Math.max(1, Math.ceil(distanceMeters / (FOG_CELL_SIZE_METERS / 2)));
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    rasterCircle(rows, {
      x: finite(from?.x) + (finite(to?.x) - finite(from?.x)) * ratio,
      y: finite(from?.y) + (finite(to?.y) - finite(from?.y)) * ratio,
      radiusMeters,
    }, 'add', map);
  }
  return fog;
}

export function hideFogCircle(rawFog, partyId, circle, map = {}) {
  const fog = normalizeFogState(rawFog, map);
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
