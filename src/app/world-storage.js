import {
  createInitialRuntimeState,
  exportRuntimeState,
  exportRuntimeStateAsync,
  prepareRuntimeState,
  yieldRuntimeValidationFrame,
} from '../engine/runtime-state.js';
import { WORLD_STATE_KEY, createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../world/model.js';
import { canonicalWorldStorageKey, legacyMapWorldStorageKey } from '../world/manager.js';

export function worldStateStorageKey(target) {
  if (typeof target === 'string') return canonicalWorldStorageKey(target);
  if (target?.worldId) return canonicalWorldStorageKey(target.worldId);
  if (!target?.id) throw new Error('World persistence requires World id or MapPackage id');
  // Compatibility for tests and explicit legacy migration callers. Modern
  // startup always supplies worldId and therefore never uses this map key.
  return legacyMapWorldStorageKey(target.id);
}

export function readStoredWorldState({ worldId = null, mapPackage, storageAdapter } = {}) {
  if (!storageAdapter?.get) throw new Error('World persistence requires storage adapter');
  const storageKey = worldId ? canonicalWorldStorageKey(worldId) : worldStateStorageKey(mapPackage);
  return Object.freeze({ storageKey, raw: storageAdapter.get(storageKey) });
}

function hasCanonicalWorld(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Boolean(value?.preferences?.[WORLD_STATE_KEY]);
  } catch { return false; }
}

function initialWorldState(mapPackage, ruleset, { worldId = 'world-default', worldName = '' } = {}) {
  const seed = createInitialRuntimeState(mapPackage, { ruleset });
  const world = createWorldV2FromRuntimeState(seed, { mapPackage, ruleset, worldId, worldName });
  return projectWorldV2ToRuntimeState(seed, world, { mapPackage, ruleset });
}

