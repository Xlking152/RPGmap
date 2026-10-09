import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { createCanonicalExplorationFogMerger, mergeExplorationChunkFog } from '../src/server/exploration-compute.js';

const map = { metersPerUnit: 1, width: 1000, height: 1000 };
const fog = rows => ({ schemaVersion: 1, cellSizeMeters: 5,
  exploredByParty: { a: { rows }, b: { rows: { 1: [[5, 9]] } } } });
function fixture(value) {
  const validate = createCanonicalWorldValidator({ compactMetadata: true });
  validate(value);
  return { validate, merge: createCanonicalExplorationFogMerger(validate.isImmutableData) };
}

test('canonical exploration shares only unchanged immutable rows and spans', () => {
  const before = fog({ 0: [[0, 2], [10, 12], [30, 40]], 2: [[1, 3]] });
  const { merge, validate } = fixture(before), addition = { 0: [[20, 22]] };
  const next = merge(before, 'a', addition, map);
  assert.deepEqual(next, mergeExplorationChunkFog(structuredClone(before), 'a', addition, map));
  assert.equal(next.exploredByParty.b, before.exploredByParty.b);
  assert.equal(next.exploredByParty.a.rows[2], before.exploredByParty.a.rows[2]);
  for (const index of [0, 1, 3]) {
    assert.equal(next.exploredByParty.a.rows[0][index], before.exploredByParty.a.rows[0][index === 3 ? 2 : index]);
  }
  addition[0][0][1] = 100;
  assert.deepEqual(next.exploredByParty.a.rows[0][2], [20, 22]);
  assert.ok(Object.isFrozen(next)); assert.ok(Object.isFrozen(next.exploredByParty.a.rows[0][2]));
  const still = merge(next, 'a', { 0: [[10, 11]], 2: [[1, 2]] }, map);
  assert.equal(still, next);
  assert.equal(validate.isImmutableData(next), false, 'derived Fog is not yet authoritative');
  validate(next); assert.equal(validate.isImmutableData(next), true);
  const joined = merge(next, 'a', { 0: [[3, 29]] }, map);
  assert.deepEqual(joined.exploredByParty.a.rows[0], [[0, 40]]);
  assert.deepEqual(before.exploredByParty.a.rows[0], [[0, 2], [10, 12], [30, 40]]);
});

test('normalized immutable Fog unions match the original merger over many chunks and parties', () => {
  let state = fog({}); const { merge, validate } = fixture(state);
  let reference = structuredClone(state), seed = 9142;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let step = 0; step < 500; step++) {
    const party = ['a', 'b', 'c'][step % 3], row = String(random() % 40), start = random() % 150;
    const added = { [row]: [[start, start + random() % 12]] };
    state = merge(state, party, added, map);
    reference = mergeExplorationChunkFog(reference, party, added, map);
    assert.deepEqual(state, reference);
    if (step % 7 === 0) validate(state);
  }
});

test('imports, reset shells, map bounds and legacy metadata use normalization when needed', () => {
  const cases = [fog({ 0: [[0, 10]] }),
    { ...fog({ 0: [[0, 10]] }), metadata: { retained: true } },
    { ...fog({ 0: [[0, 10]] }), cellSizeMeters: 10 },
    { ...fog({}), exploredByParty: { ' a ': { rows: { '01': [[1, 3], [2, 4]] }, metadata: ['kept'] } } },
    fog({ 220: [[1, 3]], 0: [[0, 250]] }), fog({ 0: [[-0, 3]] })];
  for (const value of cases) for (const dims of [map, { ...map, width: 0 },
    { metersPerUnit: null, width: 1000, height: 1000 }]) {
    const before = structuredClone(value), original = structuredClone(value), { merge } = fixture(value);
    assert.deepEqual(merge(value, 'a', { 2: [[3, 7]] }, dims), mergeExplorationChunkFog(original, 'a', { 2: [[3, 7]] }, dims));
    assert.deepEqual(value, before);
  }
  const value = fog({ 0: [[0, 10]] }), { merge } = fixture(value);
  const reset = Object.freeze({ ...value, exploredByParty: Object.freeze({ b: value.exploredByParty.b }) });
  // A new accepted reset can retain the other party, never a removed party's rows.
  const validate = createCanonicalWorldValidator(); validate(reset);
  const after = createCanonicalExplorationFogMerger(validate.isImmutableData)(reset, 'a', { 2: [[3, 7]] }, map);
  assert.equal(after.exploredByParty.b, reset.exploredByParty.b);
  assert.deepEqual(after.exploredByParty.a.rows, { 2: [[3, 7]] });
  assert.deepEqual(merge(value, 'a', { 0: [[4, 5]] }, { ...map, width: 20 }).exploredByParty.a.rows[0], [[0, 5]]);
});

test('unqualified inputs and non-normal Worker rows retain the complete fallback', () => {
  for (const added of [{ 0: [[10, 12], [1, 3]] }, { 0: [[1.8, 3.9]] }, { 0: [] },
    { '-1': [[2, 3]] }, { 0: [[1, 3], [3, 6]] }]) {
    const value = fog({ 0: [[0, 2]] }), { merge } = fixture(value);
    assert.deepEqual(merge(value, 'a', added, map), mergeExplorationChunkFog(structuredClone(value), 'a', added, map));
  }
  const value = fog({ 0: [[0, 2]] });
  const unqualified = createCanonicalExplorationFogMerger(() => false);
  const next = unqualified(value, 'a', { 0: [[10, 11]] }, map);
  assert.deepEqual(next, mergeExplorationChunkFog(structuredClone(value), 'a', { 0: [[10, 11]] }, map));
  assert.notEqual(next.exploredByParty.b, value.exploredByParty.b);
  const accepted = fog({ 0: [[0, 2]] }), own = fixture(accepted);
  let reads = 0; const added = { get 0() { reads++; return [[4, 5]]; } };
  own.merge(accepted, 'a', added, map); assert.equal(reads, 1);
  assert.deepEqual(unqualified(value, 'a', {}, map), value);
});

test('the complete authority validator still rejects an oversized derived row', () => {
  const spans = Array.from({ length: 1000 }, (_, i) => [i * 3, i * 3]);
  const value = fog({ 0: spans }), wide = { metersPerUnit: 1, width: 100000, height: 1000 };
  const { merge, validate } = fixture(value);
  const rejected = merge(value, 'a', { 0: [[20000, 20000]] }, wide);
  assert.throws(() => validate(rejected), { code: 'world_limit' });
  assert.equal(validate.isImmutableData(rejected), false);
  assert.equal(validate.isImmutableData(value), true);
  assert.equal(value.exploredByParty.a.rows[0], spans);
  assert.equal(spans.length, 1000);
});

test('party names inherited from Object.prototype still create an own empty exploration record', () => {
  for (const partyId of ['toString', 'valueOf', 'hasOwnProperty']) {
    const value = fog({}), { merge, validate } = fixture(value);
    const next = merge(value, partyId, {}, map);
    assert.ok(Object.hasOwn(next.exploredByParty, partyId));
    assert.deepEqual(next, mergeExplorationChunkFog(structuredClone(value), partyId, {}, map));
    validate(next);
    assert.deepEqual(merge(next, partyId, { 0: [[0, 2]] }, map).exploredByParty[partyId].rows, { 0: [[0, 2]] });
  }
});
