import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldStatePersistence, createRemoteWorldIsolation } from '../src/app/world-storage.js';
import { createInitialRuntimeState, validateRuntimeState } from '../src/engine/runtime-state.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';

const mapPackage = { id: 'isolation-map', version: '1', width: 100, height: 100, metersPerUnit: 1, features: [] };
function fixture() {
  const storage = new Map();
  const seed = createInitialRuntimeState(mapPackage, { ruleset });
  const world = createWorldV2FromRuntimeState(seed, { mapPackage, ruleset });
  let state = validateRuntimeState(projectWorldV2ToRuntimeState(seed, world, { mapPackage, ruleset }), { mapPackage, ruleset });
  const local = structuredClone(state);
  const persistence = createWorldStatePersistence({ mapPackage, ruleset, getState: () => state,
    storageAdapter: { get: key => storage.get(key), set: (key, value) => storage.set(key, value) } });
  const jobs = { schemaVersion: 1, jobs: [{ id: 'confirmed-route', sceneId: world.activeSceneId,
    input: { partyId: 'party', payload: { from: { x: 10, y: 10 }, to: { x: 40, y: 10 } } } }] };
  persistence.setLocalExploration(jobs);
  persistence.persistNow();
  const isolation = createRemoteWorldIsolation({ persistence, getState: () => state,
    restoreState: value => { state = value; } });
  return { storage, local, jobs, persistence, isolation,
    state: () => state, overlay(value) { state = value; } };
}
const saved = fixture => fixture.storage.get(fixture.persistence.storageKey);

test('joining LAN preserves confirmed offline jobs and prevents a private projection overwriting the local key', () => {
  const value = fixture(), before = saved(value);
  value.persistence.schedule();
  value.isolation.updateConnection({ connected: true, retainsServerState: true });
  const projection = structuredClone(value.local);
  projection.preferences.worldV2.name = 'Private server projection';
  value.overlay(projection);
  assert.equal(value.persistence.suspended, true);
  assert.equal(value.persistence.schedule(), false);
  assert.equal(value.persistence.persistNow(), false);
  assert.equal(value.persistence.persistTrustedNow(), false);
  assert.throws(() => value.persistence.replace(projection), { code: 'world_persistence_suspended' });
  assert.equal(saved(value), before);
  assert.deepEqual(value.persistence.getLocalExploration(), value.jobs);
  assert.deepEqual(JSON.parse(saved(value))._localExploration, value.jobs);
});

test('an unexpected disconnect retains the server delta baseline while local persistence stays isolated', () => {
  const value = fixture(), before = saved(value);
  value.isolation.updateConnection({ connected: true, retainsServerState: true });
  const projection = structuredClone(value.local);
  projection.preferences.worldV2.name = 'Server revision 1';
  value.overlay(projection);
  assert.equal(value.isolation.updateConnection({ connected: false, retainsServerState: true }), false);
  assert.equal(value.state(), projection);
  assert.equal(value.persistence.persistNow(), false);
  value.isolation.updateConnection({ connected: true, retainsServerState: true });
  const resumed = { ...value.state(), preferences: { ...value.state().preferences,
    worldV2: { ...value.state().preferences.worldV2, name: 'Server revision 2' } } };
  value.overlay(resumed);
  assert.equal(value.state().preferences.worldV2.name, 'Server revision 2');
  assert.equal(saved(value), before);
  assert.equal(value.isolation.updateConnection({ connected: false, retainsServerState: false }), true);
  assert.deepEqual(value.state(), value.local, 'reconnect replaced the original offline baseline');
});

test('explicit LAN exit restores the local World before permitting its retained queue to save again', () => {
  const value = fixture();
  value.isolation.updateConnection({ connected: true, retainsServerState: true });
  const projection = structuredClone(value.local);
  projection.preferences.worldV2.name = 'Private server projection';
  value.overlay(projection);
  assert.equal(value.isolation.updateConnection({ connected: false, retainsServerState: false }), true);
  assert.equal(value.isolation.active, false);
  assert.equal(value.persistence.suspended, false);
  assert.deepEqual(value.state(), value.local);
  assert.deepEqual(value.persistence.getLocalExploration(), value.jobs);
  assert.equal(value.persistence.persistNow(), true);
  assert.equal(JSON.parse(saved(value)).preferences.worldV2.name, value.local.preferences.worldV2.name);
  assert.deepEqual(JSON.parse(saved(value))._localExploration, value.jobs);
});
