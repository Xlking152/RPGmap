import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldStatePersistence, createRemoteWorldIsolation } from '../src/app/world-storage.js';
import { exportRuntimeState, stringifyTrustedRuntimeState } from '../src/engine/runtime-state.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';
import { validationTurns, flushValidationTurn, withValidationClock } from './fixtures/validation-turns.js';

const options = { mapPackage: copyMap, ruleset: copyRuleset };
function fixture({ onSaved = () => {}, validationBudgetMs = 0 } = {}) {
  let state = exportRuntimeState(worldCopyInput().state, options), revision = 1;
  let readError = null, writeError = null, afterWrite = null;
  const records = new Map(), writes = [], errors = [], turns = validationTurns();
  const storageAdapter = {
    get: key => records.get(key),
    set(key, value) { records.set(key, value); writes.push(JSON.parse(value)); afterWrite?.(); if (writeError) throw writeError; },
  };
  const persistence = createWorldStatePersistence({ ...options, storageAdapter, validationYieldTask: turns.yieldTask, validationBudgetMs,
    getState() { if (readError) throw readError; return state; }, getStateRevision: () => revision,
    stringifyTrustedState: current => stringifyTrustedRuntimeState(current, options),
    onSaved, onError: error => errors.push(error) });
  function change(label, { sameIdentity = false } = {}) {
    if (!sameIdentity) state = structuredClone(state);
    state.extension.nested.value = label;
    state.preferences.worldV2.extension.nested.value = label;
    revision += 1;
    return state;
  }
  return { persistence, writes, errors, records, turns, change, get state() { return state; },
    set state(value) { state = value; revision += 1; },
    set readError(value) { readError = value; }, set writeError(value) { writeError = value; },
    set afterWrite(value) { afterWrite = value; } };
}

test('budgeted saves retain the initial paint opportunity while batching short full-validation phases', async () => {
  const f = fixture({ validationBudgetMs: 8 });
  await withValidationClock([0], async () => {
    const saving = f.persistence.persistValidatedAsync();
    await f.turns.wait();
    assert.equal(f.writes.length, 0, 'the authoritative commit has a paint opportunity before validation');
    assert.equal(f.turns.calls, 1);
    assert.equal(await f.turns.finish(saving), true);
    assert.equal(f.turns.calls, 1, 'short validation phases add no mandatory RAF waits');
    assert.equal(f.writes.length, 1);
    assert.equal(JSON.stringify(f.writes[0]), JSON.stringify(exportRuntimeState(f.state, options)));
  });
});

test('serial full saves coalesce and retry newer Fog/movement without overwriting trusted saves', async () => {
  const f = fixture();
  const saving = f.persistence.persistValidatedAsync();
  assert.equal(f.persistence.persistValidatedAsync(), saving);
  await f.turns.release(); // Start full validation and suspend its owned snapshot.
  f.change('new movement');
  f.state.preferences.worldV2.scenes[0].tokens[0].x = 42;
  f.state.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[3] = [[2, 8]];
  // The canonical projection used by a real document commit is kept current.
  f.state = exportRuntimeState(f.state, options);
  assert.equal(f.persistence.persistTrustedNow(), true);
  assert.equal(await f.turns.finish(saving), true);
  const expected = JSON.stringify(exportRuntimeState(f.state, options));
  assert.equal(JSON.stringify(f.writes.at(-1)), expected);
  assert.ok(f.writes.every(saved => saved.preferences.worldV2.scenes[0].tokens[0].x === 42));
  assert.ok(f.writes.every(saved => saved.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[3]));
  assert.equal(f.errors.length, 0);
  assert.equal(f.turns.pending, 0);
});

test('a newer Fog revision abandons the old snapshot at its next phase boundary', async () => {
  const f = fixture();
  const saving = f.persistence.persistValidatedAsync();
  await f.turns.release(); // The old owned migration snapshot is awaiting paint.
  f.change('new Fog revision');
  let latestSnapshotCopies = 0;
  Object.defineProperty(f.state.extension, 'captureProof', { enumerable: true,
    get() { latestSnapshotCopies += 1; return { value: 'latest only' }; } });
  await f.turns.release();
  assert.equal(latestSnapshotCopies, 1, 'resume must recapture the latest snapshot before computing the next old phase');
  assert.equal(f.turns.calls, 3, 'only one obsolete phase wait precedes the latest migration wait');
  assert.equal(f.writes.length, 0);
  assert.equal(await f.turns.finish(saving), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'new Fog revision');
  assert.deepEqual(f.writes[0].extension.captureProof, { value: 'latest only' });
  assert.equal(f.errors.length, 0);
  assert.equal(f.turns.calls, 4, 'one initial paint, one obsolete phase and both latest phase waits before complete final validation');
});

