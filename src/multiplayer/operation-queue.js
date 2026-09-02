export function createOperationQueue({ execute, disconnectedMessage = 'Local/LAN connection closed' } = {}) {
  let active = null;
  const queued = [];

  function flush() {
    if (active || !queued.length) return;
    active = queued.shift();
    Promise.resolve().then(() => execute(active.value)).then(
      result => { const entry = active; active = null; entry.resolve(result); flush(); },
      error => { const entry = active; active = null; entry.reject(error); flush(); },
    );
  }

  return Object.freeze({
    enqueue(value) {
      return new Promise((resolve, reject) => { queued.push({ value, resolve, reject }); flush(); });
    },
    rejectAll(message = disconnectedMessage) {
      const error = message instanceof Error ? message : new Error(String(message));
      while (queued.length) queued.shift().reject(error);
    },
    get active() { return active?.value ?? null; },
    get size() { return queued.length; },
  });
}
