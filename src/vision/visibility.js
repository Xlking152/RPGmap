import { visibleFogRowsForCircle } from './fog.js';
import { perceptionLevelAtPoint } from '../spatial/kernel.js';

// Shared by the Worker and synchronous fallback so lighting and LOS stay identical.
export function computeVisibilityRows({ source, map, occluders = [], lights = [], ignoresOcclusion = false }) {
  const values = (range, precise) => Object.entries(visibleFogRowsForCircle({
    x: Number(source.x), y: Number(source.y), radiusMeters: Number(range) || 0,
  }, map, {
    sourceElevationMeters: Number(source.elevationMeters) || 0,
    occluders: ignoresOcclusion || source.lineOfSightEnabled === false ? [] : occluders,
    predicate: precise ? target => perceptionLevelAtPoint({
      vision: source, target, ambient: source.lighting || 'normal',
      lights, occluders, metersPerUnit: map.metersPerUnit, lineOfSightEnabled: false,
    }) === 'precise' : null,
  }));
  return {
    precise: values(source.preciseGroundRangeMeters ?? source.preciseRangeMeters ?? source.rangeMeters, true),
    vague: values(source.vagueGroundRangeMeters ?? source.vagueRangeMeters ?? source.rangeMeters, false),
  };
}
