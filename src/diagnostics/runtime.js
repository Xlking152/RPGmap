const STORAGE_KEY = 'rpgmap.diagnostics.enabled';
const METRICS = new Set(['frame', 'input.frame', 'longtask', 'network.confirm', 'network.requestBytes', 'network.responseBytes', 'documents.apply', 'sheet.dom', 'sheet.queue']);

export function createRuntimeDiagnostics({ clock = performance, windowNode = globalThis, documentNode = globalThis.document, storage = null, limit = 8192 } = {}) {
  let enabled = false;
  let frame = null;
  let observer = null;
  let previousFrame = null;
  const metrics = new Map();
  const pending = new Map();
  const inputFrames = new Set();
  const now = () => clock.now();
  function record(name, value) {
    if (!enabled || !METRICS.has(name) || !Number.isFinite(value) || value < 0) return;
    let metric = metrics.get(name);
    if (!metric) { metric = { count: 0, total: 0, max: 0, values: [] }; metrics.set(name, metric); }
    metric.count += 1; metric.total += value; metric.max = Math.max(metric.max, value);
    if (metric.values.length >= limit) metric.values.shift();
    metric.values.push(value);
  }
  function tick(timestamp) {
    if (!enabled) return;
    if (documentNode?.visibilityState === 'hidden') previousFrame = null;
    else {
      if (previousFrame !== null) record('frame', timestamp - previousFrame);
      previousFrame = timestamp;
    }
    frame = windowNode.requestAnimationFrame(tick);
  }
  function input() {
    if (!enabled || documentNode?.visibilityState === 'hidden') return;
    const started = now();
    const id = windowNode.requestAnimationFrame(() => {
      inputFrames.delete(id);
      record('input.frame', now() - started);
    });
    inputFrames.add(id);
  }
  function setEnabled(value) {
    const next = value === true;
    if (enabled === next) return;
    enabled = next;
    try { storage?.setItem(STORAGE_KEY, String(enabled)); } catch { /* Diagnostics remain session-local when storage is unavailable. */ }
    if (enabled) {
      previousFrame = null;
      frame = windowNode.requestAnimationFrame(tick);
      documentNode?.addEventListener('input', input, true);
      if (windowNode.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
        observer = new windowNode.PerformanceObserver(list => list.getEntries().forEach(entry => record('longtask', entry.duration)));
        observer.observe({ type: 'longtask', buffered: false });
      }
    } else {
      if (frame !== null) windowNode.cancelAnimationFrame(frame);
      frame = null;
      for (const id of inputFrames) windowNode.cancelAnimationFrame(id);
      inputFrames.clear(); pending.clear();
      documentNode?.removeEventListener('input', input, true);
      observer?.disconnect(); observer = null;
    }
  }
  function snapshot() {
    const summaries = Object.fromEntries([...metrics].map(([name, metric]) => {
      const sorted = [...metric.values].sort((a, b) => a - b);
      return [name, { count: metric.count, mean: metric.total / metric.count, p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)], max: metric.max, retained: sorted.length }];
    }));
    return {
      enabled, metrics: summaries,
      averageFps: summaries.frame?.mean > 0 ? 1000 / summaries.frame.mean : null,
      environment: { browser: windowNode.navigator?.userAgent || '', hardwareConcurrency: windowNode.navigator?.hardwareConcurrency || null, width: windowNode.innerWidth || null, height: windowNode.innerHeight || null, devicePixelRatio: windowNode.devicePixelRatio || 1 },
    };
  }
  const api = Object.freeze({
    get enabled() { return enabled; }, setEnabled, record, snapshot,
    reset() { metrics.clear(); pending.clear(); previousFrame = null; },
    begin(name, key) { if (enabled && METRICS.has(name)) pending.set(`${name}:${key}`, now()); },
    end(name, key) {
      const id = `${name}:${key}`;
      const started = pending.get(id);
      pending.delete(id);
      if (started !== undefined) record(name, now() - started);
    },
    measure(name, callback) {
      if (!enabled) return callback();
      const started = now();
      try { return callback(); } finally { record(name, now() - started); }
    },
    destroy() { setEnabled(false); metrics.clear(); pending.clear(); },
  });
  try { if (storage?.getItem(STORAGE_KEY) === 'true') setEnabled(true); } catch { /* Disabled by default. */ }
  return api;
}

export function createPerformanceDiagnosticsSystem() {
  return { register(api) {
    const documentNode = api.map.getContainer().ownerDocument;
    const windowNode = documentNode.defaultView;
    let storage = null;
    try { storage = windowNode.localStorage; } catch { /* Private browsing may deny local storage. */ }
    api.diagnostics = createRuntimeDiagnostics({ windowNode, documentNode, clock: windowNode.performance, storage });
    api.on('app:destroy', () => api.diagnostics.destroy());
  } };
}
