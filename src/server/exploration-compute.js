import { visibleFogRowsForCircle, mergeSpans, normalizeFogState } from '../vision/fog.js';
import { normalizeVisionOccluder, sphereGroundRadiusMeters, visionIgnoresOcclusion, visionOccludersForSource } from '../spatial/kernel.js';
const preparedContexts = new WeakMap();
const normalizedFogs = new WeakMap();

// The host supplies its private acceptance receipt. Public/mutable inputs keep
// the existing normalizer; only immutable normalized grids can share old spans.
// Derived results are frozen before returning and belong to this one merger.
export function createCanonicalExplorationFogMerger(isCanonicalData) {
  const acceptedFogs = new WeakMap(), acceptedParties = new WeakMap();
  const ownedFogs = new WeakMap();
  const ordinary = value => value && Object.getPrototypeOf(value) === Object.prototype;
  const sameSpans = (left, right) => left.length === right.length
    && left.every((span, index) => span[0] === right[index][0] && span[1] === right[index][1]);
  function normalizedRows(rows, bounds, frozen) {
    if (!ordinary(rows) || frozen && !Object.isFrozen(rows)) return false;
    for (const key of Reflect.ownKeys(rows)) {
      if (typeof key !== 'string') return false;
      const rowDescriptor = Object.getOwnPropertyDescriptor(rows, key);
      if (!rowDescriptor.enumerable || !Object.hasOwn(rowDescriptor, 'value')) return false;
      const spans = rowDescriptor.value;
      const row = Number(key);
      if (!Number.isSafeInteger(row) || row < 0 || String(row) !== key || row > bounds.maxRow
        || !Array.isArray(spans) || Object.getPrototypeOf(spans) !== Array.prototype
        || !spans.length || spans.length > 4096 || Reflect.ownKeys(spans).length !== spans.length + 1
        || frozen && !Object.isFrozen(spans)) return false;
      let previousEnd = -2;
      for (let index = 0; index < spans.length; index++) {
        const item = Object.getOwnPropertyDescriptor(spans, String(index));
        if (!item?.enumerable || !Object.hasOwn(item, 'value')) return false;
        const span = item.value;
        if (!Array.isArray(span) || Object.getPrototypeOf(span) !== Array.prototype || span.length !== 2
          || Reflect.ownKeys(span).length !== 3 || frozen && !Object.isFrozen(span)
          || !['0', '1'].every(key => {
            const descriptor = Object.getOwnPropertyDescriptor(span, key);
            return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
          })
          || !Number.isSafeInteger(span[0]) || !Number.isSafeInteger(span[1])
          || Object.is(span[0], -0) || Object.is(span[1], -0)
          || span[0] < 0 || span[1] < span[0] || span[0] <= previousEnd + 1
          || span[1] > bounds.maxColumn) return false;
        previousEnd = span[1];
      }
    }
    return true;
  }
  function equivalent(fog, bounds) {
    if (ownedFogs.get(fog) === bounds.key || acceptedFogs.get(fog) === bounds.key) return true;
    if (typeof isCanonicalData !== 'function' || isCanonicalData(fog) !== true
      || !ordinary(fog) || !Object.isFrozen(fog) || Object.keys(fog).length !== 3
      || fog.schemaVersion !== 1 || fog.cellSizeMeters !== 5
      || !ordinary(fog.exploredByParty) || !Object.isFrozen(fog.exploredByParty)) return false;
    for (const [id, party] of Object.entries(fog.exploredByParty)) {
      if (!id || id !== id.trim().slice(0, 80) || id === '__proto__'
        || !ordinary(party) || !Object.isFrozen(party) || Object.keys(party).length !== 1
        || !Object.hasOwn(party, 'rows')) return false;
      if (acceptedParties.get(party) !== bounds.key) {
        if (!normalizedRows(party.rows, bounds, true)) return false;
        acceptedParties.set(party, bounds.key);
      }
    }
    acceptedFogs.set(fog, bounds.key);
    return true;
  }
  function mergeRows(previous, added) {
    const result = []; let a = 0, b = 0, start = null, end = null, reusable = null;
    const flush = () => {
      if (start === null) return;
      result.push(reusable && reusable[0] === start && reusable[1] === end
        ? reusable : Object.freeze([start, end]));
      if (result.length > 4096) throw Object.assign(new Error('Fog row has too many spans'), { code: 'fog_limit' });
    };
    while (a < previous.length || b < added.length) {
      const old = a < previous.length && (b >= added.length || previous[a][0] <= added[b][0]);
      const span = old ? previous[a++] : added[b++];
      if (start === null || span[0] > end + 1) {
        flush(); start = span[0]; end = span[1]; reusable = old ? span : null;
      } else {
        end = Math.max(end, span[1]);
        if (old && span[0] === start) reusable = span;
      }
    }
    flush();
    return sameSpans(previous, result) ? previous : Object.freeze(result);
  }
  return (rawFog, partyId, addedRows, map = {}) => {
    const scale = map.metersPerUnit === undefined ? 1 : map.metersPerUnit, width = map.width, height = map.height;
    if (!Number.isFinite(scale) || scale <= 0
      || width != null && (!Number.isFinite(width) || width < 0)
      || height != null && (!Number.isFinite(height) || height < 0)
      || typeof partyId !== 'string' || !partyId || partyId !== partyId.trim().slice(0, 80)
      || partyId === '__proto__') return mergeExplorationChunkFog(rawFog, partyId, addedRows, map);
    const bounded = width != null && height != null, cellUnits = 5 / Math.max(0.000001, scale);
    const bounds = { key: `${scale}:${width ?? ''}:${height ?? ''}`,
      maxRow: bounded ? Math.ceil(height / cellUnits) - 1 : Infinity,
      maxColumn: bounded ? Math.ceil(width / cellUnits) - 1 : Infinity };
    if (!equivalent(rawFog, bounds) || !normalizedRows(addedRows || {}, bounds, false)) {
      return mergeExplorationChunkFog(rawFog, partyId, addedRows, map);
    }
    const previous = Object.hasOwn(rawFog.exploredByParty, partyId) ? rawFog.exploredByParty[partyId] : null;
    let rows = null;
    for (const [row, spans] of Object.entries(addedRows || {})) {
      const before = previous?.rows[row] || [], merged = mergeRows(before, spans);
      if (merged === before) continue;
      rows ||= { ...(previous?.rows || {}) }; rows[row] = merged;
    }
    if (!rows && previous) return rawFog;
    const party = Object.freeze({ rows: Object.freeze(rows || {}) });
    const next = Object.freeze({ ...rawFog,
      exploredByParty: Object.freeze({ ...rawFog.exploredByParty, [partyId]: party }) });
    ownedFogs.set(next, bounds.key); acceptedParties.set(party, bounds.key);
    return next;
  };
}

