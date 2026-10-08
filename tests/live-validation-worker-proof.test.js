import test from 'node:test';
import assert from 'node:assert/strict';
import { cdpCommandEnvelope, proveLiveValidationWorker } from '../scripts/live-validation-worker-proof.mjs';

const url = 'http://127.0.0.1:1234/assets/world-validation-worker-abc.js';
const otherURL = 'http://127.0.0.1:1234/assets/visibility-worker-def.js';
const expected = { started: true, liveCount: 1, asset: '/assets/world-validation-worker-abc.js',
  scope: 'active-document', runtimeLocationVerified: true, frozenOrInactiveCount: 0 };
const target = (targetId, targetURL = '') => ({ targetId, type: 'worker', url: targetURL, attached: true });

function transport(targetInfos, locations = {}, overrides = {}) {
  const commands = [];
  async function send(method, params = {}, timeout, sessionId) {
    commands.push(cdpCommandEnvelope(commands.length + 1, method, params, sessionId));
    if (method === 'Target.setAutoAttach') {
      assert.deepEqual(params, { autoAttach: params.autoAttach, waitForDebuggerOnStart: false, flatten: true });
      assert.equal(typeof params.autoAttach, 'boolean');
      assert.equal(sessionId, undefined, 'auto-attach must use the page connection');
      if (overrides[method]) return overrides[method](params, sessionId);
      return {};
    }
    if (overrides[method]) return overrides[method](params, sessionId);
    if (method === 'Target.getTargets') return { targetInfos };
    if (method === 'Target.attachToTarget') {
      assert.equal(params.flatten, true);
      assert.equal(sessionId, undefined, 'attach must use the page connection');
      return { sessionId: `session:${params.targetId}` };
    }
    if (method === 'Runtime.evaluate') {
      assert.equal(params.expression, 'self.location.href');
      assert.equal(params.returnByValue, true);
      assert.equal(timeout, 5000);
      assert.equal(Object.hasOwn(params, 'sessionId'), false);
      assert.ok(sessionId?.startsWith('session:'));
      const targetId = sessionId.slice(8);
      return { result: { type: 'string', value: Object.hasOwn(locations, targetId) ? locations[targetId]
        : targetInfos.find(value => value.targetId === targetId)?.url } };
    }
    if (method === 'Target.detachFromTarget') {
      assert.equal(sessionId, undefined, 'detach session goes in params on the page connection');
      return {};
    }
    throw new Error(`Unexpected ${method}`);
  }
  return { send, commands };
}

