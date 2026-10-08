import test from 'node:test';
import assert from 'node:assert/strict';
import { resetFogParty, resetImmutableFogParty, normalizeFogState } from '../src/vision/fog.js';
import { applyWorldOperations, applyWorldOperationsAsync } from '../src/world/operations.js';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const now = '2026-10-08T09:00:00.000Z';
const fogOf = state => state.preferences.worldV2.scenes[0].fog;
function fixture(rawFog) {
  const state = migrateTestStateToWorldV3({ markers: [], attackAreas: [], sceneEvents: [], preferences: {
    worldV2: { schemaVersion: 2, id: 'world-fog-reset', name: 'Fog reset',
      ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: 'scene-a', actors: [], statusDefinitions: [],
      scenes: [{ id: 'scene-a', name: 'Scene', mapPackage: { id: 'map', version: '1' }, tokens: [],
        markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, settings: { gridVisible: true },
        fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} } }], createdAt: now, updatedAt: now },
  } });
  state.preferences.worldV2.scenes[0].fog = rawFog;
  const validate = createCanonicalWorldValidator();
  validate(state);
  return { state, validate };
}
function fog() {
  return { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: Object.fromEntries(
    Array.from({ length: 6 }, (_, party) => [`party-${party}`, { rows: Object.fromEntries(
      Array.from({ length: 24 }, (_, row) => [row, [[1, 3], [6, 8], [12, 18]]])) }])) };
}

test('authority reset preserves original JSON and shares only accepted normalized immutable records', () => {
  const { state, validate } = fixture(fog()), original = fogOf(state), before = JSON.stringify(original);
  assert.equal(validate.isImmutableData(original), true);
  const actual = resetImmutableFogParty(original, ' party-2 ', validate.isImmutableData);
  assert.deepEqual(actual, resetFogParty(original, ' party-2 '));
  assert.equal(JSON.stringify(actual), JSON.stringify(resetFogParty(original, ' party-2 ')));
  assert.notEqual(actual, original);
  assert.notEqual(actual.exploredByParty, original.exploredByParty);
  assert.equal(actual.exploredByParty['party-3'], original.exploredByParty['party-3']);
  assert.throws(() => { actual.exploredByParty['party-3'].rows[0][0][0] = 99; }, TypeError);
  delete actual.exploredByParty['party-3'];
  assert.equal(JSON.stringify(original), before);
});

test('six sequential authority resets do not rebuild any surviving party grid', async () => {
  const { state: original, validate } = fixture(fog());
  let state = original;
  for (let party = 0; party < 6; party++) {
    const operation = { type: 'scene.fog.reset', payload: { sceneId: 'scene-a', partyId: `party-${party}` } };
    const expected = applyWorldOperations(state, [operation], { now });
    const actual = await applyWorldOperationsAsync(state, [operation], {
      now, trustedOperationHooks: true, isCanonicalData: validate.isImmutableData,
    });
    assert.deepEqual(actual, expected);
    for (let remaining = party + 1; remaining < 6; remaining++) {
      assert.equal(fogOf(actual.state).exploredByParty[`party-${remaining}`], fogOf(original).exploredByParty[`party-${remaining}`]);
    }
    validate(actual.state);
    state = actual.state;
  }
  assert.deepEqual(fogOf(state).exploredByParty, {});
  assert.equal(Object.keys(fogOf(original).exploredByParty).length, 6);
});

test('accepted Fog does not imply normalized keys or numeric values', () => {
  const mutations = [
    raw => { raw.schemaVersion = '1'; },
    raw => { raw.cellSizeMeters = '5'; },
    raw => { raw.exploredByParty[' party-0 '] = raw.exploredByParty['party-0']; delete raw.exploredByParty['party-0']; },
    raw => { raw.exploredByParty['party-0'].rows = { '00': [[1, 3]] }; },
    raw => { raw.exploredByParty['party-0'].rows[0] = [['1', '3']]; },
    raw => { raw.exploredByParty['party-0'].rows[0] = [[-0, 3]]; },
    raw => { raw.exploredByParty['party-0'].rows[0] = []; },
  ];
  for (const mutate of mutations) {
    const raw = fog(); mutate(raw);
    const { state, validate } = fixture(raw), input = fogOf(state);
    assert.equal(validate.isImmutableData(input), true);
    const actual = resetImmutableFogParty(input, 'party-5', validate.isImmutableData);
    assert.deepEqual(actual, resetFogParty(input, 'party-5'));
    assert.notEqual(actual.exploredByParty['party-1'], input.exploredByParty['party-1']);
  }
});

