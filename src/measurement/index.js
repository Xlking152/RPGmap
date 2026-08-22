import { createRulerController } from './controller.js';

export { RulerSession } from './session.js';
export { summarizeRulerPath, segmentMidpoint, formatRulerDistance } from './distance.js';
export { createRulerController } from './controller.js';

export function createMeasurementSystem() {
  return {
    register(api) {
      createRulerController().register(api);
    },
  };
}