test('a snapshot superseded during input capture does not schedule an obsolete phase wait', async () => {
  const f = fixture();
  let changed = false;
  Object.defineProperty(f.state.extension, 'captureHook', { enumerable: true,
    get() {
      if (!changed) { changed = true; f.change('changed during capture'); }
      return 'detached extension';
    } });
  const saving = f.persistence.persistValidatedAsync();
  await f.turns.release();
  assert.equal(changed, true);
  assert.equal(f.turns.calls, 2, 'the obsolete migration yields no paint wait before recapturing latest');
  assert.equal(await f.turns.finish(saving), true);
  assert.equal(f.turns.calls, 3, 'only initial paint and both latest phase waits precede complete final validation');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'changed during capture');
  assert.equal(f.writes[0].extension.captureHook, 'detached extension');
  assert.equal(f.errors.length, 0);
});

test('revision guards detect an in-place update and final writes use the latest private queue', async () => {
  const f = fixture();
  f.persistence.setLocalExploration({ schemaVersion: 1, jobs: [{ id: 'old' }], generations: {} });
  const saving = f.persistence.persistValidatedAsync();
  await f.turns.release();
  f.change('in-place latest', { sameIdentity: true });
  f.persistence.setLocalExploration({ schemaVersion: 1, jobs: [{ id: 'new', confirmedPath: [{ x: 1, y: 2 }] }], generations: { a: 2 } });
  assert.equal(await f.turns.finish(saving), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'in-place latest');
  assert.deepEqual(f.writes[0]._localExploration, f.persistence.getLocalExploration());
  assert.equal(Object.hasOwn(f.state, '_localExploration'), false);
});

test('onSaved reentrant changes enqueue a new full save after the written snapshot', async () => {
  let f, second, saved = 0;
  f = fixture({ onSaved() {
    saved += 1;
    if (saved === 1) { f.change('reentrant'); second = f.persistence.persistValidatedAsync(); }
  } });
  const first = f.persistence.persistValidatedAsync();
  assert.equal(await f.turns.finish(first), true);
  assert.ok(second);
  assert.notEqual(second, first, 'the new operation cannot inherit the old save acknowledgement');
  assert.equal(await f.turns.finish(second), true);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].extension.nested.value, 'state');
  assert.equal(f.writes[1].extension.nested.value, 'reentrant');
});

test('cancel, suspend and dispose abort active validation without stale writes or failures', async () => {
  for (const action of ['cancel', 'suspend', 'dispose']) {
    const f = fixture();
    const saving = f.persistence.persistValidatedAsync();
    await f.turns.release();
    f.persistence[action]();
    assert.equal(await saving, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.errors.length, 0);
    assert.equal(f.persistence.blocked, false);
    assert.equal(f.turns.pending, 0);
    if (action === 'dispose') {
      assert.equal(f.persistence.persistNow(), false);
      assert.equal(await f.persistence.persistValidatedAsync(), false);
      assert.equal(f.persistence.schedule(), false);
    } else {
      if (action === 'suspend') {
        assert.equal(f.persistence.persistNow(), false);
        assert.equal(await f.persistence.persistValidatedAsync(), false);
        assert.throws(() => f.persistence.replace(f.state), { code: 'world_persistence_suspended' });
        f.persistence.resume();
      }
      f.change('resumed');
      assert.equal(await f.turns.finish(f.persistence.persistValidatedAsync()), true);
      assert.equal(f.writes.length, 1);
    }
  }
});

test('replacement cancels both owned validation and queued generation before imported data is written', async () => {
  const f = fixture();
  const saving = f.persistence.persistValidatedAsync();
  await f.turns.release();
  const replacement = structuredClone(f.state);
  replacement.extension.nested.value = 'imported';
  assert.equal(f.persistence.replace(replacement), true);
  assert.equal(await saving, false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'imported');
  assert.equal(f.turns.pending, 0);
});

test('joining and reconnecting LAN cannot write a projection through a pending local full save', async () => {
  const f = fixture(), local = structuredClone(f.state);
  const queue = { jobs: [{ id: 'confirmed local route' }] };
  f.persistence.setLocalExploration(queue);
  const isolation = createRemoteWorldIsolation({ persistence: f.persistence, getState: () => f.state,
    restoreState: state => { f.state = state; } });
  const saving = f.persistence.persistValidatedAsync();
  await f.turns.release();
  isolation.updateConnection({ connected: true, retainsServerState: true });
  f.change('private server projection');
  assert.equal(await saving, false);
  assert.equal(await f.persistence.persistValidatedAsync(), false);
  assert.equal(isolation.updateConnection({ connected: false, retainsServerState: true }), false);
  assert.equal(f.persistence.suspended, true);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0]._localExploration, queue);
  assert.equal(f.writes[0].extension.nested.value, 'state');
  assert.equal(isolation.updateConnection({ connected: false, retainsServerState: false }), true);
  assert.deepEqual(f.state, local);
  assert.equal(await f.turns.finish(f.persistence.persistValidatedAsync()), true);
  assert.ok(f.writes.every(saved => saved.extension.nested.value === 'state'));
});

