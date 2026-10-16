import test from 'node:test';
import assert from 'node:assert/strict';
import { captureHostedCommittedVisionRevision, preserveAuditFailureDuringCleanup } from '../scripts/hosted-vision-commit.mjs';
import { hostedBrowserRuntime } from './helpers/hosted-browser-runtime.js';
import { runIncrementalEnvironmentAudit } from '../scripts/v3-incremental-environment-audit.mjs';

const rename = name => [{ type: 'world.rename', payload: { name } }];

test('audit links a real hosted controller ACK and Document event to the exact host render revision across later Fog commits', async t => {
  const { api, socket, request, commit, settle } = await hostedBrowserRuntime(t);
  const sourceLabels = [];
  api.on('state:patch', event => sourceLabels.push(event.detail.source));
  const serializedCapture = (0, eval)(`(${captureHostedCommittedVisionRevision.toString()})`);
  let finished = false;
  const pending = serializedCapture(api, 'v3-audit:setup', () => api.world.performOperations(rename('Committed'),
    { source: 'v3-audit:setup' })).then(result => { finished = true; return result; });
  const own = request();
  assert.equal(own.baseRevision, 40);
  const authority = await commit(own.operationId, rename('Committed'));
  await settle();
  assert.equal(finished, false, 'a Document patch without ACK is not success');
  assert.equal(api.world.get().name, 'Committed');
  const sceneId = api.world.get().activeSceneId;
  await commit('background-fog', [{ type: 'scene.fog.explore', payload: {
    sceneId, partyId: 'party', x: 10, y: 10, radiusMeters: 2,
  } }]);
  assert(api.getStateRevision() > authority.hostRevision);
  await socket.receive({ type: 'document.batch.ack', operationId: own.operationId,
    revision: authority.serverRevision, results: [] });
  const captured = await pending;
  assert.equal(captured.operationId, own.operationId);
  assert.equal(captured.serverRevision, authority.serverRevision);
  assert.equal(captured.revision, authority.hostRevision, 'do not substitute the later Fog render revision');
  assert.notEqual(captured.revision, captured.serverRevision, 'the two revision domains must remain separate');
  assert(sourceLabels.every(source => source === 'document.batch'));
});

test('interaction-style callers may discard the ACK value but still require its real controller completion and matching Document', async t => {
  const { api, socket, request, commit } = await hostedBrowserRuntime(t);
  const pending = captureHostedCommittedVisionRevision(api, 'feature:damage', async () => {
    await api.world.performOperations(rename('Damage proxy'), { source: 'feature:damage' });
    return { ok: true, action: 'damage' };
  });
  const own = request(), authority = await commit(own.operationId, rename('Damage proxy'));
  await socket.receive({ type: 'document.batch.ack', operationId: own.operationId,
    revision: authority.serverRevision, results: [] });
  assert.equal((await pending).revision, authority.hostRevision);
});

for (const order of ['ack-before-document', 'wrong-protocol-ack-id']) {
  test(`real controller cannot complete the audit on ${order}`, async t => {
    const { api, socket, request, commit, settle } = await hostedBrowserRuntime(t);
    let finished = false;
    const pending = captureHostedCommittedVisionRevision(api, order, () => api.world.performOperations(rename('Changed')))
      .then(value => { finished = true; return value; });
    const own = request();
    await socket.receive({ type: 'document.batch.ack',
      operationId: order === 'wrong-protocol-ack-id' ? 'unrelated-operation' : own.operationId,
      revision: 41, results: [] });
    await settle();
    assert.equal(finished, false, 'ACK alone cannot prove the matching canonical Document commit');
    const authority = await commit(own.operationId, rename('Changed'));
    if (order === 'wrong-protocol-ack-id') {
      assert.equal(finished, false, 'another operation ACK must not acknowledge this Document');
      await socket.receive({ type: 'document.batch.ack', operationId: own.operationId,
        revision: authority.serverRevision, results: [] });
    }
    const captured = await pending;
    assert.equal(captured.operationId, own.operationId);
    assert.equal(captured.serverRevision, authority.serverRevision);
    assert.equal(captured.revision, authority.hostRevision);
  });
}

