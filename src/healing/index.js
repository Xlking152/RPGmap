import { createHealingController } from './controller.js';

export function createHealingSystem(options = {}) {
  return createHealingController(options);
}
