// Checkpoints are maintenance on the same serial lane as authoritative writes.
// A request keeps no World reference: read the latest World only after acquiring
// that lane, and retain its WAL until the complete snapshot has been synced.
export function createWorldCheckpoint({
  getWorld,
  serialize,
  save,
  reset,
  onSnapshotFailure = () => {},
  onStorageFailure = () => {},
  quietMs = 50,
  maxDelayMs = 500,
  retryMs = 1000,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  for (const callback of [getWorld, serialize, save, reset]) {
    if (typeof callback !== 'function') throw new TypeError('World checkpoint requires getWorld, serialize, save and reset');
  }
  for (const delay of [quietMs, maxDelayMs, retryMs]) {
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError('World checkpoint delays must be finite and nonnegative');
  }

  let due = false, closed = false, failed = false, generation = 0;
  let firstRequestedAt = 0, lastActivityAt = 0, retryAt = 0;
  let timer = null, activeTask = null;

  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  const deadline = () => Math.max(retryAt, Math.min(firstRequestedAt + maxDelayMs, lastActivityAt + quietMs));
  const current = task => !closed && !failed && due && task.generation === generation && activeTask === task;
  function notify(callback, error) {
    try { callback(error); } catch { /* A reporting failure cannot resume unsafe storage writes. */ }
  }
  function retry(error, task) {
    if (!current(task)) return;
    retryAt = now() + retryMs;
    notify(onSnapshotFailure, error);
  }
  function schedule() {
    clearScheduled();
    if (closed || failed || !due || activeTask) return;
    timer = setTimer(enqueue, Math.max(0, deadline() - now()));
    timer?.unref?.();
  }
  function enqueue() {
    timer = null;
    if (closed || failed || !due || activeTask) return;
    const task = { generation, started: false };
    activeTask = task;
    let result;
    try {
      result = serialize(async () => {
        if (!current(task)) return;
        // Interaction may arrive while this maintenance is waiting for the
        // lane. Yield it again until quiet, without extending the first bound.
        if (now() < deadline()) {
          activeTask = null;
          schedule();
          return;
        }
        task.started = true;
        try {
          try { await save(getWorld()); }
          catch (error) { retry(error, task); return; }
          // Cancel/close may occur during snapshot IO. Keeping the WAL is safe;
          // never truncate for an obsolete or abandoned maintenance request.
          if (!current(task)) return;
          try { await reset(); }
          catch (error) {
            failed = true;
            clearScheduled();
            notify(onStorageFailure, error);
            return;
          }
          if (current(task)) { due = false; retryAt = 0; }
        } finally {
          if (activeTask === task) { activeTask = null; schedule(); }
        }
      });
    } catch (error) {
      retry(error, task);
      if (activeTask === task) { activeTask = null; schedule(); }
      return;
    }
    Promise.resolve(result).catch(error => {
      // A serial lane can reject before invoking us. No WAL was reset, so the
      // pending request can use the same bounded retry as a failed snapshot.
      if (!current(task)) return;
      retry(error, task);
      activeTask = null;
      schedule();
    });
  }

  return Object.freeze({
    request() {
      if (closed || failed) return false;
      const at = now();
      if (!due) { due = true; firstRequestedAt = at; retryAt = 0; }
      lastActivityAt = at;
      schedule();
      return true;
    },
    noteActivity() {
      if (closed || failed) return;
      lastActivityAt = now();
      if (due) schedule();
    },
    cancel() {
      generation++;
      due = false;
      retryAt = 0;
      activeTask = null;
      clearScheduled();
    },
    close() {
      closed = true;
      this.cancel();
    },
    stats() {
      return { due, closed, failed, scheduled: timer !== null,
        queued: Boolean(activeTask && !activeTask.started), running: activeTask?.started === true };
    },
  });
}
