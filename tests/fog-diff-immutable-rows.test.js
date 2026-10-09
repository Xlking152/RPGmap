import test from 'node:test';
import assert from 'node:assert/strict';
import { createFogDocumentChanges } from '../src/documents/changes.js';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';

const fogResult = [{ sceneId: 'scene', dirtyBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 } }];
const stateWithFog = fog => ({ preferences: { worldV2: { scenes: [{ id: 'scene', fog }] } } });
const grid = exploredByParty => ({ schemaVersion: 1, cellSizeMeters: 5, exploredByParty });
const filtered = (fog, ids) => grid(Object.fromEntries(ids.filter(id => Object.hasOwn(fog.exploredByParty, id))
  .map(id => [id, fog.exploredByParty[id]])));

test('Fog row sharing has identical deltas, deletions and wire JSON to detached output', () => {
  const validate = createCanonicalWorldValidator();
  const beforeFog = grid({ a: { rows: { 0: [[0, 2]], 1: [[3, 4]] }, stale: 'removed' },
    deleted: { rows: { 5: [[1, 2]] } } });
  const afterFog = grid({ a: { rows: { 0: [[0, 5]], 2: [[6, 7]] } }, b: { rows: { 8: [[20, 30]] } } });
  validate({ payload: beforeFog }); validate({ payload: afterFog });
  const before = stateWithFog(beforeFog), after = stateWithFog(afterFog);
  const detached = createFogDocumentChanges(before, after, { fog: fogResult });
  const shared = createFogDocumentChanges(before, after, { fog: fogResult, isCanonicalData: validate.isImmutableData });
  assert.deepEqual(shared, detached);
  assert.equal(JSON.stringify(shared), JSON.stringify(detached));
  const change = shared[0], a = afterFog.exploredByParty.a;
  assert.strictEqual(change.changed.exploredByParty.a.rows[0], a.rows[0]);
  assert.strictEqual(change.changed.exploredByParty.b, afterFog.exploredByParty.b);
  assert.throws(() => { change.changed.exploredByParty.a.rows[0][0][1] = 999; }, TypeError);
  assert.throws(() => { change.changed.exploredByParty.b.rows[8].push([40, 50]); }, TypeError);
  assert.deepEqual(change.removed, [['exploredByParty', 'deleted'], ['exploredByParty', 'a', 'stale'],
    ['exploredByParty', 'a', 'rows', '1']]);
});

test('default Fog diff and unaccepted data still provide independently mutable replacement rows', () => {
  const validate = createCanonicalWorldValidator();
  const rows = [[0, 5]], fog = grid({ a: { rows: { 0: rows } } });
  const before = stateWithFog(grid({ a: { rows: { 0: [[0, 2]] } } })), after = stateWithFog(fog);
  for (const options of [{}, { isCanonicalData: validate.isImmutableData }]) {
    const changed = createFogDocumentChanges(before, after, { fog: fogResult, ...options })[0].changed;
    assert.notStrictEqual(changed.exploredByParty.a.rows[0], rows);
    changed.exploredByParty.a.rows[0][0][1] = 99;
    assert.equal(rows[0][1], 5);
  }
  validate({ payload: fog });
  const detached = createFogDocumentChanges(before, after, { fog: fogResult })[0].changed;
  detached.exploredByParty.a.rows[0].push([10, 20]);
  assert.equal(rows.length, 1);
});

test('sharing never introduces a party missing from a recipient projection', () => {
  const validate = createCanonicalWorldValidator();
  const beforeFog = grid({ a: { rows: { 0: [[0, 1]] } }, b: { rows: { 1: [[10, 11]] } } });
  const afterFog = grid({ a: { rows: { 0: [[0, 5]] } }, b: { rows: { 1: [[10, 15]] } },
    private: { rows: { 99: [[999, 1000]] } } });
  validate({ payload: beforeFog }); validate({ payload: afterFog });
  const changes = ids => createFogDocumentChanges(stateWithFog(filtered(beforeFog, ids)),
    stateWithFog(filtered(afterFog, ids)), { fog: fogResult, isCanonicalData: validate.isImmutableData });
  const a = changes(['a']), b = changes(['b']), both = changes(['a', 'b']);
  assert.deepEqual(Object.keys(a[0].changed.exploredByParty), ['a']);
  assert.deepEqual(Object.keys(b[0].changed.exploredByParty), ['b']);
  assert.deepEqual(Object.keys(both[0].changed.exploredByParty), ['a', 'b']);
  assert.strictEqual(a[0].changed.exploredByParty.a.rows[0], both[0].changed.exploredByParty.a.rows[0]);
  assert.strictEqual(b[0].changed.exploredByParty.b.rows[1], both[0].changed.exploredByParty.b.rows[1]);
  assert.equal(JSON.stringify([...a, ...b, ...both]).includes('private'), false);
});

test('equal Fog, create and delete retain their existing behavior with the proof hook', () => {
  const validate = createCanonicalWorldValidator(), fog = grid({ a: { rows: { 0: [[0, 5]] } } });
  validate({ payload: fog });
  const options = { fog: fogResult, isCanonicalData: validate.isImmutableData };
  assert.deepEqual(createFogDocumentChanges(stateWithFog(fog), stateWithFog(fog), options), []);
  const created = createFogDocumentChanges(stateWithFog(undefined), stateWithFog(fog), options);
  assert.deepEqual(created, createFogDocumentChanges(stateWithFog(undefined), stateWithFog(fog), { fog: fogResult }));
  assert.notStrictEqual(created[0].changed, fog);
  const deleted = createFogDocumentChanges(stateWithFog(fog), stateWithFog(undefined), options);
  assert.deepEqual(deleted, createFogDocumentChanges(stateWithFog(fog), stateWithFog(undefined), { fog: fogResult }));
});