test('Fog and party extensions retain detached metadata and normalized-row alias boundaries', () => {
  for (const extend of [
    raw => { raw.extension = { rowsAlias: raw.exploredByParty['party-0'].rows }; },
    raw => { raw.exploredByParty['party-0'].extension = { rowsAlias: raw.exploredByParty['party-0'].rows }; },
  ]) {
    const raw = fog(); extend(raw);
    const { state, validate } = fixture(raw), input = fogOf(state);
    const actual = resetImmutableFogParty(input, 'party-5', validate.isImmutableData);
    assert.deepEqual(actual, resetFogParty(input, 'party-5'));
    assert.notEqual(actual.exploredByParty['party-0'], input.exploredByParty['party-0']);
    const alias = actual.extension?.rowsAlias || actual.exploredByParty['party-0'].extension.rowsAlias;
    assert.notEqual(alias, input.exploredByParty['party-0'].rows);
    assert.notEqual(alias, actual.exploredByParty['party-0'].rows);
    alias[0][0][0] = 999;
    assert.equal(input.exploredByParty['party-0'].rows[0][0][0], 1);
  }
});

test('unaccepted mutable or merely frozen Fog retains complete clone isolation', () => {
  for (const frozen of [false, true]) {
    const raw = fog();
    if (frozen) Object.freeze(raw);
    const actual = resetImmutableFogParty(raw, 'party-5', () => false);
    assert.deepEqual(actual, resetFogParty(raw, 'party-5'));
    actual.exploredByParty['party-0'].rows[0][0][0] = 99;
    assert.equal(raw.exploredByParty['party-0'].rows[0][0][0], 1);
  }
  const { state, validate } = fixture(fog());
  const operation = { type: 'scene.fog.reset', payload: { sceneId: 'scene-a', partyId: 'party-5' } };
  const actual = applyWorldOperations(state, [operation], { now, isCanonicalData: validate.isImmutableData });
  assert.notEqual(fogOf(actual.state).exploredByParty['party-0'], fogOf(state).exploredByParty['party-0']);
});

test('unqualified legacy, unusual containers, and discarded unsupported data preserve normalization or error', () => {
  const cases = [
    { exploredByParty: { party: { rows: { bad: [[1, 3]], 0: [[1.5, 3.8], ['2', '5'], [-1, 3]] } } } },
    { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: { party: null } },
    Object.assign(Object.create(null), fog()),
    { exploredByParty: { party: { rows: { 0: [[6, 8], [1, 3], [3, 5], [9, 10]] } } } },
  ];
  for (const raw of cases) assert.deepEqual(resetImmutableFogParty(raw, 'other', () => false), resetFogParty(raw, 'other'));
  const invalid = { exploredByParty: { party: { rows: { invalid: [() => 1] } } } };
  assert.throws(() => resetImmutableFogParty(invalid, 'party', () => false), { name: 'DataCloneError' });
  const tooMany = { exploredByParty: { party: { rows: { 0: Array.from({ length: 4097 }, (_, i) => [i * 3, i * 3]) } } } };
  assert.throws(() => resetImmutableFogParty(tooMany, 'party', () => false), { code: 'fog_limit' });
  const proxy = { exploredByParty: {}, extension: new Proxy({}, {}) };
  assert.throws(() => resetImmutableFogParty(proxy, 'party', () => false), { name: 'DataCloneError' });
  assert.deepEqual(normalizeFogState(cases[0]).exploredByParty.party.rows[0], [[1, 5]]);
});
