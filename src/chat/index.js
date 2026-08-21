import { createChatController } from './controller.js';

export * from './model.js';
export { ChatStore } from './store.js';

export function createChatSystem(options = {}) {
  return createChatController(options);
}
