import { createEmptyCombatState, normalizeCombatState } from './model.js';

const PREFERENCE_KEY = 'combatSystem';

export class CombatStore {
  constructor(api) {
    this.api = api;
    this.state = createEmptyCombatState();
    this.saving = false;
  }

  load() {
    const appState = this.api.getState();
    this.state = normalizeCombatState(appState.preferences?.[PREFERENCE_KEY]);
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
  }

  clear() {
    this.state = createEmptyCombatState();
    this.persist();
  }
}