export function createWorldStatePersistence({
  worldId = null,
  worldName = '',
  mapPackage,
  ruleset,
  storageAdapter,
  getState,
  getStateRevision = null,
  stringifyTrustedState = null,
  validationYieldTask = yieldRuntimeValidationFrame,
  validationBudgetMs = 0,
  saveDelayMs = 180,
  onSaved = () => {},
  onError = () => {},
  initialLoad = null,
} = {}) {
  if (!mapPackage?.id) throw new Error('World persistence requires MapPackage id');
  if (!ruleset?.id) throw new Error('World persistence requires Ruleset');
  if (!storageAdapter?.get || !storageAdapter?.set) throw new Error('World persistence requires storage adapter');
  if (typeof getState !== 'function') throw new Error('World persistence requires getState()');

  const storageKey = worldId ? canonicalWorldStorageKey(worldId) : worldStateStorageKey(mapPackage);
  let saveTimer = null;
  let suspended = false;
  let blocked = initialLoad?.blocked === true;
  let pendingInitialLoad = initialLoad;
  let localExploration = null;
  let disposed = false;
  let validationGeneration = 0;
  let validationTail = Promise.resolve();
  let joinableValidation = null;
  const validationJobs = new Set();

  function invalidateValidation() {
    validationGeneration += 1;
    joinableValidation = null;
    for (const job of validationJobs) job.controller.abort();
  }
  function readLocalExploration(raw) {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    localExploration = value?._localExploration ? structuredClone(value._localExploration) : null;
  }
  function withLocalExploration(serialized) {
    return localExploration ? `${serialized.slice(0, -1)},"_localExploration":${JSON.stringify(localExploration)}}` : serialized;
  }

  function preserveRaw(raw, suffix) {
    const backupKey = `${storageKey}:backup:${suffix}`;
    if (!storageAdapter.get(backupKey)) storageAdapter.set(backupKey, raw);
    return backupKey;
  }

  function load(options = {}) {
    if (pendingInitialLoad && !Object.prototype.hasOwnProperty.call(options, 'raw')) {
      try { readLocalExploration(storageAdapter.get(storageKey)); } catch { localExploration = null; }
      const loaded = pendingInitialLoad;
      pendingInitialLoad = null;
      return { state: loaded.state, notice: loaded.notice || null };
    }
    let raw = null;
    try {
      raw = Object.prototype.hasOwnProperty.call(options, 'raw') ? options.raw : storageAdapter.get(storageKey);
      readLocalExploration(raw);
      if (!raw) return { state: initialWorldState(mapPackage, ruleset, { worldId: worldId || 'world-default', worldName }), notice: null };
      const prepared = prepareRuntimeState(raw, { mapPackage, ruleset });
      if (!prepared.migrated) return { state: prepared.state, notice: null };
      try {
        preserveRaw(raw, `legacy-${prepared.fromVersion || 'save-v2'}`);
        storageAdapter.set(storageKey, withLocalExploration(JSON.stringify(exportRuntimeState(prepared.state, { mapPackage, ruleset }))));
        return {
          state: prepared.state,
          notice: {
            message: `旧存档已完成一次性升级${prepared.migratedCharacters ? `，转换 ${prepared.migratedCharacters} 个旧角色` : ''}；原始数据已备份`,
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
      console.warn('[RPGmap] World save load failed', error);
      let notice = null;
      if (raw) {
        let preserved = false;
        try {
          preserveRaw(raw, 'invalid');
          preserved = true;
          notice = { message: '原存档无法读取，已保留备份并创建空白 World', type: 'error' };
        } catch {
          blocked = true;
          notice = { message: '原存档无法读取且无法备份；自动保存已暂停', type: 'error' };
        }
        if (preserved && hasCanonicalWorld(raw)) {
          blocked = true;
          error.recoveryRequired = true;
          throw error;
        }
      }
      return { state: initialWorldState(mapPackage, ruleset, { worldId: worldId || 'world-default', worldName }), notice };
    }
  }

  function writeCurrentState(trusted = false) {
    if (blocked || suspended || disposed) return false;
    try {
      const current = getState();
      const serialized = trusted && typeof stringifyTrustedState === 'function'
        ? stringifyTrustedState(current)
        : JSON.stringify(exportRuntimeState(current, { mapPackage, ruleset }));
      storageAdapter.set(storageKey, withLocalExploration(serialized));
      onSaved();
      return true;
    } catch (error) {
      blocked = true;
      invalidateValidation();
      onError(error);
      return false;
    }
  }

  function schedule() {
    if (blocked || suspended || disposed) return false;
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

  function persistTrustedNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return writeCurrentState(true);
  }

  async function writeValidatedState(job) {
    const signal = job.controller.signal;
    const available = () => !blocked && !suspended && !disposed
      && job.generation === validationGeneration && !signal.aborted;
    const currentRevision = () => typeof getStateRevision === 'function' ? getStateRevision() : null;
    if (!available()) return false;
    try {
      // The operation's reduction and authoritative commit remain one turn.
      // Begin its heavier save work after the browser can paint that commit.
      await validationYieldTask({ signal });
    } catch (error) {
      if (!available()) return false;
      blocked = true; invalidateValidation(); onError(error); return false;
    }
    while (available()) {
      let captured, revision, capturedReady = false, attemptedWrite = false;
      const stillCurrent = () => getState() === captured && currentRevision() === revision;
      try {
        captured = getState(); revision = currentRevision(); capturedReady = true;
        const exported = await exportRuntimeStateAsync(captured, { mapPackage, ruleset }, {
          signal, budgetMs: validationBudgetMs, yieldTask: async () => {
            signal.throwIfAborted();
            if (!stillCurrent()) throw new Error('Runtime validation snapshot superseded');
            await validationYieldTask({ signal });
            signal.throwIfAborted();
            // Fog may commit while this owned snapshot waits for paint. Stop
            // its remaining phases now; only a completely validated current
            // snapshot can reach the guarded write below.
            if (!stillCurrent()) throw new Error('Runtime validation snapshot superseded');
          },
        });
        if (!available()) return false;
        if (!stillCurrent()) continue;
        const serialized = JSON.stringify(exported);
        if (!available()) return false;
        if (!stillCurrent()) continue;
        // Queue changes can occur during validation without changing World
        // identity. Only the latest private envelope is attached at the write.
        attemptedWrite = true;
        storageAdapter.set(storageKey, withLocalExploration(serialized));
        // onSaved is synchronous and may commit another operation. Its new
        // save request must queue behind this job, rather than join its ACK.
        if (joinableValidation === job) joinableValidation = null;
        onSaved();
        return true;
      } catch (error) {
        // A storage or notification failure after starting the write is not a
        // stale validation result: its durability is uncertain and must block.
        if (attemptedWrite) { blocked = true; invalidateValidation(); onError(error); return false; }
        if (!available()) return false;
        // An obsolete snapshot's failure cannot stop a newer valid World.
        if (capturedReady) {
          try { if (!stillCurrent()) continue; }
          catch (readError) { error = readError; }
        }
        blocked = true; invalidateValidation(); onError(error); return false;
      }
    }
    return false;
  }

  function persistValidatedAsync() {
    if (blocked || suspended || disposed) return Promise.resolve(false);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (joinableValidation?.generation === validationGeneration) return joinableValidation.promise;
    const job = { generation: validationGeneration, controller: new AbortController(), promise: null };
    validationJobs.add(job);
    joinableValidation = job;
    job.promise = validationTail.then(() => writeValidatedState(job));
    // One failure never leaves the serial chain rejected; the failing caller
    // still observes its result while a later explicit recovery can write.
    validationTail = job.promise.catch(() => false);
    job.promise.finally(() => {
      validationJobs.delete(job);
      if (joinableValidation === job) joinableValidation = null;
    }).catch(() => {});
    return job.promise;
  }

  function replace(nextState) {
    if (suspended) throw Object.assign(new Error('联机投影不能覆盖离线 World 存档'), { code: 'world_persistence_suspended' });
    if (disposed) return false;
    invalidateValidation();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const serialized = JSON.stringify(exportRuntimeState(nextState, { mapPackage, ruleset }));
    try { storageAdapter.set(storageKey, serialized); }
    catch (error) {
      // A backend may write successfully before reporting a durability error.
      // Keep the imported record intact until explicit recovery; an old live
      // state must not overwrite it through a subsequent automatic save.
      blocked = true; invalidateValidation(); onError(error); throw error;
    }
    localExploration = null;
    blocked = false;
    return true;
  }

  function cancel() {
    invalidateValidation();
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  return {
    storageKey,
    load,
    schedule,
    persistNow,
    persistTrustedNow,
    persistValidatedAsync,
    replace,
    cancel,
    dispose() { cancel(); disposed = true; },
    suspend() { cancel(); suspended = true; },
    resume() { suspended = false; },
    getLocalExploration() { return structuredClone(localExploration); },
    setLocalExploration(value) { localExploration = structuredClone(value); },
    get blocked() { return blocked; },
    get suspended() { return suspended; },
  };
}

// Server projections remain a temporary overlay, including during reconnect.
// The detached local World and its private jobs keep one authoritative save.
export function createRemoteWorldIsolation({ persistence, getState, restoreState } = {}) {
  let localState = null, active = false;
  return {
    enter() {
      if (active) return false;
      persistence.cancel();
      const saved = persistence.persistNow();
      localState = structuredClone(getState());
      active = true;
      persistence.suspend();
      return saved;
    },
    updateConnection({ connected = false, retainsServerState = false } = {}) {
      if (connected || retainsServerState) { this.enter(); return false; }
      if (!active) return false;
      // Restore before resuming persistence or delivering events that can
      // restart the saved exploration queue.
      restoreState(localState);
      localState = null;
      active = false;
      persistence.resume();
      return true;
    },
    get active() { return active; },
  };
}

export function prepareStoredWorldState({ worldId = null, worldName = '', mapPackage, ruleset, storageAdapter, raw } = {}) {
  const persistence = createWorldStatePersistence({
    worldId,
    worldName,
    mapPackage,
    ruleset,
    storageAdapter,
    getState: () => null,
  });
  const loaded = persistence.load({ raw });
  return Object.freeze({ ...loaded, blocked: persistence.blocked });
}
