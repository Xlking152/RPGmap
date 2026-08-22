import {
  createInitialState,
  exportSave,
  migrateSave,
  validateAndNormalizeSave,
} from '../engine/state.js';

export function createBrowserStorage() {
  return {
    get(key) { return localStorage.getItem(key); },
    set(key, value) { localStorage.setItem(key, value); },
    remove(key) { localStorage.removeItem(key); },
  };
}

export function createMemoryStorage() {
  const values = new Map();
  return {
    get(key) { return values.get(String(key)) ?? null; },
    set(key, value) { values.set(String(key), String(value)); },
    remove(key) { values.delete(String(key)); },
  };
}

export function createStatePersistence({
  mapPackage,
  storageAdapter = createBrowserStorage(),
  getState,
  saveDelayMs = 180,
  onSaved = () => {},
  onError = () => {},
}) {
  if (!mapPackage?.id) throw new Error('持久化控制器缺少地图包 ID');
  if (typeof getState !== 'function') throw new Error('持久化控制器缺少 getState()');

  const storageKey = 'rpg-map:' + mapPackage.id + ':v1';
  let saveTimer = null;
  let blocked = false;

  function preserveRaw(raw, suffix) {
    const backupKey = storageKey + ':backup:' + suffix;
    if (!storageAdapter.get(backupKey)) storageAdapter.set(backupKey, raw);
    return backupKey;
  }

  function load() {
    let raw = null;
    try {
      raw = storageAdapter.get(storageKey);
      if (!raw) return { state: createInitialState(mapPackage), notice: null };
      const migration = migrateSave(raw, mapPackage);
      const state = validateAndNormalizeSave(migration.save, mapPackage);
      if (!migration.migrated) return { state, notice: null };

      try {
        preserveRaw(raw, 'map-' + migration.fromVersion);
        storageAdapter.set(storageKey, JSON.stringify(exportSave(state, mapPackage)));
        return {
          state,
          notice: {
            message: `旧存档已从 ${migration.fromVersion} 迁移到 ${migration.toVersion}，原始数据已备份`,
            type: 'success',
          },
        };
      } catch {
        blocked = true;
        return {
          state,
          notice: {
            message: '旧存档已在内存中迁移，但备份或写入失败；自动保存已暂停，请立即导出 JSON',
            type: 'error',
          },
        };
      }
    } catch (error) {
      console.warn('存档读取失败，使用新存档', error);
      let notice = null;
      if (raw) {
        try {
          preserveRaw(raw, 'invalid');
          notice = { message: '原存档无法读取，已保留备份并创建空白状态', type: 'error' };
        } catch {
          blocked = true;
          notice = { message: '原存档无法读取且无法备份；自动保存已暂停', type: 'error' };
        }
      }
      return { state: createInitialState(mapPackage), notice };
    }
  }

  function writeCurrentState() {
    if (blocked) return false;
    try {
      storageAdapter.set(storageKey, JSON.stringify(exportSave(getState(), mapPackage)));
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
    const serialized = JSON.stringify(exportSave(nextState, mapPackage));
    storageAdapter.set(storageKey, serialized);
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
