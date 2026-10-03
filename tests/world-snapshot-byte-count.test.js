import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalWorldValidator, createWorldSnapshotSizeValidator } from '../deployment/local-server/world-schema.mjs';

const byteLength = value => Buffer.byteLength(JSON.stringify(value));
const durableState = state => ({ ...state, preferences: Object.fromEntries(Object.entries(state.preferences)
  .filter(([key]) => !['featureStates','featureInteractions'].includes(key))) });

test('canonical cached byte counts equal actual UTF-8 JSON including escapes, repeated references and omissions', () => {
  const validate = createCanonicalWorldValidator();
  const shared = { values: ['👁建筑\n\t"\\', '\ud800', '\u2028', true, null, -0, 1e-200, 1e22] };
  const state = { preferences: { featureStates: { foo: shared }, featureInteractions: {}, extra: shared },
    copies: [shared,shared], numbers: [-123.456,Number.MIN_VALUE,Number.MAX_VALUE] };
  validate(state);
  assert.equal(validate.serializedBytes(state), byteLength(state));
  assert.equal(validate.serializedBytes(state, { omitPreferencesKeys: ['featureStates','featureInteractions','featureStates'] }),
    byteLength(durableState(state)));
  for (let index = 0; index < 20; index++) {
    const next = { ...state, preferences: { ...state.preferences }, round: index, extra: { text: `轮次👁${index}` } };
    validate(next);
    assert.equal(validate.serializedBytes(next),byteLength(next));
  }
  const onlyOmitted = { preferences: { featureStates: {}, featureInteractions: {} } };
  validate(onlyOmitted);
  assert.equal(validate.serializedBytes(onlyOmitted,{omitPreferencesKeys:['featureStates','featureInteractions']}),
    byteLength({preferences:{}}));
  assert.throws(() => validate.serializedBytes({ preferences: {} }), { code: 'unverified_canonical' });
});

test('snapshot byte budgets include metadata and private exploration and reject before checkpoint is needed', () => {
  const validate = createCanonicalWorldValidator();
  const state = { preferences: {}, payload: 'a'.repeat(200) };
  validate(state);
  const snapshot = { schemaVersion: 1, worldId: 'byte-world', revision: 2, updatedAt: '2026-10-03T00:00:00.000Z',
    state, exploration: {schemaVersion:1,worldEpoch:'epoch',partyEpochs:{},contexts:{},jobs:{}}, recentStatusOperations: [] };
  const actualBytes = byteLength(snapshot);
  const checked = createWorldSnapshotSizeValidator(validate)(snapshot);
  assert.deepEqual(checked, {stateBytes:byteLength(state),explorationBytes:byteLength(snapshot.exploration),snapshotBytes:actualBytes});
  assert.deepEqual(createWorldSnapshotSizeValidator(validate)(snapshot),checked);
  assert.throws(() => createWorldSnapshotSizeValidator(validate,{maxStateBytes:byteLength(state)-1})(snapshot),{code:'state_too_large'});
  assert.throws(() => createWorldSnapshotSizeValidator(validate,{maxExplorationBytes:byteLength(snapshot.exploration)-1})(snapshot),
    {code:'exploration_backlog'});
  assert.throws(() => createWorldSnapshotSizeValidator(validate,{maxSnapshotBytes:actualBytes-1})(snapshot),{code:'state_too_large'});
  assert.equal(createWorldSnapshotSizeValidator(validate,{maxSnapshotBytes:actualBytes})(snapshot).snapshotBytes,actualBytes);
});

test('cached private queue sizes follow immutable progress and context release', () => {
  const validate = createCanonicalWorldValidator();
  const state = { preferences: { featureStates: { ignored: 'duplicate' } }, payload: 'World' };
  validate(state);
  const check = createWorldSnapshotSizeValidator(validate);
  const context = { map: { metersPerUnit: 1 }, occluders: [], lights: [] };
  const queue = {schemaVersion:1,worldEpoch:'epoch',partyEpochs:{},contexts:{geometry:context},jobs:{job:{id:'job',cursor:0}}};
  for (const exploration of [queue,{...queue,jobs:{job:{...queue.jobs.job,cursor:1}}},{...queue,contexts:{},jobs:{}}]) {
    const snapshot = {state,exploration,revision:2,recentStatusOperations:[],optional:undefined};
    const expected = {...snapshot,state:durableState(state)};
    assert.equal(check(snapshot).snapshotBytes,byteLength(expected));
    assert.equal(Object.isFrozen(exploration),true);
  }
});
