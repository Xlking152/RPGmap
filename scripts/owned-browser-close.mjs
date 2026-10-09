/** Settle outstanding CDP commands when their transport or owned browser ends. */
export function rejectPendingCdp(pending, reason) {
  if (!pending) return;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    clearTimeout(task.timeout);
    task.reject(error);
  }
  pending.clear();
}

/** Browser.close may disconnect before its ACK; only our child's normal exit proves shutdown. */
export function closeOwnedBrowser({ process: child, send, pending, label = 'Browser', timeoutMs = 5000 }) {
  if (!child || typeof child.once !== 'function' || typeof child.removeListener !== 'function') {
    return Promise.reject(new TypeError(`${label} shutdown requires its owned ChildProcess`));
  }
  return new Promise((resolve, reject) => {
    let timer, settled = false, commandError;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', exited);
      child.removeListener('error', failed);
      rejectPendingCdp(pending, error || new Error(`${label} process closed`));
      if (error) reject(error); else resolve(result);
    };
    const exited = (code, signal) => {
      if (code === 0 && signal == null) finish(null, { exitCode: code, signalCode: signal ?? null });
      else finish(new Error(`${label} shutdown exited abnormally: code=${code}, signal=${signal ?? 'none'}`));
    };
    const failed = error => finish(new Error(`${label} shutdown process failed: ${error.message}`, { cause: error }));
    // Subscribe before sending: Chromium can exit synchronously with CDP teardown.
    child.once('exit', exited);
    child.once('error', failed);
    if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode != null) {
      exited(child.exitCode, child.signalCode);
      return;
    }
    const waitMs = Math.min(30_000, Math.max(1, Number(timeoutMs) || 5000));
    timer = setTimeout(() => finish(new Error(`${label} shutdown timed out after ${waitMs}ms`
      + (commandError ? `: ${commandError.message}` : ''), commandError ? { cause: commandError } : undefined)), waitMs);
    try {
      // A transport rejection alone is neither success nor failure: await the actual exit.
      Promise.resolve(send('Browser.close')).catch(error => { commandError = error; });
    } catch (error) { commandError = error; }
  });
}
