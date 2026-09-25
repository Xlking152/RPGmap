import { exploreFogVisibleCircle, exploreFogVisibleSweep, exploreFogCircle, exploreFogSweep, visibleFogRowsForCircle } from './fog.js';
import { perceptionLevelAtPoint } from '../spatial/kernel.js';

self.onmessage = ({ data: { id, input } }) => {
  try {
    if (input.kind === 'visibility') {
      const { source, map, occluders, lights, ignoresOcclusion } = input;
      const values = (range, precise) => Object.entries(visibleFogRowsForCircle({ x: source.x, y: source.y, radiusMeters: range }, map, {
        sourceElevationMeters: source.elevationMeters,
        occluders: ignoresOcclusion ? [] : occluders,
        predicate: precise ? target => perceptionLevelAtPoint({ vision: source, target, ambient: source.lighting,
          lights, occluders, metersPerUnit: map.metersPerUnit, lineOfSightEnabled: false }) === 'precise' : null,
      }));
      const preciseRange = source.preciseGroundRangeMeters ?? source.preciseRangeMeters ?? source.rangeMeters;
      const vagueRange = source.vagueGroundRangeMeters ?? source.vagueRangeMeters ?? source.rangeMeters;
      self.postMessage({ id, result: { precise: values(preciseRange, true), vague: values(vagueRange, false) } });
      return;
    }
    const { partyId, payload, map, occluders, lineOfSightEnabled } = input;
    const result = payload.from && payload.to
      ? (lineOfSightEnabled ? exploreFogVisibleSweep : exploreFogSweep)({}, partyId, payload.from, payload.to, payload.radiusMeters, map, { occluders })
      : (lineOfSightEnabled ? exploreFogVisibleCircle : exploreFogCircle)({}, partyId, payload, map, { occluders, sourceElevationMeters: payload.elevationMeters || 0 });
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
