import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRuntimeState, exportRuntimeStateAsync, yieldRuntimeValidationFrame } from '../src/engine/runtime-state.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';
import { validationTurns, withValidationClock } from './fixtures/validation-turns.js';

const options = { mapPackage: copyMap, ruleset: copyRuleset };

test('the default budget batches short complete validation phases without fixed frame waits', async () => {
  const { state } = worldCopyInput(), before = structuredClone(state);
  const expected = JSON.stringify(exportRuntimeState(state, options));
  await withValidationClock([0, 1, 2, 3], async reads => {
    let yields = 0;
    const exported = await exportRuntimeStateAsync(state, options, { yieldTask: async () => { yields += 1; } });
    assert.equal(yields, 0, 'three semantic phases under 8 ms remain in one task');
    assert.equal(reads(), 4);
    assert.equal(JSON.stringify(exported), expected);
  });
  assert.deepEqual(state, before);
});

test('the default budget accumulates short phase time and yields at 8 ms', async () => {
  const { state } = worldCopyInput();
  const expected = JSON.stringify(exportRuntimeState(state, options));
  await withValidationClock([0, 3, 7, 8, 100], async reads => {
    let yields = 0;
    const exported = await exportRuntimeStateAsync(state, options, { yieldTask: async () => { yields += 1; } });
    assert.equal(yields, 1, 'individual phases below 8 ms still accumulate to the deadline');
    assert.equal(reads(), 5);
    assert.equal(JSON.stringify(exported), expected);
  });
});

test('paint waiting time resets the budget and does not force another short-phase frame wait', async () => {
  const { state } = worldCopyInput();
  const expected = JSON.stringify(exportRuntimeState(state, options));
  await withValidationClock([0, 4, 9, 100, 103], async reads => {
    let yields = 0;
    const exported = await exportRuntimeStateAsync(state, options, { yieldTask: async () => { yields += 1; } });
    assert.equal(yields, 1, 'the final 3 ms phase does not include the previous paint wait');
    assert.equal(reads(), 5);
    assert.equal(JSON.stringify(exported), expected);
  });
});

test('async full validation preserves synchronous exports, ordering and input isolation for each schema and scene', async () => {
  for (const sceneId of ['scene-a', 'scene-b']) for (const schemaVersion of [2, 3, 4]) {
    const { state } = worldCopyInput(sceneId);
    state.preferences.worldV2.schemaVersion = schemaVersion;
    const input = structuredClone(state);
    const expected = JSON.stringify(exportRuntimeState(state, options));
    const turns = validationTurns();
    const exported = await turns.finish(exportRuntimeStateAsync(state, options, { budgetMs: 0, yieldTask: turns.yieldTask }));
    assert.equal(JSON.stringify(exported), expected);
    assert.equal(turns.calls, 3);
    exported.extension.nested.value = 'changed';
    exported.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[2][0][0] = 19;
    assert.deepEqual(state, input);
  }
});

test('canonical export owns its entire input before its first yield', async () => {
  const { state } = worldCopyInput();
  const expected = JSON.stringify(exportRuntimeState(state, options));
  const turns = validationTurns();
  const saving = exportRuntimeStateAsync(state, options, { budgetMs: 0, yieldTask: turns.yieldTask });
  await turns.wait();
  state.preferences.worldV2.scenes[0].tokens[0].x = 92;
  state.preferences.worldV2.scenes[0].sceneEvents.push({ type: 'invalid' });
  state.preferences.extension.nested.value = 'caller changed';
  state.extension.nested.value = 'caller changed';
  assert.equal(JSON.stringify(await turns.finish(saving)), expected);
});

test('noncanonical export finishes all raw reads before its first yield', async () => {
  const { state } = worldCopyInput();
  delete state.preferences.worldV2;
  const expected = JSON.stringify(exportRuntimeState(state, options));
  const turns = validationTurns();
  const saving = exportRuntimeStateAsync(state, options, { budgetMs: 0, yieldTask: turns.yieldTask });
  await turns.wait();
  state.markers[0].x = NaN;
  state.preferences.extension.nested.value = 'caller changed';
  state.extension.nested.value = 'caller changed';
  assert.equal(JSON.stringify(await turns.finish(saving)), expected);
  assert.equal(turns.calls, 1);
});

test('async full validation keeps final malformed damage checks and original errors', async () => {
  const { state } = worldCopyInput();
  state.preferences.worldV2.scenes[0].sceneEvents = [{ id: 'invalid', type: 'damage', objectIds: [], clipHits: [],
    craterEnabled: true, craterPolygon: [[NaN, 5], [10, 5], [10, 10]] }];
  const before = structuredClone(state);
  let expected;
  try { exportRuntimeState(state, options); } catch (error) { expected = error; }
  assert.ok(expected);
  const turns = validationTurns();
  await assert.rejects(turns.finish(exportRuntimeStateAsync(state, options, { budgetMs: 0, yieldTask: turns.yieldTask })),
    error => error.constructor === expected.constructor && error.message === expected.message);
  assert.deepEqual(state, before);
});

test('aborting an owned validation stops later phases without mutating the source', async () => {
  const { state } = worldCopyInput();
  const before = structuredClone(state);
  const turns = validationTurns(), controller = new AbortController();
  const saving = exportRuntimeStateAsync(state, options, { budgetMs: 0, signal: controller.signal, yieldTask: () => turns.yieldTask({ signal: controller.signal }) });
  const rejected = assert.rejects(saving, { name: 'AbortError' });
  await turns.wait();
  controller.abort();
  await rejected;
  assert.equal(turns.calls, 1);
  assert.equal(turns.pending, 0);
  assert.deepEqual(state, before);
});

test('frame yielding allows a paint task, clears cancellation and advances in hidden pages', async () => {
  let callback, cancelled = 0, settled = false;
  const view = { requestAnimationFrame(fn) { callback = fn; return 7; }, cancelAnimationFrame(id) { assert.equal(id, 7); cancelled += 1; } };
  const painting = yieldRuntimeValidationFrame({ view }).then(() => { settled = true; });
  callback();
  await Promise.resolve();
  assert.equal(settled, false, 'validation must not continue as a pre-paint RAF microtask');
  await painting;
  assert.equal(cancelled, 1);
  const controller = new AbortController();
  const cancelledJob = yieldRuntimeValidationFrame({ view, signal: controller.signal });
  const rejected = assert.rejects(cancelledJob, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(cancelled, 2);
  await yieldRuntimeValidationFrame({ view: { requestAnimationFrame() { return 8; }, cancelAnimationFrame() {} } });
  await yieldRuntimeValidationFrame({ view: {} });
});