// Authoritative Fog and Worker spans are immutable. Normalize a new incoming
// Fog once, then copy only the changed party and rows for additive chunks.
export function mergeExplorationChunkFog(rawFog, partyId, addedRows, map = {}) {
  const bounds = `${map.metersPerUnit || 1}:${map.width ?? ''}:${map.height ?? ''}`;
  let cached = rawFog && normalizedFogs.get(rawFog);
  if (!cached || cached.bounds !== bounds) {
    cached = { bounds, fog: normalizeFogState(rawFog, map) };
    if (rawFog && typeof rawFog === 'object') normalizedFogs.set(rawFog, cached);
  }
  const fog = cached.fog, previous = fog.exploredByParty[partyId] || { rows: {} };
  const rows = { ...previous.rows };
  for (const [row, spans] of Object.entries(addedRows || {})) rows[row] = mergeSpans([...(rows[row] || []), ...spans]);
  const next = { ...fog, exploredByParty: { ...fog.exploredByParty, [partyId]: { ...previous, rows } } };
  normalizedFogs.set(next, { bounds, fog: next });
  return next;
}

function sampleAt(job, cursor, metersPerUnit) {
  if (job.path.length === 1) return job.path[0];
  for (let index = 1; index < job.path.length; index++) {
    const from = job.path[index - 1], to = job.path[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * metersPerUnit / 2.5));
    if (cursor <= steps) {
      const ratio = cursor / steps;
      return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio,
        elevationMeters: from.elevationMeters + (to.elevationMeters - from.elevationMeters) * ratio };
    }
    cursor -= steps + 1;
  }
  return job.path.at(-1);
}

export function computeExplorationChunk({ job, context, exploredRows = {}, budgetMs = 8 }) {
  const started = performance.now(), map = context.map;
  let prepared = preparedContexts.get(context);
  if (!prepared) { prepared = Object.freeze((context.occluders || []).map(normalizeVisionOccluder).filter(Boolean)); preparedContexts.set(context, prepared); }
  const rows = {}, known = { ...exploredRows };
  let cursor = job.cursor;
  do {
    const point = sampleAt(job, cursor, map.metersPerUnit || 1);
    const source = { ...point, tokenId: job.tokenId, senses: job.senses, allowHostExemption: true };
    const circle = { ...point, radiusMeters: sphereGroundRadiusMeters(job.vagueRangeMeters, point.elevationMeters) ?? 0 };
    const visible = visibleFogRowsForCircle(circle, map, { occluders: visionIgnoresOcclusion(source) ? []
      : visionOccludersForSource(source, prepared, map.metersPerUnit || 1),
        sourceElevationMeters: point.elevationMeters, exploredRows: known });
    for (const [row, spans] of Object.entries(visible)) {
      rows[row] = mergeSpans([...(rows[row] || []), ...spans]);
      known[row] = mergeSpans([...(known[row] || []), ...spans]);
    }
    cursor++;
  } while (cursor < job.totalSamples && performance.now() - started < budgetMs);
  return { id: job.id, worldEpoch: job.worldEpoch, epoch: job.epoch, fromCursor: job.cursor, cursor, rows };
}
