import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { browserBenchmarkLongTaskRecorder, startBrowserDiagnosticTrace, finishBrowserDiagnosticTraces } from '../scripts/browser-benchmark-profile.mjs';

test('A diagnostic browser profile cannot run as an asserted acceptance benchmark', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../scripts/browser-performance-benchmark.mjs', import.meta.url)), '--assert'], {
      env: { ...process.env, RPGMAP_BROWSER_BENCHMARK_PROFILE_SESSION: '0', RPGMAP_BROWSER_BENCHMARK_SESSIONS: '7' },
    }), error => error.code === 1 && error.stderr.includes('Diagnostic profiles cannot be used for acceptance')
      && !error.stderr.includes('[browser-benchmark] output:'));
});

test('Diagnostic native long tasks retain real timestamps and drain pending records without accepting another phase', () => {
  let observer;
  const marks = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.pending = []; observer = this; }
    observe(options) { assert.deepEqual(options.type, 'longtask'); assert.equal(options.buffered, false); }
    takeRecords() { return this.pending.splice(0); }
    disconnect() { this.disconnected = true; }
  }
  const context = vm.createContext({ PerformanceObserver: Observer,
    performance: { timeOrigin: 1234, now: () => 456, mark: value => marks.push(value) } });
  const call = (action, phase) => vm.runInContext(`(${browserBenchmarkLongTaskRecorder.toString()})('${action}', '${phase}')`, context);
  call('start', 'normal');
  assert.throws(() => call('start', 'normal'), /already active/);
  observer.callback({ getEntries: () => [{ name: 'self', startTime: 500, duration: 136, attribution: [] }] });
  observer.pending.push({ name: 'self', startTime: 700, duration: 145, attribution: [] });
  assert.throws(() => call('stop', 'dark'), /does not match/);
  const result = JSON.parse(JSON.stringify(call('stop', 'normal')));
  assert.deepEqual(result.entries.map(entry => [entry.startTime, entry.duration]), [[500, 136], [700, 145]]);
  assert.equal(result.timeOrigin, 1234); assert.equal(observer.disconnected, true);
  assert.deepEqual(marks, ['rpgmap-diagnostic:normal:start', 'rpgmap-diagnostic:normal:end']);
  assert.throws(() => call('stop', 'normal'), /does not match/);
});

test('Diagnostic trace preserves the CDP stream and rejects data loss', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-diagnostic-trace-test-'));
  try {
    for (const dataLossOccurred of [false, true]) {
      const socket = new EventTarget();
      const calls = [];
      const session = { socket, async send(method) {
        calls.push(method);
        if (method === 'Tracing.end') socket.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ method: 'Tracing.tracingComplete', params: { stream: 'trace-stream', dataLossOccurred } }),
        }));
        if (method === 'IO.read') return { data: '{"traceEvents":[]}', eof: true };
        return {};
      } };
      const stop = await startBrowserDiagnosticTrace(session);
      const destination = path.join(temporary, `trace-${dataLossOccurred}.json`);
      if (dataLossOccurred) {
        await assert.rejects(stop(destination), /incomplete/);
        assert.equal(calls.at(-1), 'IO.close');
      }
      else {
        await stop(destination);
        assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { traceEvents: [] });
        assert.deepEqual(calls, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close']);
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('Diagnostic trace failure waits for every other owned browser stream before allowing shutdown', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let settled = false;
  const destinations = [];
  const stopped = finishBrowserDiagnosticTraces([
    { index: 0, async stop(destination) { destinations.push(destination); throw new Error('lost stream'); } },
    { index: 6, async stop(destination) { destinations.push(destination); await pending; } },
  ], index => `trace-${index}.json`).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(destinations, ['trace-0.json', 'trace-6.json']);
  release();
  await assert.rejects(stopped, error => error instanceof AggregateError
    && error.errors.length === 1 && error.errors[0].cause.message === 'lost stream');
  assert.equal(settled, true);
});
