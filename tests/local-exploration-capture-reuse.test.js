import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldSystem } from '../src/world/system.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { registeredInfiniteHorrorRuleset } from '../src/ruleset/index.js';
import { normalizeActorDocument } from '../src/actor/index.js';
import { applyDocumentChanges } from '../src/documents/changes.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';
import { createExplorationOperationCapture } from '../src/vision/exploration-operations.js';
import { copyMap, worldCopyInput } from './fixtures/world-copy-inputs.js';

const ring = [[80, 0], [90, 0], [90, 100], [80, 100]];
const map = { ...copyMap, features: [{ id: 'wall', category: 'wall', geometry: { points: ring },
  capabilities: { vision: { occluder: true, polygon: ring } } }] };
const clone = structuredClone;
const move = { type: 'token.reposition', payload: { sceneId: 'scene-a', tokenId: 'token-a', x: 20, y: 24 } };

function input({ lighting = 'normal', xray = false, height = 0, override = false, independent = false } = {}) {
  const state = worldCopyInput().state, world = state.preferences.worldV2, scene = world.scenes[0];
  const actor = normalizeActorDocument({ ...infiniteHorrorRuleset.actor.createDefault({ name: 'Scout', variantId: 'form-scout' }),
    id: 'actor-a', type: 'pc', partyId: 'party', effects: [] }, { ruleset: infiniteHorrorRuleset });
  actor.system.forms[0].detection = { captureCopyProbe: true, configured: true, preciseRangeMeters: 120,
    vagueRangeMeters: 500, senses: { xrayVision: xray } };
  actor.system.runtime.detectionOverrides = {};
  world.actors = [actor]; world.statusDefinitions = [];
  scene.sceneEvents = []; scene.featureStates = {}; scene.occlusionShapes = [];
  scene.settings.lighting = lighting;
  const token = scene.tokens[0]; token.elevationMeters = height;
  token.vision = { enabled: true, ...(override ? { preciseRangeOverrideMeters: 180, vagueRangeOverrideMeters: 1000 } : {}) };
  if (independent) {
    token.actorLink = false;
    token.actorDelta = { system: { runtime: { detectionOverrides: { senses: { xrayVision: true } } } } };
  }
  return state;
}

// A different Ruleset object with the original functions follows the exact
// pre-optimization capture path and provides the old local-input oracle.
const oldRuleset = { ...infiniteHorrorRuleset };
function fixture(state, ruleset, jobs = []) {
  let current = clone(state), metadata = { schemaVersion: 1, jobs: clone(jobs) }, connected = false;
  const handlers = new Map(), reductionCopies = [], savePaths = [];
  const api = {
    mapPackage: map, ruleset, vision: { getSource: () => 'token-a' },
    getState: () => clone(current), commitState(next) { current = next; },
    applyAuthoritativeDocumentChanges(changes, options) {
      current = applyDocumentChanges(current, changes, { updatedAt: options.updatedAt });
    },
    getLocalExploration: () => clone(metadata), setLocalExploration(next) { metadata = clone(next); },
    getStateRevision: () => 1,
    multiplayer: { getConnectionState: () => ({ connected }) },
    persistNow() { savePaths.push('sync'); connected = true; return true; },
    async persistValidatedAsync() { savePaths.push('full'); connected = true; return true; },
    on(name, callback) { const callbacks = handlers.get(name) || []; callbacks.push(callback); handlers.set(name, callbacks); },
    emit() {},
    diagnostics: { measure(name, callback) {
      if (name !== 'world.reduce') return callback();
      let copies = 0;
      const original = globalThis.structuredClone;
      globalThis.structuredClone = (value, ...args) => {
        if (value?.captureCopyProbe === true) copies += 1;
        return original(value, ...args);
      };
      try { return callback(); }
      finally { globalThis.structuredClone = original; reductionCopies.push(copies); }
    }, record() {} },
  };
  registerRuntimeStateReader(api, () => current);
  createWorldSystem().register(api);
  return { api, reductionCopies, savePaths, current: () => current,
    jobs: () => metadata.jobs.map(job => {
      const { contextVersion, ...detached } = clone(job.input);
      return detached;
    }),
    async perform(operations) { connected = false; return api.world.performOperations(clone(operations)); },
    dispose() { for (const callback of handlers.get('app:destroy') || []) callback(); },
  };
}