function assertAutoAttachCleanup(io) {
  assert.deepEqual(io.commands[0], cdpCommandEnvelope(1, 'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }));
  const final = io.commands.at(-1);
  assert.deepEqual(final, cdpCommandEnvelope(io.commands.length, 'Target.setAutoAttach',
    { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }));
}

test('flat CDP session routing preserves normal envelopes and never modifies params', () => {
  const params = { expression: 'self.location.href' };
  assert.deepEqual(cdpCommandEnvelope(1, 'Runtime.evaluate', params, 'worker-session'),
    { id: 1, method: 'Runtime.evaluate', params, sessionId: 'worker-session' });
  assert.equal(Object.hasOwn(params, 'sessionId'), false);
  assert.deepEqual(cdpCommandEnvelope(2, 'Target.getTargets', {}), { id: 2, method: 'Target.getTargets', params: {} });
});

test('one known live module URL is verified by Runtime without attaching other target types', async () => {
  const io = transport([target('validation', url), target('vision', otherURL),
    { targetId: 'page', type: 'page', url: '' }, { targetId: 'service', type: 'service_worker', url }]);
  assert.deepEqual(await proveLiveValidationWorker(io.send), expected);
  assert.deepEqual(io.commands.map(command => command.method),
    ['Target.setAutoAttach', 'Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate', 'Target.detachFromTarget',
      'Target.attachToTarget', 'Runtime.evaluate', 'Target.detachFromTarget', 'Target.setAutoAttach']);
  assertAutoAttachCleanup(io);
});

test('six empty Chrome URLs are independently resolved and every own session is detached', async () => {
  const targets = Array.from({ length: 6 }, (_, index) => target(`worker-${index}`));
  const locations = Object.fromEntries(targets.map((value, index) => [value.targetId, index === 3 ? url : otherURL]));
  const io = transport(targets, locations);
  assert.deepEqual(await proveLiveValidationWorker(io.send), expected);
  for (let index = 0; index < 6; index++) {
    const [attach, evaluate, detach] = io.commands.slice(2 + index * 3, 5 + index * 3);
    assert.deepEqual(attach.params, { targetId: `worker-${index}`, flatten: true });
    assert.equal(evaluate.sessionId, `session:worker-${index}`);
    assert.deepEqual(detach.params, { sessionId: `session:worker-${index}` });
    assert.equal(Object.hasOwn(detach, 'sessionId'), false);
  }
  assert.equal(io.commands.length, 21);
  assertAutoAttachCleanup(io);
});

test('zero or two matching live Workers never satisfy the exact-one gate', async () => {
  for (const targets of [[], [target('vision', otherURL)], [target('one', url), target('two', url)]]) {
    const io = transport(targets);
    await assert.rejects(proveLiveValidationWorker(io.send), /must retain one live Module Worker/);
    assertAutoAttachCleanup(io);
  }
  const io = transport([target('known', url), target('unknown')], { unknown: url });
  await assert.rejects(proveLiveValidationWorker(io.send), /must retain one live Module Worker/);
  assert.equal(io.commands.at(-2).method, 'Target.detachFromTarget');
  assertAutoAttachCleanup(io);
});

test('a title or loaded resource name cannot replace the Worker actual location', async () => {
  const io = transport([{ ...target('unknown'), title: url }], { unknown: otherURL });
  await assert.rejects(proveLiveValidationWorker(io.send), /must retain one live Module Worker/);
  assertAutoAttachCleanup(io);
});

test('missing or invalid attached session IDs fail and detach by target ID without evaluating', async () => {
  for (const sessionId of [undefined, '', 42]) {
    const io = transport([target('unknown')], {}, { 'Target.attachToTarget': async () => ({ sessionId }) });
    await assert.rejects(proveLiveValidationWorker(io.send), /did not return a CDP session/);
    assert.equal(io.commands.some(command => command.method === 'Runtime.evaluate'), false);
    assert.deepEqual(io.commands.at(-2).params, { targetId: 'unknown' });
    assertAutoAttachCleanup(io);
  }
});

test('unknown Worker attach/evaluate failures cannot be skipped beside one known matching Worker', async () => {
  for (const method of ['Target.attachToTarget', 'Runtime.evaluate']) {
    const io = transport([target('known', url), target('unknown')], {}, {
      [method]: async (params, sessionId) => {
        if (params.targetId === 'unknown' || sessionId === 'session:unknown') throw new Error('unknown Worker unavailable');
        return method === 'Target.attachToTarget' ? { sessionId: 'session:known' }
          : { result: { type: 'string', value: url } };
      },
    });
    await assert.rejects(proveLiveValidationWorker(io.send), /unknown Worker unavailable/);
    if (method === 'Runtime.evaluate') assert.equal(io.commands.at(-2).method, 'Target.detachFromTarget');
    assertAutoAttachCleanup(io);
  }
});

test('empty or non-string evaluation results fail after detaching the own session', async () => {
  for (const result of [undefined, { type: 'string' }, { type: 'string', value: '' },
    { type: 'number', value: 1 }, { type: 'object', value: url }]) {
    const io = transport([target('unknown')], {}, { 'Runtime.evaluate': async () => ({ result }) });
    await assert.rejects(proveLiveValidationWorker(io.send), /did not return its actual location/);
    assert.deepEqual(io.commands.at(-2).params, { sessionId: 'session:unknown' });
    assertAutoAttachCleanup(io);
  }
});

test('Runtime exceptions fail even with a plausible value and always detach', async () => {
  const io = transport([target('unknown')], {}, { 'Runtime.evaluate': async () => ({
    result: { type: 'string', value: url }, exceptionDetails: { text: 'execution context unavailable' },
  }) });
  await assert.rejects(proveLiveValidationWorker(io.send), /location evaluation failed: execution context unavailable/);
  assert.equal(io.commands.at(-2).method, 'Target.detachFromTarget');
  assertAutoAttachCleanup(io);
});

test('failed detach cannot turn a successful address evaluation into a passed proof', async () => {
  const io = transport([target('unknown')], { unknown: url }, {
    'Target.detachFromTarget': async () => { throw new Error('detach failed'); },
  });
  await assert.rejects(proveLiveValidationWorker(io.send), /detach failed/);
  assertAutoAttachCleanup(io);
});

test('detach failure preserves the preceding evaluation error as an aggregate', async () => {
  const io = transport([target('unknown')], {}, {
    'Runtime.evaluate': async () => { throw new Error('evaluation failed'); },
    'Target.detachFromTarget': async () => { throw new Error('detach failed'); },
  });
  await assert.rejects(proveLiveValidationWorker(io.send), error => error instanceof AggregateError
    && error.errors[0].message === 'evaluation failed' && error.errors[1].message === 'detach failed');
  assertAutoAttachCleanup(io);
});

test('malformed targets or an asset URL with an unaccepted suffix never pass', async () => {
  for (const targets of [undefined, [target('bad', undefined)].map(value => ({ ...value, url: undefined })),
    [target('wrong-asset', `${url}?not-the-packaged-asset`)]]) {
    const io = transport(targets);
    await assert.rejects(proveLiveValidationWorker(io.send));
    assertAutoAttachCleanup(io);
  }
});

test('auto-attach completes before enumeration and never starts or pauses a Worker', async () => {
  let attached = false;
  const io = transport([target('validation', url)], {}, {
    'Target.setAutoAttach': async params => { attached = params.autoAttach; },
    'Target.getTargets': async () => {
      assert.equal(attached, true, 'enumeration must follow the completed auto-attach command');
      return { targetInfos: [target('validation', url)] };
    },
  });
  assert.deepEqual(await proveLiveValidationWorker(io.send), expected);
  assert.equal(attached, false);
  assertAutoAttachCleanup(io);
  assert.equal(io.commands.some(command => /runIfWaitingForDebugger|Runtime\.enable|Debugger/.test(command.method)), false);
});

test('auto-attach enable failure still attempts to disable and cannot enumerate or pass', async () => {
  const io = transport([target('validation', url)], {}, {
    'Target.setAutoAttach': async params => { if (params.autoAttach) throw new Error('enable failed'); },
  });
  await assert.rejects(proveLiveValidationWorker(io.send), /enable failed/);
  assertAutoAttachCleanup(io);
  assert.equal(io.commands.length, 2);
});

test('target enumeration failure still disables auto-attach', async () => {
  const io = transport([target('validation', url)], {}, {
    'Target.getTargets': async () => { throw new Error('enumeration failed'); },
  });
  await assert.rejects(proveLiveValidationWorker(io.send), /enumeration failed/);
  assertAutoAttachCleanup(io);
});

test('auto-attach cleanup failure cannot turn an exact-one proof into success', async () => {
  const io = transport([target('validation', url)], {}, {
    'Target.setAutoAttach': async params => { if (!params.autoAttach) throw new Error('cleanup failed'); },
  });
  await assert.rejects(proveLiveValidationWorker(io.send), /cleanup failed/);
  assertAutoAttachCleanup(io);
});

test('auto-attach cleanup failure preserves an earlier proof failure', async () => {
  const io = transport([], {}, {
    'Target.setAutoAttach': async params => { if (!params.autoAttach) throw new Error('cleanup failed'); },
  });
  await assert.rejects(proveLiveValidationWorker(io.send), error => error instanceof AggregateError
    && /must retain one live Module Worker/.test(error.errors[0].message)
    && error.errors[1].message === 'cleanup failed');
  assertAutoAttachCleanup(io);
});

test('combined auto-attach enable and cleanup failures both remain visible', async () => {
  const io = transport([target('validation', url)], {}, {
    'Target.setAutoAttach': async params => { throw new Error(params.autoAttach ? 'enable failed' : 'cleanup failed'); },
  });
  await assert.rejects(proveLiveValidationWorker(io.send), error => error instanceof AggregateError
    && error.errors[0].cause.message === 'enable failed' && error.errors[1].message === 'cleanup failed');
  assertAutoAttachCleanup(io);
  assert.equal(io.commands.length, 2);
});

test('Worker failure includes all original target metadata and the exact target being read', async () => {
  const unknown = { ...target('unknown'), parentId: 'page', parentFrameId: 'frame' };
  const targets = [
    { targetId: 'page', type: 'page', url: 'http://127.0.0.1:1234/', attached: true },
    { ...target('known', url), attached: true, parentId: 'page', parentFrameId: 'frame' },
    unknown,
  ];
  const original = new Error('Runtime.evaluate timed out');
  const io = transport(targets, {}, { 'Runtime.evaluate': async (params, sessionId) => {
    if (sessionId === 'session:unknown') throw original;
    return { result: { type: 'string', value: url } };
  } });
  await assert.rejects(proveLiveValidationWorker(io.send), error => {
    assert.equal(error.cause, original);
    const diagnostic = JSON.parse(error.message.split('; liveWorkerProofContext=')[1]);
    assert.deepEqual(diagnostic, { targetInfos: targets, currentTarget: unknown });
    return true;
  });
  assertAutoAttachCleanup(io);
  assert.equal(io.commands.at(-2).method, 'Target.detachFromTarget');
});

test('BFCache frozen registrations are counted without attaching and the active Worker is Runtime verified', async () => {
  const frozen = [
    { ...target('old-validation'), attached: false, parentId: 'page', parentFrameId: 'frame' },
    { ...target('old-vision', otherURL), attached: false, parentId: 'page', parentFrameId: 'frame' },
  ];
  const io = transport([...frozen, target('current', url)]);
  assert.deepEqual(await proveLiveValidationWorker(io.send), { ...expected, frozenOrInactiveCount: 2 });
  assert.deepEqual(io.commands.filter(command => command.method === 'Target.attachToTarget').map(command => command.params.targetId),
    ['current']);
  assert.equal(io.commands.filter(command => command.method === 'Runtime.evaluate').length, 1);
  assertAutoAttachCleanup(io);
});

test('unknown attachment states cannot be treated as active or frozen', async () => {
  for (const attached of [undefined, null, 0, 1, 'false', 'true']) {
    const io = transport([{ ...target('bad', url), attached }]);
    await assert.rejects(proveLiveValidationWorker(io.send), /missing its attachment state/);
    assert.equal(io.commands.some(command => command.method === 'Target.attachToTarget'), false);
    assertAutoAttachCleanup(io);
  }
});

test('an active advertised validation URL cannot replace its actual Runtime location', async () => {
  const io = transport([target('validation', url)], { validation: otherURL });
  await assert.rejects(proveLiveValidationWorker(io.send), /must retain one live Module Worker/);
  assert.equal(io.commands.filter(command => command.method === 'Runtime.evaluate').length, 1);
  assertAutoAttachCleanup(io);
  const invalid = transport([target('validation', url)], { validation: '' });
  await assert.rejects(proveLiveValidationWorker(invalid.send), /did not return its actual location/);
  assertAutoAttachCleanup(invalid);
});

test('two inactive validation registrations without an active Worker cannot satisfy the exact-one gate', async () => {
  const io = transport([target('one', url), target('two', url)].map(value => ({ ...value, attached: false })));
  await assert.rejects(proveLiveValidationWorker(io.send), /must retain one live Module Worker/);
  assert.equal(io.commands.some(command => command.method === 'Target.attachToTarget'), false);
  assertAutoAttachCleanup(io);
});

test('count and cleanup failures include the full enumerated list without claiming a current read', async () => {
  for (const targets of [[], [target('known', url)]]) {
    const io = transport(targets, {}, targets.length ? {
      'Target.setAutoAttach': async params => { if (!params.autoAttach) throw new Error('cleanup failed'); },
    } : {});
    await assert.rejects(proveLiveValidationWorker(io.send), error => {
      const diagnostic = JSON.parse(error.message.split('; liveWorkerProofContext=')[1]);
      assert.deepEqual(diagnostic, { targetInfos: targets, currentTarget: null });
      return true;
    });
    assertAutoAttachCleanup(io);
  }
});
