import { exploreFogVisibleCircle, exploreFogVisibleSweep, exploreFogCircle, exploreFogSweep } from './fog.js';
import { computeVisibilityRows } from './visibility.js';

self.onmessage = ({ data: { id, input } }) => {
  try {
    if (input.kind === 'visibility') {
      self.postMessage({ id, result: computeVisibilityRows(input) });
      return;
    }
    const { partyId, payload, map, occluders, lineOfSightEnabled } = input;
    const result = payload.from && payload.to
      ? (lineOfSightEnabled ? exploreFogVisibleSweep : exploreFogSweep)({}, partyId, payload.from, payload.to, payload.radiusMeters, map, { occluders })
      : (lineOfSightEnabled ? exploreFogVisibleCircle : exploreFogCircle)({}, partyId, payload, map, { occluders, sourceElevationMeters: payload.elevationMeters || 0 });
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
