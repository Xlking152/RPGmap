import { open } from 'node:fs/promises';

// Serialized into the real page only for explicitly requested diagnostic runs.
// Keep native task timestamps so a trace can distinguish JS, GC and layout.
export function browserBenchmarkLongTaskRecorder(action, phase) {
  const key = '__rpgMapBenchmarkLongTasks';
  const append = (record, entries) => entries.forEach(entry => record.entries.push({
    name: entry.name, startTime: entry.startTime, duration: entry.duration,
    attribution: Array.from(entry.attribution || [], item => ({ name: item.name,
      entryType: item.entryType, startTime: item.startTime, duration: item.duration,
      containerType: item.containerType, containerSrc: item.containerSrc,
      containerId: item.containerId, containerName: item.containerName })),
  }));
  if (action === 'start') {
    if (globalThis[key]) throw new Error('A diagnostic long task observer is already active');
    const record = { phase, timeOrigin: performance.timeOrigin, startedAt: performance.now(), entries: [] };
    record.observer = new PerformanceObserver(list => append(record, list.getEntries()));
    record.observer.observe({ type: 'longtask', buffered: false });
    globalThis[key] = record;
    performance.mark(`rpgmap-diagnostic:${phase}:start`);
    return { phase, timeOrigin: record.timeOrigin, startedAt: record.startedAt };
  }
  const record = globalThis[key];
  if (!record || record.phase !== phase) throw new Error('The diagnostic long task phase does not match');
  append(record, record.observer.takeRecords());
  record.observer.disconnect();
  performance.mark(`rpgmap-diagnostic:${phase}:end`);
  delete globalThis[key];
  return { phase, timeOrigin: record.timeOrigin, startedAt: record.startedAt,
    endedAt: performance.now(), entries: record.entries };
}

export async function startBrowserDiagnosticTrace(session) {
  let resolveComplete;
  const completed = new Promise(resolve => { resolveComplete = resolve; });
  const listener = event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Tracing.tracingComplete') resolveComplete(message.params);
  };
  session.socket.addEventListener('message', listener);
  try {
    await session.send('Tracing.start', {
      categories: 'v8,v8.execute,disabled-by-default-v8.compile,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,toplevel,renderer.scheduler,blink.user_timing',
      options: 'record-as-much-as-possible', transferMode: 'ReturnAsStream',
      traceBufferSizeInKb: 65536,
    });
  } catch (error) { session.socket.removeEventListener('message', listener); throw error; }
  return async destination => {
    const file = await open(destination, 'w');
    let stream;
    try {
      await session.send('Tracing.end');
      let timer;
      const result = await Promise.race([completed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Diagnostic browser trace did not complete')), 60_000);
      })]).finally(() => clearTimeout(timer));
      stream = result.stream;
      if (result.dataLossOccurred || !stream) throw new Error('Diagnostic browser trace is incomplete');
      for (;;) {
        const chunk = await session.send('IO.read', { handle: stream, size: 1024 * 1024 });
        await file.write(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
        if (chunk.eof) break;
      }
    } finally {
      session.socket.removeEventListener('message', listener);
      if (stream) await session.send('IO.close', { handle: stream });
      await file.close();
    }
  };
}

export async function finishBrowserDiagnosticTraces(traces, destinationForIndex) {
  // One failed stream must not return control to the owner's shutdown while
  // another browser is still transferring its trace.
  const results = await Promise.allSettled(traces.map(trace => trace.stop(destinationForIndex(trace.index))));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`Diagnostic browser ${traces[index].index} trace failed`, { cause: result.reason })] : []);
  if (failures.length) throw new AggregateError(failures, 'Diagnostic browser traces are incomplete');
}
