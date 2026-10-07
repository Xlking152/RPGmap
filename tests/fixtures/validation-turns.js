import assert from 'node:assert/strict';

export const flushValidationTurn = () => new Promise(resolve => setImmediate(resolve));

export async function withValidationClock(times, run) {
  const previous = Object.getOwnPropertyDescriptor(performance, 'now');
  let reads = 0;
  Object.defineProperty(performance, 'now', { configurable: true,
    value: () => times[Math.min(reads++, times.length - 1)] });
  try { return await run(() => reads); }
  finally {
    if (previous) Object.defineProperty(performance, 'now', previous);
    else delete performance.now;
  }
}

// Explicitly controlled task boundaries keep race tests independent of CPU
// load and avoid spending wall-clock time on browser frame timers.
export function validationTurns() {
  const pending = [];
  let calls = 0;
  function yieldTask({ signal } = {}) {
    signal?.throwIfAborted();
    calls += 1;
    return new Promise((resolve, reject) => {
      const entry = { release() { remove(); resolve(); } };
      const remove = () => {
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => { remove(); reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      pending.push(entry);
    });
  }
  async function wait() {
    await flushValidationTurn();
    assert.ok(pending.length, 'validation must be suspended at an explicit task boundary');
  }
  async function release() {
    await wait();
    pending[0].release();
    await flushValidationTurn();
  }
  async function finish(promise) {
    let done = false, result, error;
    promise.then(value => { done = true; result = value; }, reason => { done = true; error = reason; });
    for (let turn = 0; !done && turn < 40; turn += 1) {
      await flushValidationTurn();
      if (!done && pending.length) pending[0].release();
    }
    await flushValidationTurn();
    assert.ok(done, 'serial validation must drain after state changes stop');
    if (error) throw error;
    return result;
  }
  return { yieldTask, wait, release, finish, get pending() { return pending.length; }, get calls() { return calls; } };
}
