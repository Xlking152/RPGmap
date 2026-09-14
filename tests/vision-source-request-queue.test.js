import test from 'node:test';
import assert from 'node:assert/strict';
import { installVisionSourceRequestQueue } from '../src/multiplayer/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('vision source queue coalesces duplicate pending requests', async () => {
  const first = deferred();
  const calls = [];
  const multiplayer = {
    setVisionSource(tokenId) {
      calls.push(tokenId);
      return first.promise;
    },
  };
  installVisionSourceRequestQueue(multiplayer);

  const left = multiplayer.setVisionSource('token-a');
  const right = multiplayer.setVisionSource('token-a');
  await Promise.resolve();

  assert.equal(left, right);
  assert.deepEqual(calls, ['token-a']);

  first.resolve({ tokenId: 'token-a' });
  assert.deepEqual(await left, { tokenId: 'token-a' });
});

test('vision source queue serializes rapid source changes', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const multiplayer = {
    setVisionSource(tokenId) {
      calls.push(tokenId);
      return calls.length === 1 ? first.promise : second.promise;
    },
  };
  installVisionSourceRequestQueue(multiplayer);

  const selectA = multiplayer.setVisionSource('token-a');
  const selectB = multiplayer.setVisionSource('token-b');
  await Promise.resolve();
  assert.deepEqual(calls, ['token-a']);

  first.resolve({ tokenId: 'token-a' });
  assert.deepEqual(await selectA, { tokenId: 'token-a' });
  await Promise.resolve();
  assert.deepEqual(calls, ['token-a', 'token-b']);

  second.resolve({ tokenId: 'token-b' });
  assert.deepEqual(await selectB, { tokenId: 'token-b' });
});

test('automatic clear does not erase a newer source awaiting ACK', async () => {
  const first = deferred();
  const calls = [];
  const multiplayer = {
    setVisionSource(tokenId) {
      calls.push(tokenId);
      return first.promise;
    },
  };
  installVisionSourceRequestQueue(multiplayer);

  const select = multiplayer.setVisionSource('token-a');
  const automaticClear = multiplayer.setVisionSource(null);
  await Promise.resolve();

  assert.equal(select, automaticClear);
  assert.deepEqual(calls, ['token-a']);

  first.resolve({ tokenId: 'token-a' });
  assert.deepEqual(await automaticClear, { tokenId: 'token-a' });
});
