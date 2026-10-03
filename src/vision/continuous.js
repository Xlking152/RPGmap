import { projectVisionOcclusion } from './ground-shadow.js';
import { sphereGroundRadiusMeters } from '../spatial/kernel.js';

const lightingGeometry = new WeakMap();

// Lighting uses the complete scene geometry: x-ray and host-building exemptions
// change the observer's sight, never the paths taken by light.
function lightRegions(lights, occluders, metersPerUnit) {
  let byGeometry = lightingGeometry.get(lights);
  if (!byGeometry) { byGeometry = new WeakMap(); lightingGeometry.set(lights, byGeometry); }
  let cached = byGeometry.get(occluders);
  if (cached?.scale === metersPerUnit) return cached.regions;
  const regions = lights.filter(light => light.enabled !== false && Number(light.intensity ?? 1) > 0).map(light => {
    const fullRange = Math.max(0, Number(light.rangeMeters) || 0);
    const intensity = Math.max(0, Number(light.intensity ?? 1));
    const normalRange = intensity >= 0.5 ? fullRange * (1 - 0.5 / intensity) : 0;
    const radius = sphereGroundRadiusMeters(fullRange, light.elevationMeters) ?? 0;
    const normalRadius = sphereGroundRadiusMeters(normalRange, light.elevationMeters) ?? 0;
    const geometry = light.occlusion === 'none'
      ? { shadows: [], fallback: false }
      : projectVisionOcclusion({ source: light, radiusUnits: radius / metersPerUnit, occluders, metersPerUnit });
    return { x: Number(light.x), y: Number(light.y), radiusUnits: radius / metersPerUnit,
      normalRadiusUnits: normalRadius / metersPerUnit, shadows: geometry.shadows,
      fallback: geometry.fallback, blocked: geometry.blocked === true };
  });
  byGeometry.set(occluders, { scale: metersPerUnit, regions });
  return regions;
}

export function computeContinuousVisibility({ source, map, occluders, lights, ignoresOcclusion }) {
  const scale = Math.max(0.000001, Number(map.metersPerUnit) || 1);
  const radius = Math.max(Number(source.preciseGroundRangeMeters ?? source.preciseRangeMeters ?? source.rangeMeters) || 0,
    Number(source.vagueGroundRangeMeters ?? source.vagueRangeMeters ?? source.rangeMeters) || 0) / scale;
  const projection = projectVisionOcclusion({ source: { ...source, allowHostExemption: true }, radiusUnits: radius,
    occluders: ignoresOcclusion || source.lineOfSightEnabled === false ? [] : occluders, metersPerUnit: scale });
  const ambient = source.lighting || 'normal', senses = source.senses || {};
  let mode = 'normal';
  if (ambient === 'normal' || (senses.lowLightVision && (ambient === 'dim' || senses.darkvision))) mode = 'all';
  else if (ambient === 'dark' && senses.darkvision) mode = 'dark-and-normal';
  else if (ambient === 'dark' && senses.lowLightVision) mode = 'lit';
  return { ...projection, illumination: { mode, regions: mode === 'all' ? [] : lightRegions(lights, occluders, scale) } };
}