test('a stale invalid snapshot retries the newer authority instead of blocking it', async () => {
  const f = fixture(), valid = structuredClone(f.state);
  f.state.preferences.worldV2.scenes[0].sceneEvents = [{ id: 'invalid', type: 'damage', objectIds: [], clipHits: [],
    craterEnabled: true, craterPolygon: [[NaN, 5], [10, 5], [10, 10]] }];
  const saving = f.persistence.persistValidatedAsync();
  await f.turns.release();
  f.state = valid;
  f.change('valid latest');
  assert.equal(await f.turns.finish(saving), true);
  assert.equal(f.errors.length, 0);
  assert.equal(f.persistence.blocked, false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'valid latest');
});

test('current validation failures block later writes until an explicit valid replacement', async () => {
  const f = fixture(), valid = structuredClone(f.state);
  f.state.preferences.worldV2.scenes[0].sceneEvents = [{ id: 'invalid', type: 'damage', objectIds: [], clipHits: [],
    craterEnabled: true, craterPolygon: [[NaN, 5], [10, 5], [10, 10]] }];
  assert.equal(await f.turns.finish(f.persistence.persistValidatedAsync()), false);
  assert.equal(f.persistence.blocked, true);
  assert.equal(f.errors.length, 1);
  assert.equal(f.persistence.persistNow(), false);
  assert.equal(await f.persistence.persistValidatedAsync(), false);
  assert.equal(f.persistence.replace(valid), true);
  f.state = valid;
  assert.equal(await f.turns.finish(f.persistence.persistValidatedAsync()), true);
});

test('rejected import validation cancels old work but leaves valid live saves writable', async () => {
  const f = fixture();
  const saving = f.persistence.persistValidatedAsync();
  await f.turns.release();
  const invalid = structuredClone(f.state);
  invalid.preferences.worldV2.schemaVersion = 99;
  assert.throws(() => f.persistence.replace(invalid), /schemaVersion/);
  assert.equal(await saving, false);
  assert.equal(f.persistence.blocked, false);
  assert.equal(f.errors.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(await f.turns.finish(f.persistence.persistValidatedAsync()), true);
});

test('read and uncertain storage failures pause writes, including failed replacement durability', async () => {
  for (const failure of ['read', 'write', 'replace']) {
    const f = fixture(), error = new Error(`${failure} failed`);
    if (failure === 'replace') {
      const replacement = structuredClone(f.state);
      replacement.extension.nested.value = 'imported';
      f.writeError = error;
      assert.throws(() => f.persistence.replace(replacement), caught => caught === error);
      f.writeError = null;
      assert.equal(f.writes[0].extension.nested.value, 'imported');
    } else {
      const saving = f.persistence.persistValidatedAsync();
      await f.turns.release();
      if (failure === 'read') f.readError = error;
      else { f.writeError = error; f.afterWrite = () => f.change('write-side mutation'); }
      assert.equal(await f.turns.finish(saving), false);
    }
    assert.equal(f.persistence.blocked, true);
    assert.deepEqual(f.errors, [error]);
    const writes = f.writes.length;
    assert.equal(await f.persistence.persistValidatedAsync(), false);
    assert.equal(f.persistence.persistNow(), false);
    assert.equal(f.writes.length, writes, 'automatic saves cannot overwrite an uncertain persisted record');
  }
});

test('repeated commits drain one coalesced validation after updates stop and retain the latest queue', async () => {
  const f = fixture();
  const saving = f.persistence.persistValidatedAsync();
  for (let move = 0; move < 6; move += 1) {
    await f.turns.release();
    f.change(`movement ${move}`);
    assert.equal(f.persistence.persistValidatedAsync(), saving);
    assert.equal(f.turns.pending, 1);
  }
  f.persistence.setLocalExploration({ jobs: [{ id: 'latest confirmed path' }] });
  assert.equal(await f.turns.finish(saving), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'movement 5');
  assert.deepEqual(f.writes[0]._localExploration, f.persistence.getLocalExploration());
  await flushValidationTurn();
  assert.equal(f.turns.pending, 0);
});
