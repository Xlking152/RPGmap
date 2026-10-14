import { appendMessage, clearMessages, createEmptyChatState, normalizeChatState } from './model.js';
import { commitStoreProjection } from '../adapters/store-commit.js';

const PREFERENCE_KEY = 'chatSystem';

export class ChatStore {
  constructor(api) {
    this.api = api;
    this.state = createEmptyChatState();
    this.saving = false;
  }

  load() {
    this.state = normalizeChatState(this.api.getState().preferences?.[PREFERENCE_KEY]);
    return this.state;
  }

  persist() {
    const appState = this.api.getState();
    appState.preferences ||= {};
    appState.preferences[PREFERENCE_KEY] = structuredClone(this.state);
    return commitStoreProjection(this, appState, { source: 'chat', render: false });
  }

  append(message) {
    const item = appendMessage(this.state, message);
    const committed = this.persist();
    return committed && typeof committed.then === 'function' ? committed.then(() => item) : item;
  }

  clear() {
    clearMessages(this.state);
    return this.persist();
  }
}
