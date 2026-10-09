import test from 'node:test';
import assert from 'node:assert/strict';
import clipping from 'polygon-clipping';
import { applyWorldOperations, projectWorldOperationState } from '../src/world/operations.js';
import { applyDocumentChanges, createDocumentChanges } from '../src/documents/changes.js';
import { createRuntimeOperationInputProof, registerRuntimeStateReader } from '../src/engine/state-access.js';
import { createExplorationOperationCapture } from '../src/vision/exploration-operations.js';
import { registeredInfiniteHorrorRuleset, rulesetRegistry } from '../src/ruleset/index.js';
import { loadBuiltInRulesetReference } from '../src/ruleset/builtins.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';

const now = '2026-10-07T00:00:00.000Z';
function fixture() {
  const source = projectWorldOperationState(structuredClone(worldCopyInput().state));
  // Committed Document updates synchronously align these private projections.
  let current = applyDocumentChanges(source, []), revision = 1;
  const api = { getStateRevision: () => revision };
  const unregister = registerRuntimeStateReader(api, () => current);
  const context = { now, source: { role: 'offline' }, ruleset: copyRuleset, mapPackage: copyMap,
    prepareOperation() {}, onOperationApplied() {} };
  const state = current, scene = state.preferences.worldV2.scenes[0];
  const payload = { sceneId: scene.id, expectedActiveSceneId: scene.id,
    expectedSceneEvents: structuredClone(scene.sceneEvents),
    sceneEvents: [...structuredClone(scene.sceneEvents), { id: 'restore', type: 'restore', featureIds: ['wall'] }] };
  const operations = [{ type: 'scene.content.replace', payload }];
  context.runtimeOperationInputProof = createRuntimeOperationInputProof(api, state, context);
  return { state, scene, api, context, operations, unregister,
    advance() { revision++; }, replace(next) { current = next; },
  };
}

test('qualified private history replacement matches the complete reducer without copying unrelated Fog and documents', () => {
  const f = fixture(), before = structuredClone(f.state);
  try {
    const expected = applyWorldOperations(f.state, f.operations, { ...f.context });
    const actual = applyWorldOperations(f.state, f.operations, f.context);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'key order and wire values remain unchanged');
    assert.deepEqual(createDocumentChanges(f.state, actual.state), createDocumentChanges(f.state, expected.state));
    const world = actual.state.preferences.worldV2, scene = world.scenes[0];
    assert.notEqual(actual.state, f.state);
    assert.notEqual(world, f.state.preferences.worldV2);
    assert.notEqual(scene, f.scene);
    assert.equal(scene.fog, f.scene.fog);
    assert.equal(scene.tokens, f.scene.tokens);
    assert.equal(world.actors, f.state.preferences.worldV2.actors);
    assert.equal(world.scenes[1], f.state.preferences.worldV2.scenes[1]);
    assert.notEqual(scene.sceneEvents, f.scene.sceneEvents);
    assert.notEqual(scene.sceneEvents, f.operations[0].payload.sceneEvents);
    assert.notEqual(scene.sceneEvents[0], f.scene.sceneEvents[0]);
    assert.notEqual(actual.state.sceneEvents, scene.sceneEvents, 'new history projection remains independent');
    actual.state.sceneEvents.at(-1).featureIds.push('outside projection');
    assert.deepEqual(scene.sceneEvents.at(-1).featureIds, ['wall']);
    actual.operations[0].payload.sceneEvents.at(-1).featureIds.push('outside command');
    assert.deepEqual(scene.sceneEvents.at(-1).featureIds, ['wall']);
    assert.deepEqual(f.state, before);
  } finally { f.unregister(); }
});

test('the actual initially registered built-in qualifies; a same-ID registry replacement cannot inherit its identity', async () => {
  const f = fixture(), registered = await loadBuiltInRulesetReference(copyRuleset);
  assert.equal(registered, registeredInfiniteHorrorRuleset);
  assert.notEqual(registered, copyRuleset, 'the registry prepares a separate immutable implementation');
  try {
    f.context.ruleset = registered;
    f.context.runtimeOperationInputProof = createRuntimeOperationInputProof(f.api, f.state, f.context);
    const actual = applyWorldOperations(f.state, f.operations, f.context);
    assert.equal(actual.state.preferences.worldV2.scenes[0].fog, f.scene.fog, 'the production registered Ruleset reaches the private path');
    const replacement = rulesetRegistry.register({ ...registered,
      vision: { describe: () => ({ rangeMeters: 0 }) } });
    f.context.ruleset = replacement;
    f.context.runtimeOperationInputProof = createRuntimeOperationInputProof(f.api, f.state, f.context);
    const fallback = applyWorldOperations(f.state, f.operations, f.context);
    assert.notEqual(fallback.state.preferences.worldV2.scenes[0].fog, f.scene.fog);
    assert.equal(registeredInfiniteHorrorRuleset, registered, 'the private identity never follows mutable registry entries');
  } finally { rulesetRegistry.rulesets.set(registered.id, registered); f.unregister(); }
});

