import { createEmptyChatState, normalizeChatState } from './model.js';

const PREFERENCE_KEY = 'chatSystem';

export class ChatStore {
  constructor(api) {
    this.api = api;
    this.state = createEmptyChatState();
    this.saving = false;
  }

  load() {
    const appState = this.api.getState();
    this.state = normalizeChatState(appState.preferences?.[PREFERENCE_KEY]);
    return this.state;
  }

  persist() {
    const appState = this.api.getState();
    appState.preferences ||= {};
    appState.preferences[PREFERENCE_KEY] = structuredClone(this.state);
    this.saving = true;
    try {
      this.api.importState(appState);
    } finally {
      queueMicrotask(() => { this.saving = false; });
    }
    return true;
  }
}
