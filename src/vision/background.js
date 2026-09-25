export function createVisionBackground() {
  if (typeof Worker === 'undefined') return null;
  let worker;
  let sequence = 0;
  const pending = new Map();
  function stop(error = new Error('视觉后台计算已取消')) {
    worker?.terminate(); worker = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  return {
    run(input) {
      if (!worker) {
        worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
          const request = pending.get(data.id);
          if (!request) return;
          pending.delete(data.id);
          if (data.error) request.reject(new Error(data.error));
          else request.resolve(data.result);
        };
        worker.onerror = () => stop(new Error('视觉后台计算失败，请重试'));
      }
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, input });
      });
    },
    dispose: stop,
  };
}
