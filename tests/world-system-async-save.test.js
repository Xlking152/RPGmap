import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldSystem } from '../src/world/system.js';
import { exportRuntimeState } from '../src/engine/runtime-state.js';
import { applyDocumentChanges } from '../src/documents/changes.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';
import { flushValidationTurn } from './fixtures/validation-turns.js';

function fixture() {
  let current = exportRuntimeState(worldCopyInput().state, { mapPackage: copyMap, ruleset: copyRuleset }), revision = 1;
  const calls = [], pending = [], durations = [];
  const api = {
    mapPackage: copyMap, ruleset: copyRuleset,
    getState: () => structuredClone(current), getStateRevision: () => revision,
    commitState(next) { current = next; revision += 1; },
    applyAuthoritativeDocumentChanges(changes, options) {
      current = applyDocumentChanges(current, changes, { updatedAt: options.updatedAt });
      revision += 1; calls.push(['commit', revision]);
    },
    persistNow(options) { calls.push(['sync', options]); return true; },
    persistValidatedAsync() { calls.push(['async']); return new Promise(resolve => pending.push(resolve)); },
    diagnostics: { measure(_name, fn) { return fn(); }, record(name, elapsed) { durations.push([name, elapsed]); } },
    emit() {},
  };
  registerRuntimeStateReader(api, () => current);
  createWorldSystem().register(api);
  return { api, calls, pending, durations, current: () => current };
}

test('untrusted operations commit in one turn and wait for the full async save acknowledgement', async () => {
  const f = fixture(), actor = f.api.world.listActors()[0];
  actor.notes = 'full validation required';
  let acknowledged = false;
  const operation = f.api.world.performOperations([{ type: 'actor.upsert', payload: { actor } }]).then(result => { acknowledged = true; return result; });
  assert.deepEqual(f.calls.map(item => item[0]), ['commit', 'async']);
  assert.equal(f.api.world.listActors()[0].notes, actor.notes);
  await flushValidationTurn();
  assert.equal(acknowledged, false);
  f.pending.shift()(true);
  assert.equal((await operation).offline, true);
  assert.equal(f.calls.some(item => item[0] === 'sync'), false);
  assert.ok(f.durations.some(([name, elapsed]) => name === 'world.persist' && elapsed >= 0));
});

test('movement and Fog retain synchronous trusted saves while mixed operations require full validation', async () => {
  const f = fixture(), sceneId = f.api.world.getActiveScene().id;
  await f.api.world.performOperations([{ type: 'token.reposition', payload: { sceneId, tokenId: 'token-a', x: 21, y: 22 } }]);
  assert.deepEqual(f.calls.map(item => item[0]), ['commit', 'sync']);
  assert.equal(f.calls[1][1].trustedWorldRevision, f.api.getStateRevision());
  f.calls.length = 0;
  await f.api.world.performOperations([{ type: 'scene.fog.explore', payload: { sceneId, partyId: 'party', x: 21, y: 22, radiusMeters: 20 } }], {
    addedExploration: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: { party: { rows: { 5: [[1, 5]] } } } },
  });
  assert.deepEqual(f.calls.map(item => item[0]), ['commit', 'sync']);
  assert.equal(f.calls[1][1].trustedWorldRevision, f.api.getStateRevision());
  f.calls.length = 0;
  const actor = f.api.world.listActors()[0]; actor.notes = 'mixed';
  const mixed = f.api.world.performOperations([
    { type: 'token.reposition', payload: { sceneId, tokenId: 'token-a', x: 24, y: 25 } },
    { type: 'actor.upsert', payload: { actor } },
  ]);
  assert.deepEqual(f.calls.map(item => item[0]), ['commit', 'async']);
  f.pending.shift()(true);
  await mixed;
});

test('failed async durability reports failure after commit and does not acknowledge the operation', async () => {
  const f = fixture(), actor = f.api.world.listActors()[0]; actor.notes = 'not durable';
  const operation = f.api.world.performOperations([{ type: 'actor.upsert', payload: { actor } }]);
  const rejected = assert.rejects(operation, /可靠保存/);
  assert.deepEqual(f.calls.map(item => item[0]), ['commit', 'async']);
  f.pending.shift()(false);
  await rejected;
  assert.equal(f.api.world.listActors()[0].notes, 'not durable');
});
