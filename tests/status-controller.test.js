import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStatusOperationsToState, createStatusController } from '../src/status/controller.js';

function world() {
  return {
    preferences: {
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: [],
        actors: [{ id: 'actor-1', forms: [], runtime: {}, effects: [] }],
        tokens: [{ id: 'token-1', characterId: 'token-1', actorId: 'actor-1', effects: [] }],
      },
    },
    characters: [],
  };
}

function fakeApi({ online = false, performStatusOperation = null } = {}) {
  let state = world();
  const listeners = new Map();
  const emitted = [];
  let commits = 0;
  const api = {
    getState: () => state,
    commitState(next) {
      state = next;
      commits += 1;
      api.emit('state:commit', { source: 'test' });
    },
    persistNow() {},
    emit(type, detail) {
      emitted.push({ type, detail });
      for (const listener of listeners.get(type) || []) listener({ detail });
    },
    on(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
      return () => listeners.set(type, values.filter(value => value !== listener));
    },
    multiplayer: {
      getCapabilities: () => ({ connected: online, canManageStatuses: true }),
      performStatusOperation,
    },
  };
  return {
    api,
    emitted,
    get commits() { return commits; },
    get state() { return state; },
    set state(value) { state = value; },
  };
}

test('offline Promise API uses the local reducer, commits, and emits status:change', async () => {
  const runtime = fakeApi();
  createStatusController().register(runtime.api);
  const result = await runtime.api.status.apply({
    scope: 'actor', targetId: 'actor-1', definitionId: 'status-rooted', stacks: 1,
  });
  assert.equal(result.offline, true);
  assert.equal(runtime.commits, 1);
  assert.equal(runtime.state.preferences.entitySystem.actors[0].effects[0].definitionId, 'status-rooted');
  assert.equal(runtime.api.status.has({ actorId: 'actor-1' }, 'status-rooted'), true);
  assert.equal(runtime.api.status.has({ actorId: 'actor-1' }, 'status-spirit'), false);
  const changes = runtime.emitted.filter(event => event.type === 'status:change');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].detail.confirmed, true);
  assert.equal(changes[0].detail.snapshot.capabilities.canMove, false);

  await runtime.api.status.setStacks({
    scope: 'actor', targetId: 'actor-1', definitionId: 'status-rooted', stacks: 1,
  });
  await runtime.api.status.setNote({
    scope: 'actor', targetId: 'actor-1', definitionId: 'status-rooted', note: '剧情暂停',
  });
  await runtime.api.status.setEnabled({
    scope: 'actor', targetId: 'actor-1', definitionId: 'status-rooted', enabled: false,
  });
  const effect = runtime.state.preferences.entitySystem.actors[0].effects[0];
  assert.equal(effect.stacks, 1);
  assert.equal(effect.note, '剧情暂停');
  assert.equal(effect.enabled, false);
  assert.equal(runtime.api.status.resolve({ actorId: 'actor-1' }).capabilities.canMove, true);
});

test('LAN Promise and success event wait for multiplayer confirmation and canonical state', async () => {
  let confirm;
  const calls = [];
  const runtime = fakeApi({
    online: true,
    performStatusOperation(type, payload) {
      calls.push({ type, payload });
      return new Promise(resolve => { confirm = resolve; });
    },
  });
  createStatusController().register(runtime.api);
  let settled = false;
  const pending = runtime.api.status.apply({
    scope: 'token', targetId: 'token-1', definitionId: 'status-spirit', stacks: 1,
  }).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(runtime.commits, 0);
  assert.equal(runtime.emitted.some(event => event.type === 'status:change'), false);
  assert.deepEqual(calls, [{
    type: 'status.apply',
    payload: { scope: 'token', targetId: 'token-1', definitionId: 'status-spirit', stacks: 1 },
  }]);

  runtime.state.preferences.entitySystem.tokens[0].effects.push({
    id: 'effect-server', definitionId: 'status-spirit', stacks: 1, enabled: true,
  });
  runtime.api.emit('state:import', { source: 'server' });
  assert.equal(runtime.emitted.filter(event => event.type === 'status:change').length, 0);
  confirm({ operationId: 'status-1', revision: 2 });
  const result = await pending;
  assert.equal(result.revision, 2);
  assert.equal(settled, true);
  const changes = runtime.emitted.filter(event => event.type === 'status:change');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].detail.online, true);
  assert.deepEqual(changes[0].detail.snapshot.capabilities.collisionBypassGroups, ['structure']);
});

test('applyBatch forwards the server batch envelope unchanged', async () => {
  const calls = [];
  const runtime = fakeApi({
    online: true,
    performStatusOperation: async (type, payload) => {
      calls.push({ type, payload });
      return { operationId: 'batch-1', revision: 7 };
    },
  });
  createStatusController().register(runtime.api);
  const operations = [
    { type: 'status.apply', scope: 'actor', targetId: 'actor-1', definitionId: 'status-rooted', stacks: 1 },
    { type: 'status.remove', scope: 'token', targetId: 'token-1', definitionId: 'status-spirit' },
  ];
  await runtime.api.status.applyBatch(operations);
  assert.deepEqual(calls, [{ type: 'status.batch', payload: { operations } }]);
});

test('applyOperationsToState synchronously builds an atomic World draft', () => {
  const initial = world();
  const next = applyStatusOperationsToState(initial, [{
    type: 'status.apply', scope: 'actor', targetId: 'actor-1', statusId: 'status-rooted', stacks: 1,
  }], { now: '2026-08-26T00:00:00.000Z', idFactory: () => 'feature-effect', source: { type: 'feature' } });
  assert.notEqual(next, initial);
  assert.equal(initial.preferences.entitySystem.actors[0].effects.length, 0);
  assert.equal(next.preferences.entitySystem.actors[0].effects[0].id, 'feature-effect');
  assert.deepEqual(next.preferences.entitySystem.actors[0].effects[0].source, { type: 'feature' });
});
