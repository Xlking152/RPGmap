import { computeFogExplorationAsync } from './fog.js';
import { computeVisibilityRows } from './visibility.js';
import { normalizeVisionOccluder } from '../spatial/kernel.js';

let context = {};
self.onmessage = async ({ data: { id, input } }) => {
  try {
    if (input.map) context = { map: input.map,
      occluders: Object.freeze((input.occluders || []).map(normalizeVisionOccluder).filter(Boolean)),
      lights: Object.freeze(input.lights || []) };
    input = { ...context, ...input, occluders: context.occluders, lights: context.lights };
    if (input.kind === 'visibility') {
      self.postMessage({ id, result: computeVisibilityRows(input) });
      return;
    }
    const result = await computeFogExplorationAsync(input);
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
