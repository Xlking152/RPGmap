import {
  createInitialRuntimeState,
  exportRuntimeState,
  prepareRuntimeState,
} from '../engine/runtime-state.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../world/model.js';

export function worldStateStorageKey(mapPackage) {
  if (!mapPackage?.id) throw new Error('World persistence requires MapPackage id');
  return `rpg-map:${mapPackage.id}:v1`;
}

export function readStoredWorldState({ mapPackage, storageAdapter } = {}) {
  if (!storageAdapter?.get) throw new Error('World persistence requires storage adapter');
  const storageKey = worldStateStorageKey(mapPackage);
  return Object.freeze({ storageKey, raw: storageAdapter.get(storageKey) });
}

function initialWorldState(mapPackage, ruleset) {
  const seed = createInitialRuntimeState(mapPackage, { ruleset });
  const world = createWorldV2FromRuntimeState(seed, { mapPackage, ruleset });
  return projectWorldV2ToRuntimeState(seed, world, { mapPackage, ruleset });
}

export function createWorldStatePersistence({
  mapPackage,
  ruleset,
  storageAdapter,
  getState,
  saveDelayMs = 180,
  onSaved = () => {},
  onError = () => {},
  initialLoad = null,
} = {}) {
  if (!mapPackage?.id) throw new Error('World persistence requires MapPackage id');
  if (!ruleset?.id) throw new Error('World persistence requires Ruleset');
  if (!storageAdapter?.get || !storageAdapter?.set) throw new Error('World persistence requires storage adapter');
  if (typeof getState !== 'function') throw new Error('World persistence requires getState()');

  const storageKey = worldStateStorageKey(mapPackage);
  let saveTimer = null;
  let blocked = initialLoad?.blocked === true;
  let pendingInitialLoad = initialLoad;

  function preserveRaw(raw, suffix) {
    const backupKey = `${storageKey}:backup:${suffix}`;
    if (!storageAdapter.get(backupKey)) storageAdapter.set(backupKey, raw);
    return backupKey;
  }

  function load(options = {}) {
    if (pendingInitialLoad && !Object.prototype.hasOwnProperty.call(options, 'raw')) {
      const loaded = pendingInitialLoad;
      pendingInitialLoad = null;
      return { state: loaded.state, notice: loaded.notice || null };
    }
    let raw = null;
    try {
      raw = Object.prototype.hasOwnProperty.call(options, 'raw') ? options.raw : storageAdapter.get(storageKey);
      if (!raw) return { state: initialWorldState(mapPackage, ruleset), notice: null };
      const prepared = prepareRuntimeState(raw, { mapPackage, ruleset });
      if (!prepared.migrated) return { state: prepared.state, notice: null };
      try {
        preserveRaw(raw, `legacy-${prepared.fromVersion || 'save-v2'}`);
        storageAdapter.set(storageKey, JSON.stringify(exportRuntimeState(prepared.state, { mapPackage, ruleset })));
        return {
          state: prepared.state,
          notice: {
            message: `旧存档已一次性迁移到 World V2${prepared.migratedCharacters ? `，转换 ${prepared.migratedCharacters} 个 Character` : ''}；原始数据已备份`,
            type: 'success',
          },
        };
      } catch {
        blocked = true;
        return {
          state: prepared.state,
          notice: {
            message: '旧存档已在内存中迁移，但备份或写入失败；自动保存已暂停，请立即导出 JSON',
            type: 'error',
          },
        };
      }
    } catch (error) {
      console.warn('[RPGmap] World save load failed; starting empty runtime', error);
      let notice = null;
      if (raw) {
        try {
          preserveRaw(raw, 'invalid');
          notice = { message: '原存档无法读取，已保留备份并创建空白 World', type: 'error' };
        } catch {
          blocked = true;
          notice = { message: '原存档无法读取且无法备份；自动保存已暂停', type: 'error' };
        }
      }
      return { state: initialWorldState(mapPackage, ruleset), notice };
    }
  }

  function writeCurrentState() {
    if (blocked) return false;
    try {
      storageAdapter.set(storageKey, JSON.stringify(exportRuntimeState(getState(), { mapPackage, ruleset })));
      onSaved();
      return true;
    } catch (error) {
      blocked = true;
      onError(error);
      return false;
    }
  }

  function schedule() {
    if (blocked) return false;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeCurrentState();
    }, saveDelayMs);
    return true;
  }

  function persistNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return writeCurrentState();
  }

  function replace(nextState) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    storageAdapter.set(storageKey, JSON.stringify(exportRuntimeState(nextState, { mapPackage, ruleset })));
    blocked = false;
    return true;
  }

  function cancel() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  return {
    storageKey,
    load,
    schedule,
    persistNow,
    replace,
    cancel,
    get blocked() { return blocked; },
  };
}

export function prepareStoredWorldState({ mapPackage, ruleset, storageAdapter, raw } = {}) {
  const persistence = createWorldStatePersistence({
    mapPackage,
    ruleset,
    storageAdapter,
    getState: () => null,
  });
  const loaded = persistence.load({ raw });
  return Object.freeze({ ...loaded, blocked: persistence.blocked });
}
