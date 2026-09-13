import { prepareRuntimeState, exportRuntimeState } from '../engine/runtime-state.js';
import { prepareStoredWorldState, worldStateStorageKey } from './world-storage.js';
import { prepareInlineImageMigration } from '../content/migration.js';
import { createIndexedWorldUpgrade } from '../content/indexed-upgrade.js';

export async function prepareWorldContentState(raw, context) {
  const content = await prepareInlineImageMigration(raw);
  const prepared = prepareRuntimeState(content.state, context);
  return { ...prepared, migrated: prepared.migrated || content.migrated, records: content.records };
}

export async function persistPreparedWorldContent({ state, records = [], inputRaw, beforeRaw, ...options }) {
  const storageKey = worldStateStorageKey(options.worldId ? { worldId: options.worldId } : options.mapPackage);
  const upgrade = createIndexedWorldUpgrade({ ...options, storageKey });
  const afterRaw = JSON.stringify(exportRuntimeState(state, options));
  try {
    await upgrade.commit({ beforeRaw, afterRaw, inputRaw: typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw), records });
  } catch (error) {
    // Recovery failures are deliberately fatal; never replace a changed World
    // or continue automatic writes while a pending upgrade is unresolved.
    try { await upgrade.recover(); }
    catch (recoveryError) { recoveryError.recoveryRequired = true; throw recoveryError; }
    throw error;
  }
}

export async function prepareStoredWorldWithContent(options) {
  const { worldId, mapPackage, storageAdapter } = options;
  const storageKey = worldStateStorageKey(worldId ? { worldId } : mapPackage);
  const upgrade = createIndexedWorldUpgrade({ ...options, storageKey });
  const recovered = await upgrade.recover();
  const beforeRaw = storageAdapter.get(storageKey);
  const raw = recovered ? beforeRaw : beforeRaw ?? options.raw;
  if (!raw) return prepareStoredWorldState({ ...options, raw });
  const prepared = await prepareWorldContentState(raw, options);
  if (prepared.migrated) await persistPreparedWorldContent({ ...options, ...prepared, inputRaw: raw, beforeRaw });
  return Object.freeze({ state: prepared.state, blocked: false, notice: prepared.migrated
    ? { message: '旧存档和图片已完成升级；原始存档及依赖内容已完整备份', type: 'success' }
    : null });
}
