import { createWorldStatePersistence, createRemoteWorldIsolation } from '../app/world-storage.js';
import { prepareStoredWorldWithContent, persistPreparedWorldContent } from '../app/world-upgrade.js';
import { stringifyTrustedRuntimeState, yieldRuntimeValidationFrame } from '../engine/runtime-state.js';
import { prepareWorldContentState } from './world-import.js';

// The standalone adapter retains local durability and legacy recovery semantics.
export const offlineRuntimeAdapters = Object.freeze({
  prepare: prepareStoredWorldWithContent,
  prepareImport: prepareWorldContentState,
  persistImport: persistPreparedWorldContent,
  isolation: createRemoteWorldIsolation,
  persistence(options) {
    const { documentNode, mapPackage, ruleset, storageAdapter, worldId } = options;
    return createWorldStatePersistence({ ...options,
      stringifyTrustedState: state => stringifyTrustedRuntimeState(state, { mapPackage }),
      validationYieldTask: ({ signal } = {}) => yieldRuntimeValidationFrame({ signal, view: documentNode.defaultView }),
      async saveSceneRecoveryPoint({ sceneId, reason, state, worldId: targetWorldId } = {}) {
        const id = `${Date.now()}-${crypto.randomUUID()}`;
        const key = `rpgmap:recovery:${targetWorldId || worldId || 'offline'}:${id}`;
        const record = { id, sceneId, worldId: targetWorldId || worldId, reason, createdAt: new Date().toISOString(), state };
        const serialized = JSON.stringify(record);
        storageAdapter.set(key, serialized);
        if (storageAdapter.get(key) !== serialized) throw new Error('recovery_point_verification_failed');
        return { id, sceneId, worldId: record.worldId, createdAt: record.createdAt };
      },
    });
  },
});
