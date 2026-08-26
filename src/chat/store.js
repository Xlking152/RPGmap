import { appendMessage, clearMessages, createEmptyChatState, normalizeChatState } from './model.js';

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
    this.saving = true;
    try {
      // Chat is a small World mutation, not a save-file import. Keeping it on
      // the commit path also prevents it from reverting a fresh combat setup.
      if (typeof this.api.commitState === 'function') this.api.commitState(appState, { source: 'chat', render: false });
      else this.api.importState(appState);
    }
    finally { queueMicrotask(() => { this.saving = false; }); }
    return true;
  }

  append(message) {
    const item = appendMessage(this.state, message);
    this.persist();
    return item;
  }

  clear() {
    clearMessages(this.state);
    this.persist();
  }
}
