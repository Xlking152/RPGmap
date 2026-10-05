import test from 'node:test';
import assert from 'node:assert/strict';
import { measureDocumentBatch } from '../scripts/lan-benchmark-support.mjs';

class TestSocket extends EventTarget {
  listeners = new Map();
  sent = [];
  onSend = () => {};
  addEventListener(type, listener, options) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener); this.listeners.set(type, listeners);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  send(request) { this.sent.push(structuredClone(request)); this.onSend(request); }
  receive(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

const request = () => ({ type: 'document.batch', operationId: 'probe-1', baseRevision: 2,
  writes: [{ action: 'append', intent: 'chat.append', data: { text: 'same intent' } }] });

test('conflict retry keeps the first clock, intent and ID until ACK and every recipient receive the commit', async () => {
  const sender = new TestSocket(), player = new TestSocket();
  sender.onSend = current => {
    if (sender.sent.length === 1) {
      setTimeout(() => sender.receive({ type: 'document.batch.denied', operationId: current.operationId,
        code: 'revision_conflict', revision: 3 }), 10);
    } else {
      setTimeout(() => {
        sender.receive({ type: 'document.batch.ack', operationId: current.operationId, revision: 4 });
        sender.receive({ type: 'document.batch.committed', operationId: current.operationId, revision: 4 });
      }, 10);
      setTimeout(() => player.receive({ type: 'document.batch.committed', operationId: current.operationId, revision: 4 }), 20);
    }
  };
  const first = request();
  const measured = await measureDocumentBatch(sender, [sender, player], first, { revisionConflictRetries: 3 });
  assert.deepEqual(sender.sent, [first, { ...first, baseRevision: 3 }]);
  assert.equal(first.baseRevision, 2, 'Do not mutate the caller request during rebase');
  assert.equal(measured.initialBaseRevision, 2);
  assert.equal(measured.retryCount, 1);
  assert.equal(measured.revisionConflicts[0].revision, 3);
  assert(measured.revisionConflicts[0].elapsedMs >= 5);
  assert(measured.ackMs >= measured.revisionConflicts[0].elapsedMs + 5,
    'ACK timing must include the delay before the denied first attempt');
  assert(measured.fanoutMs >= measured.ackMs);
  assert.equal(measured.messages.length, 2);
  assert.equal(sender.listenerCount + player.listenerCount, 0);
});

test('bounded conflict retries remain failures without leaking pending listeners', async () => {
  const sender = new TestSocket(), player = new TestSocket();
  sender.onSend = current => queueMicrotask(() => sender.receive({ type: 'document.batch.denied',
    operationId: current.operationId, code: 'revision_conflict', revision: current.baseRevision + 1 }));
  await assert.rejects(measureDocumentBatch(sender, [sender, player], request(), { revisionConflictRetries: 2 }), /rejected/);
  assert.equal(sender.sent.length, 3);
  assert.equal(sender.listenerCount + player.listenerCount, 0);
});

test('permission and non-increasing revision denials are never retried', async () => {
  for (const message of [
    { code: 'permission_denied', revision: 3 },
    { code: 'revision_conflict', revision: 2 },
  ]) {
    const sender = new TestSocket(), player = new TestSocket();
    sender.onSend = current => queueMicrotask(() => sender.receive({ type: 'document.batch.denied',
      operationId: current.operationId, ...message }));
    await assert.rejects(measureDocumentBatch(sender, [player], request(), { revisionConflictRetries: 3 }), /rejected/);
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.listenerCount + player.listenerCount, 0);
  }
});

test('socket failure during a rebased request cleans up every recipient', async () => {
  const sender = new TestSocket(), player = new TestSocket();
  sender.onSend = current => queueMicrotask(() => {
    if (sender.sent.length === 1) sender.receive({ type: 'document.batch.denied', operationId: current.operationId,
      code: 'revision_conflict', revision: 3 });
    else player.dispatchEvent(new Event('close'));
  });
  await assert.rejects(measureDocumentBatch(sender, [sender, player], request(), { revisionConflictRetries: 3 }), /socket closed/);
  assert.equal(sender.sent.length, 2);
  assert.equal(sender.listenerCount + player.listenerCount, 0);
});