for (const ruleset of [infiniteHorrorRuleset, registeredInfiniteHorrorRuleset]) {
  test(`actual ${ruleset === infiniteHorrorRuleset ? 'direct' : 'registered'} IH local capture removes one full derivation`, async () => {
    const seed = input(), old = fixture(seed, oldRuleset), actual = fixture(seed, ruleset);
    try {
      const before = clone(actual.current());
      const [legacy, result] = await Promise.all([old.perform([move]), actual.perform([move])]);
      assert.deepEqual(actual.jobs(), old.jobs());
      assert.equal(actual.jobs().length, 1);
      assert.equal(actual.reductionCopies[0], 4, 'common Token normalization plus one source derive');
      assert.equal(old.reductionCopies[0], 6, 'old local capture adds a second full source derive');
      assert.deepEqual(actual.savePaths, ['sync']);
      assert.deepEqual(old.savePaths, ['sync']);
      result.operations[0].payload.x = 999;
      assert.equal(actual.current().preferences.worldV2.scenes[0].tokens[0].x, 20);
      assert.equal(before.preferences.worldV2.scenes[0].tokens[0].x, 10);
      assert.deepEqual(legacy.results, result.results);
    } finally { old.dispose(); actual.dispose(); }
  });
}

test('normal, dim, dark, x-ray, height, range override and independent Actor inputs match the old local capture', async () => {
  for (const options of [
    { lighting: 'dim' }, { lighting: 'dark' }, { lighting: 'dark', xray: true },
    { height: 100, override: true }, { independent: true, lighting: 'dim' },
  ]) {
    const seed = input(options), old = fixture(seed, oldRuleset), actual = fixture(seed, registeredInfiniteHorrorRuleset);
    try {
      await old.perform([move]); await actual.perform([move]);
      assert.deepEqual(actual.jobs(), old.jobs(), JSON.stringify(options));
      assert.equal(actual.jobs()[0].lineOfSightEnabled, !(options.xray || options.independent));
      assert.equal(actual.jobs()[0].sourceRangeMeters, options.override ? 1000 : 500);
      assert.equal(actual.jobs()[0].payload.elevationMeters, options.height || 0);
      assert.equal(actual.reductionCopies[0], old.reductionCopies[0] - 2);
      assert.equal(actual.current().preferences.worldV2.actors[0].system.forms[0].detection.senses.xrayVision, options.xray || false,
        'independent instance sense does not modify its base Actor');
    } finally { old.dispose(); actual.dispose(); }
  }
});

test('each segment in a confirmed height-changing route reuses the same operation descriptor', () => {
  const state = input({ height: 10 }), sourceId = 'token-a';
  const run = trusted => {
    let calls = 0;
    const describe = (actor, context) => { calls++; return infiniteHorrorRuleset.vision.describe(actor, context); };
    const ruleset = { ...infiniteHorrorRuleset, vision: { describe } };
    const capture = createExplorationOperationCapture({ sourceIds: [sourceId], ruleset, mapForScene: () => map,
      ...(trusted ? { describeVision: describe } : {}) });
    const operation = { type: 'token.movePath', payload: { sceneId: 'scene-a', tokenIds: [sourceId] } };
    const after = clone(state), prepared = capture.prepareOperation({ state: after, operation });
    after.preferences.worldV2.scenes[0].tokens[0] = { ...after.preferences.worldV2.scenes[0].tokens[0], x: 40, elevationMeters: 0 };
    capture.onOperationApplied({ state: after, operation, prepared, results: [{ action: 'token.movePath', motion: [{
      tokenId: sourceId, from: { x: 10, y: 20, elevationMeters: 10 }, to: { x: 40, y: 20, elevationMeters: 0 },
      waypoints: [{ x: 20, y: 20, elevationMeters: 80 }, { x: 30, y: 20, elevationMeters: 40 }, { x: 40, y: 20, elevationMeters: 0 }],
    }] }] });
    return { calls, inputs: capture.events[0].inputs };
  };
  const old = run(false), actual = run(true);
  assert.deepEqual(actual.inputs, old.inputs);
  assert.equal(old.calls, 4); assert.equal(actual.calls, 1);
  assert.equal(actual.inputs.length, 3, 'all accepted route segments remain queued');
});

