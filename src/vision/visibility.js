import { visibleFogRowsForCircleSteps, circleFogRows, intersectFogRows, FOG_CELL_SIZE_METERS } from './fog.js';
import { normalizeVisionOccluder, perceptionLevelAtPoint } from '../spatial/kernel.js';
import { finishWorkSync, finishWorkAsync } from './work.js';

// Both ranges share one geometric solution. Precise perception additionally
// intersects the true 3D sphere (the historical coarse Fog circle includes its edge cell).
export function* computeVisibilityRowsSteps({ source, map, occluders = [], lights = [], ignoresOcclusion = false }) {
  const preciseRange = Number(source.preciseGroundRangeMeters ?? source.preciseRangeMeters ?? source.rangeMeters) || 0;
  const vagueRange = Number(source.vagueGroundRangeMeters ?? source.vagueRangeMeters ?? source.rangeMeters) || 0;
  const prepared = Object.isFrozen(occluders) ? occluders : Object.freeze(occluders.map(normalizeVisionOccluder).filter(Boolean));
  const circle = range => ({ x: Number(source.x), y: Number(source.y), radiusMeters: range });
  const shared = yield* visibleFogRowsForCircleSteps(circle(Math.max(preciseRange, vagueRange)), map, {
    sourceElevationMeters: Number(source.elevationMeters) || 0,
    occluders: ignoresOcclusion || source.lineOfSightEnabled === false ? [] : prepared,
  });
  const vague = vagueRange >= preciseRange ? shared : intersectFogRows(shared, circleFogRows(circle(vagueRange), map));
  const candidates = preciseRange >= vagueRange ? shared : intersectFogRows(shared, circleFogRows(circle(preciseRange), map));
  const precise = {};
  const scale = Math.max(0.000001, Number(map.metersPerUnit) || 1);
  const cell = FOG_CELL_SIZE_METERS / scale;
  const range = Math.max(0, Number(source.preciseRangeMeters ?? source.rangeMeters) || 0);
  const elevation = Number(source.elevationMeters) || 0;
  const uniform = (source.lighting || 'normal') === 'normal'
    || (source.senses?.lowLightVision === true && source.senses?.darkvision === true);
  const predicate = (column, row) => perceptionLevelAtPoint({ vision: source,
    target: { x: (column + 0.5) * cell, y: (row + 0.5) * cell, elevationMeters: 0 },
    ambient: source.lighting || 'normal', lights, occluders: prepared, metersPerUnit: scale, lineOfSightEnabled: false }) === 'precise';
  for (const [rowKey, spans] of Object.entries(candidates)) {
    const row = Number(rowKey);
    const remaining = range ** 2 - elevation ** 2 - (((row + 0.5) * cell - source.y) * scale) ** 2;
    if (remaining < 0) { yield; continue; }
    const dx = Math.sqrt(remaining) / scale;
    const min = Math.floor((Number(source.x) - dx) / cell - 0.5);
    const max = Math.ceil((Number(source.x) + dx) / cell - 0.5);
    const output = [];
    for (const [a, b] of spans) {
      let start = Math.max(a, min), end = Math.min(b, max);
      if (uniform) {
        while (start <= end && !predicate(start, row)) start++;
        while (end >= start && !predicate(end, row)) end--;
        if (end >= start) output.push([start, end]);
      } else {
        let run = null;
        for (let column = start; column <= end; column++) {
          const clear = predicate(column, row);
          if (clear && run === null) run = column;
          if (run !== null && (!clear || column === end)) { output.push([run, clear ? column : column - 1]); run = null; }
        }
      }
    }
    if (output.length) precise[rowKey] = output;
    yield;
  }
  return { precise: Object.entries(precise), vague: Object.entries(vague) };
}

export function computeVisibilityRows(input) {
  return finishWorkSync(computeVisibilityRowsSteps(input));
}

export function computeVisibilityRowsAsync(input, options = {}) {
  return finishWorkAsync(computeVisibilityRowsSteps(input), options);
}
