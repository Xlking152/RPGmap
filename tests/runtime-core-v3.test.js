import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeSession } from '../src/runtime/core/session.js';
import { worldOperationsToDocumentWrites } from '../src/documents/protocol.js';
import { applyWorldOperationsAsync, projectWorldOperationState } from '../src/world/operations.js';

const ruleset = { id: 'minimal-rules', version: '1' };
const map = { id: 'map', version: '1', width: 100, height: 100, metersPerUnit: 1, features: [] };
const NOW = '2026-10-13T00:00:00.000Z';
const tick = () => new Promise(resolve => setImmediate(resolve));
const writes = operations => worldOperationsToDocumentWrites(operations, { worldId: 'world', sceneId: 'scene' });
const rename = name => writes([{ type: 'world.rename', payload: { name } }]);
function state() {
  return projectWorldOperationState({ preferences: { worldV2: {
    schemaVersion: 4, id: 'world', name: 'Initial', ruleset: { id: ruleset.id, version: ruleset.version },
    activeSceneId: 'scene', actors: [], statusDefinitions: [], scenes: [{ id: 'scene', name: 'Scene',
      mapPackage: { id: map.id, version: map.version }, tokens: [], markers: [], attackAreas: [], sceneEvents: [],
      featureStates: {}, occlusionShapes: [], settings: { gridVisible: true } }], createdAt: NOW, updatedAt: NOW,
  }, combatSystem: { schemaVersion: 1, combat: null } } });
}
const session = options => createRuntimeSession({ initialState: state(), ruleset, mapForScene: () => map, ...options });

test('no-DOM Runtime dispatch executes the shared Document protocol and pure reducer as an atomic batch', async () => {
  const initial = state(), core = session();
  const operations = [{ type: 'world.rename', payload: { name: 'Updated' } },
    { type: 'scene.settings.patch', payload: { sceneId: 'scene', patch: { gridVisible: false } } }];
  const actual = await core.dispatch(writes(operations), { context: { now: NOW } });
  const expected = await applyWorldOperationsAsync(initial, operations, { ruleset, mapForScene: () => map,
    now: NOW, source: { role: 'offline', source: 'runtime.dispatch' } });
  assert.deepEqual(actual.state, expected.state);
  assert.equal(core.getRevision(), 1);
  assert.equal(core.getActiveScene().settings.gridVisible, false);
  const before = core.read();
  await assert.rejects(core.dispatch(writes([{ type: 'world.rename', payload: { name: 'Partial' } },
    { type: 'scene.delete', payload: { sceneId: 'missing' } }]), { context: { now: NOW } }), { code: 'scene_not_found' });
  assert.deepEqual(core.read(), before);
  assert.equal(core.getRevision(), 1);
  await assert.rejects(core.dispatch([{ action: 'update', document: { type: 'World', id: 'world' }, intent: 'unregistered', data: {} }]),
    { code: 'unknown_document_intent' });
});

test('queries, returned results and each subscriber receive independent snapshots', async () => {
  const input = state(), errors = [], observed = [];
  const core = session({ initialState: input, onSubscriberError: error => errors.push(error.message) });
  input.preferences.worldV2.name = 'external input mutation';
  const off = core.subscribe(event => { event.state.preferences.worldV2.name = 'subscriber mutation'; event.result.state.preferences.worldV2.name = 'result mutation'; });
  core.subscribe(event => observed.push(event.state.preferences.worldV2.name));
  core.subscribe(() => { throw new Error('subscriber failed'); });
  const result = await core.dispatch(rename('Committed'), { context: { now: NOW } });
  result.state.preferences.worldV2.name = 'public result mutation';
  const query = core.query(value => value.preferences.worldV2); query.name = 'query mutation';
  const world = core.getWorld(); world.name = 'world mutation';
  assert.equal(core.getWorld().name, 'Committed');
  assert.deepEqual(observed, ['Committed']);
  assert.deepEqual(errors, ['subscriber failed']);
  off();
  await core.dispatch(rename('Next'), { context: { now: NOW } });
  assert.deepEqual(observed, ['Committed', 'Next']);
});

test('standalone commands serialize against committed revisions and snapshot a queued write before the caller mutates it', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const saved = [];
  const core = session({ persist: async value => {
    saved.push(value.preferences.worldV2.name);
    if (saved.length === 1) await gate;
    return true;
  } });
  const first = core.dispatch(rename('First'), { baseRevision: 0, context: { now: NOW } });
  const queued = rename('Second');
  const second = core.dispatch(queued, { context: { now: NOW } });
  queued[0].data.name = 'mutated while queued';
  await tick();
  assert.deepEqual(saved, ['First']);
  assert.equal(core.getWorld().name, 'Initial');
  release(); await first; await second;
  assert.deepEqual(saved, ['First', 'Second']);
  assert.equal(core.getWorld().name, 'Second'); assert.equal(core.getRevision(), 2);
  await assert.rejects(core.dispatch(rename('Stale'), { baseRevision: 1 }), { code: 'runtime_revision_conflict' });
  assert.equal(saved.length, 2);
});

test('failed persistence keeps prior state and does not poison later commands', async () => {
  let fail = true;
  const core = session({ persist: async () => !fail });
  await assert.rejects(core.dispatch(rename('Lost')), { code: 'runtime_persistence_failed' });
  assert.equal(core.getWorld().name, 'Initial'); assert.equal(core.getRevision(), 0);
  fail = false; await core.dispatch(rename('Saved'), { baseRevision: 0 });
  assert.equal(core.getWorld().name, 'Saved'); assert.equal(core.getRevision(), 1);
});

