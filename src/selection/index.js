import { createSelectionController } from './controller.js';
import { TokenSelectionState } from './state.js';

export { TokenSelectionState, tokenIdsInBounds } from './state.js';

export function createSelectionSystem() {
  const state = new TokenSelectionState();
  const listeners = new Set();
  let registered = false;

  const notify = snapshot => {
    for (const listener of listeners) listener(snapshot);
  };

  const system = {
    register(api) {
      if (registered) return;
      registered = true;
      api.selection = system;
      createSelectionController(state, notify).register(api);
    },
    getSelectedTokenIds() {
      return state.snapshot().ids;
    },
    getPrimaryTokenId() {
      return state.primaryId;
    },
    replace(ids, primaryId = null) {
      const snapshot = state.replace(ids, primaryId);
      notify({ ...snapshot, reason: 'external-replace' });
      return snapshot;
    },
    add(ids, primaryId = null) {
      const snapshot = state.add(ids, primaryId);
      notify({ ...snapshot, reason: 'external-add' });
      return snapshot;
    },
    remove(ids) {
      const snapshot = state.remove(ids);
      notify({ ...snapshot, reason: 'external-remove' });
      return snapshot;
    },
    clear() {
      const snapshot = state.clear();
      notify({ ...snapshot, reason: 'external-clear' });
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return system;
}