test('create and delete Document events prove separate exact acknowledged host revisions', async t => {
  const { api, socket, request, commit } = await hostedBrowserRuntime(t);
  const seen = [];
  for (const action of ['create', 'delete']) api.on(`document:${action}`, event => {
    if (event.detail.document.type === 'Actor') seen.push([action, event.detail.operationId]);
  });
  for (const operations of [
    [{ type: 'actor.upsert', payload: { actor: { id: 'audit-actor', name: 'Audit Actor', type: 'pc', system: {}, effects: [] } } }],
    [{ type: 'actor.delete', payload: { actorId: 'audit-actor' } }],
  ]) {
    const pending = captureHostedCommittedVisionRevision(api, 'actor-lifecycle', () => api.world.performOperations(operations));
    const own = request(), authority = await commit(own.operationId, operations);
    await socket.receive({ type: 'document.batch.ack', operationId: own.operationId,
      revision: authority.serverRevision, results: [] });
    const captured = await pending;
    assert.equal(captured.revision, authority.hostRevision);
    assert.equal(captured.serverRevision, authority.serverRevision);
    assert.deepEqual(seen.at(-1), [operations[0].type === 'actor.upsert' ? 'create' : 'delete', own.operationId]);
  }
});

test('a real controller structural CAS refusal is preserved and submitted exactly once', async t => {
  const { api, socket, request, settle } = await hostedBrowserRuntime(t);
  let calls = 0;
  const pending = captureHostedCommittedVisionRevision(api, 'v3-audit:setup', () => {
    calls++;
    return api.world.performOperations([{ type: 'scene.content.replace', payload: {
      sceneId: api.world.get().activeSceneId, sceneEvents: [],
    } }]);
  });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'revision_conflict');
    assert.equal(error.auditCommit.label, 'v3-audit:setup');
    assert.deepEqual(error.auditCommit.pendingOperationIds, [own.operationId]);
    return true;
  });
  const own = request();
  await socket.receive({ type: 'document.batch.denied', operationId: own.operationId,
    code: 'revision_conflict', revision: 41, message: 'Authoritative state advanced before the structural write' });
  await rejected; await settle();
  assert.equal(calls, 1);
  assert.equal(socket.messages.filter(message => message.type === 'document.batch').length, 1,
    'the audit must not retry or rebase a refused structural command');
});

for (const corruption of ['wrong-ack-id', 'no-document-change', 'map-fingerprint']) {
  test(`hosted audit refuses ${corruption} instead of using the latest state as commit proof`, async t => {
    const { api, socket, request, commit } = await hostedBrowserRuntime(t);
    const operations = rename(corruption === 'no-document-change' ? 'Initial' : 'Changed');
    const pending = captureHostedCommittedVisionRevision(api, 'audit-proof', async () => {
      const ack = await api.world.performOperations(operations);
      return corruption === 'wrong-ack-id' ? { ...ack, operationId: 'other-operation' } : ack;
    });
    const rejected = assert.rejects(pending, { code: 'audit_commit_unproven' });
    const own = request(), authority = await commit(own.operationId, operations);
    if (corruption === 'map-fingerprint') api.mapPackage.fingerprint = 'different-content';
    await socket.receive({ type: 'document.batch.ack', operationId: own.operationId,
      revision: authority.serverRevision, results: [] });
    await rejected;
  });
}

test('audit primary failure and cleanup failure are retained together, with no retry', async () => {
  const primary = Object.assign(new Error('commit proof failed'), { code: 'audit_commit_unproven' });
  const cleanup = Object.assign(new Error('cleanup refused'), { code: 'revision_conflict' });
  const serialized = (0, eval)(`(${preserveAuditFailureDuringCleanup.toString()})`);
  let attempts = 0;
  await assert.rejects(serialized(async () => { throw primary; }, async () => { attempts++; throw cleanup; }), error => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    return true;
  });
  assert.equal(attempts, 1);
  await assert.rejects(serialized(async () => { throw primary; }, async () => {}), error => error === primary);
  await assert.rejects(serialized(async () => 'measured', async () => { throw cleanup; }), error => error === cleanup);
});

test('both audit and cleanup error details survive the browser evaluation JSON boundary', async () => {
  const primary = Object.assign(new Error('primary commit proof'), { code: 'audit_commit_unproven' });
  const cleanup = Object.assign(new Error('cleanup denied'), { code: 'revision_conflict' });
  const aggregate = new AggregateError([primary, cleanup], 'Audit and cleanup both failed');
  await assert.rejects(runIncrementalEnvironmentAudit(async expression => {
    const result = await new Function('document', `return ${expression};`)(
      { querySelector() { throw aggregate; } });
    return JSON.parse(JSON.stringify(result));
  }, { readAuthority: async () => ({ revision: 1, exploration: {
    jobs: {}, contexts: {}, partyEpochs: {}, worldEpoch: 'test-epoch' } }) }), error => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(child => [child.message, child.code]),
      [[primary.message, primary.code], [cleanup.message, cleanup.code]]);
    return true;
  });
});
