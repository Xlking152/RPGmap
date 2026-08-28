import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertCanonicalActor } from '../src/entities/actor-operations.js';

test('canonical Actor upsert writes only through World operations', async () => {
  const calls = [];
  const emitted = [];
  let persists = 0;
  const api = {
    world: {
      async performOperations(operations, options) {
        calls.push({ operations, options });
        return { offline: true };
      },
    },
    persistNow() { persists += 1; },
    emit(type, detail) { emitted.push({ type, detail }); },
  };
  const actor = { id: 'actor-1', name: 'A', system: { value: 3 }, effects: [] };
  await upsertCanonicalActor(api, actor, { source: 'test:actor' });

  assert.deepEqual(calls, [{
    operations: [{ type: 'actor.upsert', payload: { actor } }],
    options: { source: 'test:actor', render: false, kind: 'actor' },
  }]);
  assert.equal(persists, 1);
  assert.deepEqual(emitted, [{
    type: 'actor:change',
    detail: { actorId: 'actor-1', source: 'test:actor', canonical: true },
  }]);
});

test('canonical Actor upsert refuses projection-only runtimes', async () => {
  await assert.rejects(
    upsertCanonicalActor({}, { id: 'actor-1' }),
    error => error?.code === 'world_operation_required',
  );
  await assert.rejects(
    upsertCanonicalActor({ world: { performOperations: async () => ({}) } }, {}),
    error => error?.code === 'actor_id_required',
  );
});
