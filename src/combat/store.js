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
      // Combat mutations are an ordinary World commit.  Re-importing the
      // whole state here wakes every runtime's state:import handler and could
      // make the just-created tracker reload stale data and disappear.
      if (typeof this.api.commitState === 'function') this.api.commitState(appState, { source: 'combat', render: false });
      else this.api.importState(appState);
    } finally {
      queueMicrotask(() => { this.saving = false; });
    }
  }

  clear() {
    this.state = createEmptyCombatState();
    this.persist();
  }
}
