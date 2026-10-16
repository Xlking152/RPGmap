import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStateForAudience } from '../src/vision/audience.js';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(frozen);
  return Object.freeze(value);
}

function fixture(actors = [{ id: 'hero', name: 'Hero', system: { health: { value: 10 } }, effects: [] }]) {
  return { preferences: { worldV2: { actors, scenes: [], statusDefinitions: [] } } };
}

test('trusted accepted Actor arrays share their existing immutable proof and lookup map', () => {
  const state = fixture(), actors = frozen(state.preferences.worldV2.actors);
  const validate = createCanonicalWorldValidator();
  // The proof is structural and can be queried for any accepted branch.
  validate({ payload: actors });
  assert.equal(validate.isImmutableData(actors), true);
  const context = { role: 'gm', trustedProjection: true, isCanonicalData: validate.isImmutableData };
  const descriptors = Object.getOwnPropertyDescriptors, mapSet = Map.prototype.set;
  let graphReads = 0, actorInsertions = 0;
  try {
    Object.getOwnPropertyDescriptors = value => {
      if (value === actors || value === actors[0] || value === actors[0].system) graphReads++;
      return descriptors(value);
    };
    Map.prototype.set = function (key, value) {
      if (value === actors[0]) actorInsertions++;
      return mapSet.call(this, key, value);
    };
    const first = projectStateForAudience(state, context);
    assert.equal(graphReads, 0, 'an accepted immutable Actor graph is not qualified again');
    assert.equal(actorInsertions, 1);
    assert.deepEqual(projectStateForAudience(state, context), first);
    assert.equal(graphReads, 0);
    assert.equal(actorInsertions, 1, 'subsequent recipients reuse the same canonical lookup map');
    assert.deepEqual(first, projectStateForAudience(structuredClone(state), { role: 'gm' }));
  } finally {
    Object.getOwnPropertyDescriptors = descriptors;
    Map.prototype.set = mapSet;
  }
});

test('public projection does not invoke a caller-provided canonical shortcut', () => {
  const state = fixture(), actors = frozen(state.preferences.worldV2.actors);
  const descriptors = Object.getOwnPropertyDescriptors;
  let graphReads = 0, proofCalls = 0;
  try {
    Object.getOwnPropertyDescriptors = value => {
      if (value === actors) graphReads++;
      return descriptors(value);
    };
    projectStateForAudience(state, { role: 'gm', isCanonicalData() { proofCalls++; return true; } });
    assert.equal(proofCalls, 0);
    assert.ok(graphReads > 0, 'the original graph qualification remains in place');
  } finally { Object.getOwnPropertyDescriptors = descriptors; }
});

test('accepted structural proofs do not cache duplicate or non-string Actor IDs', () => {
  for (const actors of [
    [{ id: 'hero', name: 'First' }, { id: 'hero', name: 'Last' }],
    [{ id: 1, name: 'Numeric' }],
    [{ id: '', name: 'Empty' }],
  ]) {
    const state = fixture(frozen(actors)), validate = createCanonicalWorldValidator();
    validate({ payload: actors });
    const context = { role: 'gm', trustedProjection: true, isCanonicalData: validate.isImmutableData };
    const mapSet = Map.prototype.set;
    let insertions = 0;
    try {
      Map.prototype.set = function (key, value) {
        if (value === actors[0]) insertions++;
        return mapSet.call(this, key, value);
      };
      const first = projectStateForAudience(state, context);
      const second = projectStateForAudience(state, context);
      assert.equal(insertions, 2, 'unqualified IDs rebuild their lookup on each projection');
      assert.deepEqual(first, second);
      assert.deepEqual(second, projectStateForAudience(structuredClone(state), { role: 'gm' }));
    } finally { Map.prototype.set = mapSet; }
  }
});

test('duplicate Actor lookup keeps the last entry for the active Token', () => {
  const actors = frozen([{ id: 'hero', name: 'First' }, { id: 'hero', name: 'Last' }]);
  const state = fixture(actors), world = state.preferences.worldV2;
  world.activeSceneId = 'scene';
  world.scenes = [{ id: 'scene', tokens: [{ id: 'token', actorId: 'hero', placement: 'map', x: 1, y: 2 }] }];
  const validate = createCanonicalWorldValidator();
  validate({ payload: actors });
  const seen = [];
  const context = { role: 'gm', trustedProjection: true, isCanonicalData: validate.isImmutableData,
    visionSourceTokenId: 'token', describeVision(actor) { seen.push(actor); return { rangeMeters: 20 }; } };
  for (let index = 0; index < 2; index++) {
    assert.equal(projectStateForAudience(state, context).preferences.audienceVision.source.rangeMeters, 20);
  }
  assert.deepEqual(seen, [actors[1], actors[1]]);
});

test('unaccepted mutable, accessor and Proxy Actor inputs retain fresh lookup behavior', () => {
  for (const kind of ['mutable', 'accessor', 'proxy', 'truthy-proof']) {
    const actors = [{ id: 'hero', name: 'Hero', system: { health: 10 } }];
    let name = 'Hero';
    if (kind === 'accessor') Object.defineProperty(actors[0], 'name', { enumerable: true, get: () => name });
    if (kind === 'proxy') actors[0] = new Proxy(actors[0], {});
    const state = fixture(actors), validate = createCanonicalWorldValidator();
    assert.equal(validate.isImmutableData(actors), false);
    const context = { role: 'gm', trustedProjection: true,
      isCanonicalData: kind === 'truthy-proof' ? () => 'true' : validate.isImmutableData };
    projectStateForAudience(state, context);
    if (kind === 'accessor') name = 'Changed';
    else actors[0].name = 'Changed';
    const mapSet = Map.prototype.set;
    let insertions = 0;
    try {
      Map.prototype.set = function (key, value) {
        if (value === actors[0]) insertions++;
        return mapSet.call(this, key, value);
      };
      const first = projectStateForAudience(state, context);
      const second = projectStateForAudience(state, context);
      assert.equal(insertions, 2, kind);
      assert.equal(second.preferences.worldV2.actors[0].name, 'Changed');
      assert.deepEqual(first, second);
    } finally { Map.prototype.set = mapSet; }
  }
});
