import { visibleFogRowsForCircle, mergeSpans, normalizeFogState } from '../vision/fog.js';
import { normalizeVisionOccluder, sphereGroundRadiusMeters, visionIgnoresOcclusion, visionOccludersForSource } from '../spatial/kernel.js';
const preparedContexts = new WeakMap();
const normalizedFogs = new WeakMap();

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
