import { createDamageController } from './controller.js';

export function createDamageSystem(options = {}) {
  return createDamageController(options);
}
