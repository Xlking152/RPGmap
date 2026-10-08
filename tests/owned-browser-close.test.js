import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { closeOwnedBrowser, rejectPendingCdp } from '../scripts/owned-browser-close.mjs';

class OwnedProcess extends EventEmitter {
  exitCode = null;
  signalCode = null;
  kills = 0;
  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
  kill() { this.kills += 1; }
}

function assertReleased(child, pending = new Map()) {
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.kills, 0, 'the helper never treats a forced kill as successful shutdown');
  assert.equal(pending.size, 0);
}

test('subscribes before sending and accepts normal exit before any CDP ACK', async () => {
  const child = new OwnedProcess();
  const result = await closeOwnedBrowser({ process: child, send(method) {
    assert.equal(method, 'Browser.close');
    assert.equal(child.listenerCount('exit'), 1);
    child.exit();
    return new Promise(() => {});
  } });
  assert.deepEqual(result, { exitCode: 0, signalCode: null });
  assertReleased(child);
});

test('CDP ACK alone waits for the owned process normal exit', async () => {
  const child = new OwnedProcess();
  let settled = false;
  const closing = closeOwnedBrowser({ process: child, send: async () => ({}) });
  closing.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  child.exit();
  await closing;
  assertReleased(child);
});

test('CDP disconnect/rejection is accepted only after normal owned exit', async () => {
  const child = new OwnedProcess();
  const closing = closeOwnedBrowser({ process: child, send: async () => { throw new Error('socket closed'); } });
  await Promise.resolve();
  child.exit();
  await closing;
  assertReleased(child);
});

test('a socket error without process exit remains a bounded failure', async () => {
  const child = new OwnedProcess();
  await assert.rejects(closeOwnedBrowser({ process: child, timeoutMs: 5, label: 'Owned Chrome',
    send: async () => { throw new Error('socket closed'); } }), /Owned Chrome shutdown timed out.*socket closed/);
  assertReleased(child);
});

test('a successful ACK without process exit still fails the shutdown deadline', async () => {
  const child = new OwnedProcess();
  await assert.rejects(closeOwnedBrowser({ process: child, timeoutMs: 5, send: async () => ({}) }), /shutdown timed out/);
  assertReleased(child);
});

test('a different process exit cannot satisfy the owned process shutdown', async () => {
  const child = new OwnedProcess(), other = new OwnedProcess();
  await assert.rejects(closeOwnedBrowser({ process: child, timeoutMs: 5, send() {
    other.exit();
    return Promise.resolve({});
  } }), /shutdown timed out/);
  assertReleased(child);
});

test('nonzero and signal exits fail even when Browser.close was acknowledged', async () => {
  for (const [code, signal] of [[7, null], [null, 'SIGKILL']]) {
    const child = new OwnedProcess();
    const closing = closeOwnedBrowser({ process: child, send: async () => ({}) });
    child.exit(code, signal);
    await assert.rejects(closing, /shutdown exited abnormally/);
    assertReleased(child);
  }
});

test('owned process errors fail independently of an acknowledged command', async () => {
  const child = new OwnedProcess();
  const closing = closeOwnedBrowser({ process: child, send: async () => ({}) });
  child.emit('error', new Error('process handle failed'));
  await assert.rejects(closing, /shutdown process failed: process handle failed/);
  assertReleased(child);
});

test('already exited processes retain their normal or abnormal status without another command', async () => {
  for (const code of [0, 2]) {
    const child = new OwnedProcess();
    child.exit(code);
    const closing = closeOwnedBrowser({ process: child, send() { assert.fail('already exited'); } });
    if (code === 0) await closing;
    else await assert.rejects(closing, /shutdown exited abnormally/);
    assertReleased(child);
  }
});

test('synchronous transport failure is not a success until a normal exit follows', async () => {
  const child = new OwnedProcess();
  const closing = closeOwnedBrowser({ process: child, send() { throw new Error('closed transport'); } });
  child.exit();
  await closing;
  assertReleased(child);
});

test('CDP teardown rejects both timer shapes and cancels their outstanding timeouts', async () => {
  let fired = 0;
  const errors = [], pending = new Map();
  pending.set(1, { timer: setTimeout(() => { fired++; }, 10), reject: error => errors.push(error) });
  pending.set(2, { timeout: setTimeout(() => { fired++; }, 10), reject: error => errors.push(error) });
  const cause = new Error('socket closed');
  rejectPendingCdp(pending, cause);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(fired, 0);
  assert.deepEqual(errors, [cause, cause]);
  assert.equal(pending.size, 0);
});

test('process exit also settles an unacknowledged Close and removes its long CDP timeout', async () => {
  const child = new OwnedProcess(), pending = new Map();
  let rejectClose;
  const command = new Promise((resolve, reject) => { rejectClose = reject; });
  const timer = setTimeout(() => assert.fail('left a sixty second CDP timeout'), 60_000);
  pending.set(1, { timer, reject: rejectClose });
  await closeOwnedBrowser({ process: child, pending, send() { child.exit(); return command; } });
  await assert.rejects(command, /process closed/);
  assertReleased(child, pending);
});

test('shutdown deadline is capped at five seconds even with a larger caller option', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new OwnedProcess();
  const closing = closeOwnedBrowser({ process: child, timeoutMs: 60_000, send: async () => ({}) });
  const failed = assert.rejects(closing, /shutdown timed out after 5000ms/);
  t.mock.timers.tick(5000);
  await failed;
  assertReleased(child);
});
