import { createChatController } from './controller.js';

export { createEmptyChatState, normalizeChatState, createChatMessage, appendChatMessage } from './model.js';
export { ChatStore } from './store.js';

export function createChatSystem() {
  return createChatController();
}