test('disposing cancels queued commands, rejects new dispatch and ignores a late authority result', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let notifications = 0, calls = 0;
  const core = session({ authority: { async apply({ state: input, signal }) {
    calls++;
    await gate;
    assert.equal(signal.aborted, true);
    input.preferences.worldV2.name = 'Late';
    return { state: input, results: [] };
  } } });
  core.subscribe(() => notifications++);
  const first = core.dispatch(rename('First')), second = core.dispatch(rename('Second'));
  const rejected = [assert.rejects(first, { code: 'runtime_session_disposed' }), assert.rejects(second, { code: 'runtime_session_disposed' })];
  await tick(); assert.equal(calls, 1);
  core.dispose(); core.dispose();
  await Promise.all(rejected);
  release(); await tick();
  assert.equal(core.getWorld().name, 'Initial'); assert.equal(notifications, 0); assert.equal(calls, 1);
  await assert.rejects(core.dispatch(rename('After disposal')), { code: 'runtime_session_disposed' });
});

test('state synchronization invalidates an in-flight standalone authority result', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const core = session({ authority: { async apply({ state: input }) { await gate; input.preferences.worldV2.name = 'Late'; return { state: input }; } } });
  const pending = core.dispatch(rename('Late'));
  const rejected = assert.rejects(pending, { code: 'runtime_context_changed' });
  await tick();
  const imported = state(); imported.preferences.worldV2.name = 'Imported';
  core.synchronize(imported, { revision: 9 });
  release(); await rejected;
  assert.equal(core.getWorld().name, 'Imported'); assert.equal(core.getRevision(), 9);
});

test('the trusted host adapter reads canonical state without a whole-state command copy and owns background scheduling', async () => {
  const originalClone = globalThis.structuredClone;
  let canonical = state(), hostRevision = 4, copiedCanonical = 0, resolveBackground;
  const gate = new Promise(resolve => { resolveBackground = resolve; });
  globalThis.structuredClone = value => { if (value === canonical) copiedCanonical++; return originalClone(value); };
  try {
    const calls = [];
    const core = createRuntimeSession({ ruleset, mapForScene: () => map,
      getCanonicalState: () => canonical, getCanonicalRevision: () => hostRevision,
      authority: { managesScheduling: true, async apply({ state: input, operations, context }) {
        assert.equal(input, canonical); calls.push(context.source);
        if (context.source === 'background') await gate;
        canonical = { ...canonical, preferences: { ...canonical.preferences,
          worldV2: { ...canonical.preferences.worldV2, name: operations[0].payload.name } } }; hostRevision++;
        return { acknowledged: true };
      } } });
    const background = core.dispatch(rename('Background'), { context: { source: 'background' } });
    await core.dispatch(rename('Movement'), { context: { source: 'foreground' } });
    assert.deepEqual(calls, ['background', 'foreground']);
    assert.equal(copiedCanonical, 0);
    assert.equal(core.getWorld().name, 'Movement');
    resolveBackground(); await background;
    assert.equal(core.getRevision(), 6);
    const detached = core.read(); detached.preferences.worldV2.name = 'outside';
    assert.equal(canonical.preferences.worldV2.name, 'Background');
  } finally { globalThis.structuredClone = originalClone; }
});

test('Runtime sessions inject different Rulesets and map resolvers without global current-rule state', async () => {
  const seen = [];
  const otherRule = { id: 'another-rule', version: '2' };
  const otherMap = { ...map, id: 'another-map' };
  function create(rule, pkg) {
    return session({ ruleset: rule, mapForScene: () => pkg,
      authority: { async apply({ state: input, ruleset: selected, mapForScene }) {
        seen.push([selected.id, mapForScene(input.preferences.worldV2.scenes[0]).id]);
        return { state: input, results: [] };
      } } });
  }
  await create(ruleset, map).dispatch(rename('A'));
  await create(otherRule, otherMap).dispatch(rename('B'));
  assert.deepEqual(seen, [['minimal-rules', 'map'], ['another-rule', 'another-map']]);
});

test('hosted UI revisions remain independent from lower server ACK revisions after hydration', async () => {
  let canonical = state(), uiRevision = 100;
  const observed = [];
  const acknowledgment = { operationId: 'server-1', revision: 1, results: [] };
  const core = createRuntimeSession({ ruleset, mapForScene: () => map,
    getCanonicalState: () => canonical, getCanonicalRevision: () => uiRevision,
    authority: { async apply({ operations }) {
      canonical = { ...canonical, preferences: { ...canonical.preferences,
        worldV2: { ...canonical.preferences.worldV2, name: operations[0].payload.name } } };
      uiRevision += 1;
      return acknowledgment;
    } },
  });
  core.subscribe(event => observed.push(event));
  assert.equal(await core.dispatch(rename('Network committed'), { baseRevision: 100 }), acknowledgment);
  assert.equal(core.getRevision(), 101);
  assert.equal(core.getWorld().name, 'Network committed');
  assert.equal(observed[0].revision, 101);
  assert.equal(observed[0].result.revision, 1);
  const standalone = session({ initialRevision: 5, authority: { async apply({ state: input }) { return { state: input, revision: 4 }; } } });
  await assert.rejects(standalone.dispatch(rename('Rejected')), { code: 'runtime_authority_result_invalid' });
  assert.equal(standalone.getRevision(), 5);
  assert.equal(standalone.getWorld().name, 'Initial');
});
