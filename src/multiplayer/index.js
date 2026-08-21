import { createMultiplayerController } from './controller.js';

export { multiplayerSocketUrl, isLocalHost, sanitizeMultiplayerName, normalizeRequestedRole } from './protocol.js';
export { createMultiplayerController } from './controller.js';

export function createMultiplayerSystem(options = {}) {
  return createMultiplayerController(options);
}
