// Legacy stores accept a synchronous standalone commit or an acknowledged
// hosted command. Their mutable view is never an independent World authority.
export function commitStoreProjection(store, nextState, options, { immediate = false } = {}) {
  if (store.commitPending) throw Object.assign(new Error('请等待当前操作确认'), { code: 'store_commit_pending' });
  const api = store.api, source = options.source;
  const reload = () => store.load({ migrateLegacy: false, dropMarkers: false });
  const failed = error => {
    reload(); store.saving = false; store.commitPending = false;
    api.emit?.('state:commit-failed', { source, error });
    throw error;
  };
  store.saving = true;
  let committed;
  try {
    committed = typeof api.commitState === 'function' ? api.commitState(nextState, options) : api.importState(nextState);
    if (committed === false) throw Object.assign(new Error('World 操作未保存'), { code: 'world_commit_failed' });
  } catch (error) { return failed(error); }
  if (committed && typeof committed.then === 'function') {
    store.commitPending = true;
    const pending = Promise.resolve(committed).then(async () => {
      if (immediate && await api.persistNow?.() === false) throw Object.assign(new Error('World 操作未保存'), { code: 'world_commit_failed' });
      reload(); store.saving = false; store.commitPending = false;
      api.emit?.('state:commit-complete', { source });
      return true;
    }).catch(failed);
    // UI callbacks from older adapters may ignore the return value. The
    // failure event still reports it; callers awaiting pending receive rejection.
    pending.catch(() => {});
    return pending;
  }
  if (immediate) api.persistNow?.();
  queueMicrotask(() => { store.saving = false; });
  return true;
}
