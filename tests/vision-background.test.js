import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisionBackground } from '../src/vision/background.js';

test('Worker construction failures reject asynchronously and disposed clients cannot restart', async () => {
  const original = globalThis.Worker;
  let constructions = 0;
  globalThis.Worker = class {
    constructor() { constructions++; throw new Error('worker blocked'); }
  };
  try {
    const background = createVisionBackground();
    let request;
    assert.doesNotThrow(() => { request = background.run({}); });
    await assert.rejects(request, /worker blocked/);
    background.dispose();
    await assert.rejects(background.run({}), /取消/);
    assert.equal(constructions, 1);
  } finally { globalThis.Worker = original; }
});

test('Worker message errors reject pending requests and a later request can recover', async () => {
  const original = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(data) { this.request = data; }
    terminate() { this.terminated = true; }
  };
  try {
    const background = createVisionBackground();
    const first = background.run({});
    const second = background.run({});
    assert.equal(typeof workers[0].onmessageerror, 'function');
    const rejected = Promise.all([assert.rejects(first), assert.rejects(second)]);
    workers[0].onmessageerror();
    await rejected;
    assert.equal(workers[0].terminated, true);
    const recovered = background.run({});
    workers[1].onmessage({ data: { id: workers[1].request.id, result: 'ok' } });
    assert.equal(await recovered, 'ok');
    background.dispose();
    await assert.rejects(background.run({}));
    assert.equal(workers.length, 2);
  } finally { globalThis.Worker = original; }
});

test('geometry invalidation rejects stale results and reuses the initialized Worker', async () => {
  const original = globalThis.Worker;
  const workers = [], starts = [];
  globalThis.Worker = class {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  };
  try {
    const background = createVisionBackground({ diagnostics: { record(name) { if (name === 'vision.workerStart') starts.push(name); } } });
    const input = { contextVersion: 1, map: { width: 100, height: 100, metersPerUnit: 1 }, occluders: [], lights: [] };
    const old = background.run(input), oldId = workers[0].messages[0].id;
    const rejected = assert.rejects(old, /取消/);
    background.cancel({ terminate: false });
    await rejected;
    assert.deepEqual(workers[0].messages[1], { cancelIds: [oldId] });
    assert.equal(workers[0].terminated, undefined);
    const next = background.run({ ...input, contextVersion: 2 });
    const nextMessage = workers[0].messages[2];
    assert.ok(nextMessage.input.map, 'invalidated context must resend current geometry');
    workers[0].onmessage({ data: { id: oldId, result: 'stale' } });
    workers[0].onmessage({ data: { id: nextMessage.id, result: 'current' } });
    assert.equal(await next, 'current');
    assert.equal(workers.length, 1);
    assert.equal(starts.length, 1);
    background.dispose();
    assert.equal(workers[0].terminated, true);
  } finally { globalThis.Worker = original; }
});

test('failed warm cancellation discards the Worker and permits a clean recovery', async () => {
  const original = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) { if (message.cancelIds) throw new Error('broken transport'); this.request = message; }
    terminate() { this.terminated = true; }
  };
  try {
    const background = createVisionBackground(), first = background.run({});
    const rejected = assert.rejects(first, /取消/);
    background.cancel({ terminate: false });
    await rejected;
    assert.equal(workers[0].terminated, true);
    const next = background.run({});
    workers[1].onmessage({ data: { id: workers[1].request.id, result: 'recovered' } });
    assert.equal(await next, 'recovered');
    background.dispose();
  } finally { globalThis.Worker = original; }
});
