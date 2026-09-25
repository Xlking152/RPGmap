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
