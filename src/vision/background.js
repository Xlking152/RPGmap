export function createVisionBackground({ diagnostics = null } = {}) {
  if (typeof Worker === 'undefined') return null;
  let worker;
  let sequence = 0;
  let disposed = false;
  let contextKey = null;
  const pending = new Map();
  function stop(error = new Error('视觉后台计算已取消')) {
    worker?.terminate(); worker = null;
    contextKey = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  return {
    async run(input) {
      if (disposed) throw new Error('视觉后台计算已取消');
      if (!worker) {
        worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
          const request = pending.get(data.id);
          if (!request) return;
          pending.delete(data.id);
          diagnostics?.record('vision.worker', performance.now() - request.started);
          if (data.error) request.reject(new Error(data.error));
          else request.resolve(data.result);
        };
        worker.onerror = () => stop(new Error('视觉后台计算失败，请重试'));
        worker.onmessageerror = () => stop(new Error('视觉后台结果读取失败，请重试'));
      }
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject, started: performance.now() });
        const nextKey = input.contextVersion == null ? null : `${input.contextVersion}:${input.lightVersion || 0}:${input.lineOfSightEnabled}:${input.ignoresOcclusion}`;
        const message = { id, input };
        if (nextKey !== null && contextKey === nextKey) {
          const { occluders, lights, map, ...job } = input;
          message.input = job;
        }
        try {
          if (diagnostics?.enabled) {
            diagnostics.record('vision.transferBytes', new TextEncoder().encode(JSON.stringify(message)).length);
            diagnostics.record('vision.queue', pending.size);
          }
          worker.postMessage(message); contextKey = nextKey;
        }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    cancel: stop,
    dispose() { disposed = true; stop(); },
  };
}
