import { computeFogExplorationAsync } from './fog.js';
import { computeFogExplorationDeltaAsync } from './exploration-delta.js';
import { computeVisibilityRows } from './visibility.js';
import { normalizeVisionOccluder } from '../spatial/kernel.js';

let context = {};
const active = new Map();
self.onmessage = async ({ data: { id, input, cancelIds } }) => {
  if (Array.isArray(cancelIds)) {
    for (const id of cancelIds) active.get(id)?.abort();
    return;
  }
  const controller = new AbortController();
  active.set(id, controller);
  try {
    if (input.map) context = { map: input.map,
      occluders: Object.freeze((input.occluders || []).map(normalizeVisionOccluder).filter(Boolean)),
      lights: Object.freeze(input.lights || []) };
    input = { ...context, ...input, occluders: context.occluders, lights: context.lights };
    if (input.kind === 'visibility') {
      self.postMessage({ id, result: computeVisibilityRows(input) });
      return;
    }
    const result = await (input.explorationDelta === true
      ? computeFogExplorationDeltaAsync(input, { signal: controller.signal })
      : computeFogExplorationAsync(input, {}, { signal: controller.signal }));
    if (!controller.signal.aborted) self.postMessage({ id, result });
  } catch (error) { if (!controller.signal.aborted) self.postMessage({ id, error: error.message }); }
  finally { active.delete(id); }
};
