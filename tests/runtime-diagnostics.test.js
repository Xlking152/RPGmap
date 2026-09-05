import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeDiagnostics } from '../src/diagnostics/runtime.js';

function fixture() {
  let time = 0;
  let nextId = 0;
  const frames = new Map();
  const listeners = new Map();
  const documentNode = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const windowNode = { requestAnimationFrame: fn => { frames.set(++nextId, fn); return nextId; }, cancelAnimationFrame: id => frames.delete(id) };
  const diagnostic = createRuntimeDiagnostics({ documentNode, windowNode, clock: { now: () => time }, limit: 3 });
  return { diagnostic, frames, documentNode, listeners, advance(ms) {
    time += ms;
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(time));
  }, elapse(ms) { time += ms; } };
}

test('Local diagnostics are disabled by default and do not schedule frames or input listeners', () => {
  const { diagnostic, frames, listeners } = fixture();
  diagnostic.record('frame', 50); diagnostic.begin('network.confirm', 'private-id'); diagnostic.end('network.confirm', 'private-id');
  assert.deepEqual(diagnostic.snapshot().metrics, {});
  assert.equal(frames.size, 0); assert.equal(listeners.size, 0);
  assert.equal(diagnostic.measure('sheet.dom', () => 42), 42);
});

test('Diagnostics distinguish frames, input scheduling, confirmations and DOM work without storing entity payloads', () => {
  const f = fixture();
  f.diagnostic.setEnabled(true); f.advance(16); f.advance(16);
  f.listeners.get('input')(); f.advance(16);
  f.diagnostic.begin('network.confirm', 'hidden-token-id'); f.elapse(9); f.diagnostic.end('network.confirm', 'hidden-token-id');
  f.diagnostic.measure('sheet.dom', () => f.elapse(2));
  f.diagnostic.record('hidden-token-id', 123);
  const result = f.diagnostic.snapshot();
  assert.equal(result.averageFps, 62.5);
  assert.equal(result.metrics['input.frame'].p95, 16);
  assert.equal(result.metrics['network.confirm'].p95, 9);
  assert.equal(result.metrics['sheet.dom'].p95, 2);
  assert.equal(JSON.stringify(result).includes('hidden-token-id'), false);
  f.diagnostic.setEnabled(false);
  assert.equal(f.frames.size, 0); assert.equal(f.listeners.size, 0);
});

test('Diagnostics exclude background frame gaps and keep bounded samples while retaining totals', () => {
  const f = fixture();
  f.diagnostic.setEnabled(true); f.advance(16); f.advance(16);
  f.documentNode.visibilityState = 'hidden'; f.advance(1000);
  f.documentNode.visibilityState = 'visible'; f.advance(1000); f.advance(16);
  for (let index = 0; index < 5; index += 1) f.diagnostic.record('sheet.dom', index);
  const result = f.diagnostic.snapshot();
  assert.equal(result.metrics.frame.max, 16);
  assert.equal(result.metrics['sheet.dom'].count, 5);
  assert.equal(result.metrics['sheet.dom'].retained, 3);
  assert.equal(result.metrics['sheet.dom'].mean, 2);
  f.diagnostic.destroy(); assert.equal(f.frames.size, 0);
});