test('status-definition refresh, destruction and object restoration retain complete old exploration inputs and full saves', async () => {
  const seed = input({ lighting: 'dark' }), old = fixture(seed, oldRuleset), actual = fixture(seed, infiniteHorrorRuleset);
  const damage = { id: 'wall-damage', type: 'damage', objectIds: [],
    clipHits: [{ featureId: 'wall', polygon: [[80, 30], [90, 30], [90, 40], [80, 40]] }] };
  const operations = [
    [{ type: 'status.definition.import', payload: { statusSchemaVersion: 4, definitions: [{
      id: 'vision-test', name: 'Vision test', scopes: ['actor'], category: 'neutral', maxStacks: 1,
      changes: [], capabilities: { visionPrecision: 'vague' },
    }] } }],
    [{ type: 'scene.content.replace', payload: { sceneId: 'scene-a', sceneEvents: [damage] } }],
    [{ type: 'scene.content.replace', payload: { sceneId: 'scene-a', sceneEvents: [damage,
      { id: 'wall-restore', type: 'restore', featureIds: ['wall'] }] } }],
  ];
  try {
    for (const batch of operations) { await old.perform(batch); await actual.perform(batch); }
    assert.deepEqual(actual.jobs(), old.jobs());
    assert.equal(actual.jobs().length, 3);
    assert.notDeepEqual(actual.jobs()[1].occluders, actual.jobs()[2].occluders, 'restored wall geometry is fresh');
    assert.deepEqual(actual.savePaths, ['full', 'full', 'full'], 'capture reuse never grants a trusted save');
    assert.deepEqual(old.savePaths, actual.savePaths);
  } finally { old.dispose(); actual.dispose(); }
});

test('custom and same-ID time-dependent describers keep both original contexts and calls', async () => {
  let calls = 0;
  const contexts = [];
  const custom = { ...infiniteHorrorRuleset, vision: { describe(actor, context) {
    calls++; contexts.push(context);
    return { ...infiniteHorrorRuleset.vision.describe(actor, context), senses: { xrayVision: calls % 2 === 0 } };
  } } };
  const f = fixture(input({ lighting: 'dark' }), custom);
  try {
    await f.perform([move]);
    assert.equal(calls, 2);
    assert.equal(contexts[0].lighting, 'normal'); assert.equal(Object.hasOwn(contexts[0], 'world'), false);
    assert.equal(Object.hasOwn(contexts[1], 'lighting'), false); assert.ok(contexts[1].world);
    assert.equal(f.jobs()[0].lineOfSightEnabled, false, 'custom second description remains authoritative for occlusion');
  } finally { f.dispose(); }
});

test('a later rejected local operation preserves the original World and enqueues no derived input', async () => {
  const f = fixture(input(), registeredInfiniteHorrorRuleset), before = clone(f.current());
  try {
    await assert.rejects(f.perform([move, { type: 'token.reposition', payload: { tokenId: 'missing', x: 24, y: 25 } }]),
      { code: 'token_not_found' });
    assert.deepEqual(f.current(), before); assert.deepEqual(f.jobs(), []); assert.deepEqual(f.savePaths, []);
  } finally { f.dispose(); }
});

test('resumed local exploration borrows current Fog from its original Scene without changing the durable job', async () => {
  const previous = globalThis.Worker, messages = [];
  globalThis.Worker = class {
    postMessage(message) { if (message.input) messages.push(clone(message)); }
    terminate() {}
  };
  let f;
  try {
    const state = input(), world = state.preferences.worldV2;
    const normalizedParty = 'p'.repeat(80), rawParty = `  ${normalizedParty}suffix  `;
    const rows = { 2: [[1, 3], [6, 8]] };
    world.activeSceneId = 'scene-b';
    world.scenes[0].fog = { schemaVersion: 1, cellSizeMeters: 5,
      exploredByParty: { [normalizedParty]: { rows } } };
    world.scenes[1].fog = { schemaVersion: 1, cellSizeMeters: 5,
      exploredByParty: { [normalizedParty]: { rows: { 10: [[10, 12]] } } } };
    const job = { id: 'confirmed-prior-scene', sceneId: 'scene-a', input: { partyId: rawParty,
      payload: { x: 10, y: 20, radiusMeters: 20, partyId: rawParty }, lineOfSightEnabled: true,
      occluders: [], map: { width: map.width, height: map.height, metersPerUnit: map.metersPerUnit } } };
    f = fixture(state, registeredInfiniteHorrorRuleset, [job]);
    const before = clone(f.current()), persisted = clone(f.api.getLocalExploration());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].input.exploredRows, rows, 'original Scene and normalized party ID determine the base');
    assert.deepEqual(f.api.getLocalExploration(), persisted);
    assert.equal(Object.hasOwn(f.api.getLocalExploration().jobs[0].input, 'exploredRows'), false);
    messages[0].input.exploredRows['2'][0][0] = 99;
    assert.deepEqual(f.current(), before, 'the Worker transport cannot mutate authoritative Fog');
    assert.deepEqual(f.api.getLocalExploration().jobs[0], job);
  } finally { f?.dispose(); globalThis.Worker = previous; }
});