test('unqualified snapshots, operations and hooks retain the complete detached public path', () => {
  const cases = {
    'no proof': f => { delete f.context.runtimeOperationInputProof; },
    'forged proof': f => { f.context.runtimeOperationInputProof = {}; },
    'boolean proof': f => { f.context.runtimeOperationInputProof = true; },
    'unregistered reader': f => { f.unregister(); },
    'changed revision': f => { f.advance(); },
    'changed private state': f => { f.replace(structuredClone(f.state)); },
    'changed context identity': f => { f.context = { ...f.context }; },
    'changed context hook': f => { f.context.onOperationApplied = () => {}; },
    'new context hook': f => { f.context.mapForScene = () => copyMap; },
    'changed source role': f => { f.context.source.role = 'gm'; },
    'changed source name': f => { f.context.source.source = 'outside'; },
    'initial independent projection': f => { f.state.preferences.entitySystem.tokens = structuredClone(f.scene.tokens); },
    'legacy schema': f => { f.state.preferences.worldV2.schemaVersion = 3; },
    'mixed batch': f => { f.operations.push({ type: 'scene.settings.patch', payload: { patch: { gridVisible: true } } }); },
    'other content': f => { f.operations[0].payload.markers = []; },
  };
  for (const [label, change] of Object.entries(cases)) {
    const f = fixture();
    try {
      change(f);
      const before = structuredClone(f.state), actual = applyWorldOperations(f.state, f.operations, f.context);
      const scene = actual.state.preferences.worldV2.scenes[0];
      assert.notEqual(scene.fog, f.scene.fog, label);
      scene.fog.exploredByParty.party.rows[2][0][0] = 999;
      actual.state.preferences.entitySystem.actors[0].extension.nested.value = 'outside';
      assert.notEqual(actual.state.preferences.entitySystem.actors[0], actual.state.preferences.worldV2.actors[0], label);
      assert.deepEqual(f.state, before, label);
    } finally { f.unregister(); }
  }
});

test('a same-ID custom vision describer and its capture keep mutations in the fully detached transaction', () => {
  const f = fixture();
  let descriptions = 0;
  const custom = { ...copyRuleset, vision: { ...copyRuleset.vision,
    describe(actor, context) {
      descriptions++;
      actor.extension.nested.value = 'custom Actor mutation';
      if (context.scene) context.scene.extension.nested.value = 'custom Scene mutation';
      return { rangeMeters: 0, preciseRangeMeters: 0, vagueRangeMeters: 0 };
    } } };
  const capture = createExplorationOperationCapture({ sourceIds: ['token-a'], ruleset: custom,
    mapForScene: () => copyMap });
  f.context.ruleset = custom;
  f.context.prepareOperation = capture.prepareOperation;
  f.context.onOperationApplied = capture.onOperationApplied;
  f.context.runtimeOperationInputProof = createRuntimeOperationInputProof(f.api, f.state, f.context);
  const before = structuredClone(f.state);
  try {
    const actual = applyWorldOperations(f.state, f.operations, f.context);
    assert.ok(descriptions > 0, 'the real capture invokes the custom describer');
    assert.notEqual(actual.state.preferences.worldV2.scenes[0].fog, f.scene.fog);
    assert.equal(actual.state.preferences.worldV2.actors[0].extension.nested.value, 'custom Actor mutation');
    assert.deepEqual(f.state, before, 'custom Ruleset effects cannot reach a shared private Actor or Scene');
  } finally { f.unregister(); }
});

test('standalone non-JSON input still fails structuredClone instead of acquiring private sharing', () => {
  const f = fixture();
  try {
    f.state.extension.uncloneable = () => {};
    assert.throws(() => applyWorldOperations(f.state, f.operations, { ...f.context }), { name: 'DataCloneError' });
    assert.throws(() => applyWorldOperations(f.state, f.operations, { ...f.context, runtimeOperationInputProof: true }), { name: 'DataCloneError' });
  } finally { f.unregister(); }
});

test('private history and active Scene guards reject before mutating the owned input', () => {
  for (const guard of ['expectedSceneEvents', 'expectedActiveSceneId']) {
    const f = fixture();
    try {
      f.operations[0].payload[guard] = guard === 'expectedSceneEvents' ? [] : 'scene-b';
      const before = structuredClone(f.state);
      assert.throws(() => applyWorldOperations(f.state, f.operations, f.context), { code: 'scene_content_conflict' });
      assert.deepEqual(f.state, before);
    } finally { f.unregister(); }
  }
});

test('private clipping preflight failure leaves shared Fog and the original history unchanged', () => {
  const f = fixture(), original = clipping.difference;
  const points = [[0, 0], [100, 0], [100, 100], [0, 100]];
  f.scene.sceneEvents.length = 0;
  f.context.mapPackage = { ...copyMap, features: [{ id: 'wall', category: 'wall', geometry: { points },
    capabilities: { vision: { occluder: true, polygon: points } } }] };
  f.context.runtimeOperationInputProof = createRuntimeOperationInputProof(f.api, f.state, f.context);
  f.operations[0].payload.expectedSceneEvents = [];
  f.operations[0].payload.sceneEvents = [{ id: 'partial', type: 'damage', objectIds: [],
    clipHits: [{ featureId: 'wall', polygon: [[0, 0], [10, 0], [10, 100], [0, 100]] }] }];
  const before = structuredClone(f.state);
  clipping.difference = () => { throw new Error('Unable to pop() left SweepEvent injected'); };
  try {
    assert.throws(() => applyWorldOperations(f.state, f.operations, f.context), error => error.code === 'geometry_clip_failed' && error.featureId === 'wall');
    assert.deepEqual(f.state, before);
  } finally { clipping.difference = original; f.unregister(); }
});
