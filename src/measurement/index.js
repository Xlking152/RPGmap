import { createRulerControllerV2 } from './controller-v2.js';

export { RulerSession } from './session.js';
export { summarizeRulerPath, segmentMidpoint, formatRulerDistance } from './distance.js';
export { createRulerControllerV2 } from './controller-v2.js';

export function createMeasurementSystem() {
  return {
    register(api) {
      createRulerControllerV2().register(api);
    },
  };
}
