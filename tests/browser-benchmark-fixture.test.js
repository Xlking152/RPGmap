import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapPackageStore } from '../deployment/local-server/package-store.mjs';
import { normalizeWorldV2, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { normalizeMovementState } from '../src/movement/model.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS as definitions } from '../src/rulesets/infinite-horror/statuses.js';
import { createRawBrowserBenchmarkFixture, createBrowserBenchmarkFixture,
  BROWSER_BENCHMARK_TIMESTAMP } from '../scripts/browser-benchmark-fixture.mjs';
import { hostedBrowserRuntime } from './helpers/hosted-browser-runtime.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
const mapReference = { id: 'northern-song-lanzhou-1104', version: '1.1.0' };
let directory, mapPackage;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-browser-fixture-'));
  // Use the complete production exporter and immutable installed package,
  // including its actual SVG/resources, rather than a geometry-only stand-in.
  const exported = path.join(directory, 'exported');
  await execute(process.execPath, [path.join(root, 'scripts/export-map-packages.mjs'), '--out', exported],
    { cwd: root, timeout: 30_000, windowsHide: true });
  const store = await new MapPackageStore({ root: path.join(directory, 'installed') }).initialize();
  const receipt = await store.install(await readFile(path.join(exported, '北宋兰州城-1.1.0.rpgmap')));
  mapPackage = store.get(mapReference);
  assert.equal(mapPackage.fingerprint, receipt.fingerprint);
  assert.equal(mapPackage.fingerprint, '9a8de38844f6b6f5e528d507bf38bd134045d27f24c948f1e82ad1c0ea87c947');
  assert.equal(mapPackage.features.length, 103);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const writes = socket => socket.messages.filter(message =>
  ['world.push', 'world.operation', 'document.batch'].includes(message.type));

test('the original 100 Actor / 500 Token browser input reproduces Actor defaults at the real hosted welcome boundary', async t => {
  const raw = createRawBrowserBenchmarkFixture(definitions), original = structuredClone(raw);
  assert.equal(raw.preferences.worldV2.actors.length, 100);
  assert.equal(raw.preferences.worldV2.scenes[0].tokens.length, 500);
  for (const actor of raw.preferences.worldV2.actors) {
    assert.deepEqual(actor.system, {});
    for (const field of ['createdAt', 'updatedAt', 'prototypeToken', 'publicProfile']) assert.equal(Object.hasOwn(actor, field), false);
  }
  const { api, socket } = await hostedBrowserRuntime(t, { initialState: raw, loadedMapPackage: mapPackage });
  assert.equal(api.multiplayer.getStatus().connected, true);
  const observed = api.world.get();
  assert.notDeepEqual(observed, raw.preferences.worldV2,
    'the original incomplete fixture must reproduce the actual whole-World readiness failure');
  const actor = observed.actors[0];
  assert.notDeepEqual(actor.system, {});
  assert.equal(typeof actor.prototypeToken, 'object');
  assert.equal(typeof actor.publicProfile, 'object');
  assert.equal(typeof actor.createdAt, 'string');
  assert.equal(typeof actor.updatedAt, 'string');
  assert.equal(observed.actors.length, 100);
  assert.equal(observed.scenes[0].tokens.length, 500);
  assert.deepEqual(writes(socket), [], 'reading a hosted projection must not repair it by submitting writes');
  assert.deepEqual(raw, original, 'the original source fixture is preserved verbatim for regression');
});

test('preparing the fixture preserves every original Token field, coordinates, vision and movement workload', () => {
  const raw = createRawBrowserBenchmarkFixture(definitions);
  const prepared = createBrowserBenchmarkFixture({ mapPackage, ruleset, definitions });
  const world = prepared.preferences.worldV2, rawWorld = raw.preferences.worldV2;
  assert.equal(world.actors.length, 100);
  assert.equal(world.scenes[0].tokens.length, 500);
  for (let index = 0; index < 500; index++) {
    const actual = world.scenes[0].tokens[index], expected = rawWorld.scenes[0].tokens[index];
    for (const [field, value] of Object.entries(expected)) {
      // The production movement contract supplies the absent no-turn default.
      // All declared movement values remain exact; no field is dropped.
      assert.deepEqual(actual[field], field === 'movement' ? normalizeMovementState(value) : value, `Token ${index}.${field}`);
    }
    assert.equal(actual.movement.turnKey, null);
    for (const [field, value] of Object.entries(expected.movement)) assert.deepEqual(actual.movement[field], value);
  }
  for (let index = 0; index < 100; index++) {
    const actual = world.actors[index], expected = rawWorld.actors[index];
    for (const field of ['id', 'name', 'type', 'partyId', 'effects', 'notes', 'ownership']) assert.deepEqual(actual[field], expected[field]);
    assert.equal(actual.createdAt, BROWSER_BENCHMARK_TIMESTAMP);
    assert.equal(actual.updatedAt, BROWSER_BENCHMARK_TIMESTAMP);
  }
  assert.deepEqual(normalizeWorldV2(world, { mapPackage, ruleset }), world, 'the complete World is already canonical');
  assert.deepEqual(projectWorldV2ToRuntimeState(prepared, world, { mapPackage, ruleset }), prepared,
    'normalization and projection are both idempotent, including non-World fields');
  assert.deepEqual(createBrowserBenchmarkFixture({ mapPackage, ruleset, definitions }), prepared,
    'repeated fixture preparation cannot create new timestamps or random defaults');
});

test('the canonical full fixture remains exactly identical through real hosted welcome and repeated snapshot reads with no writes', async t => {
  const state = createBrowserBenchmarkFixture({ mapPackage, ruleset, definitions }), original = structuredClone(state);
  const { api, socket, settle } = await hostedBrowserRuntime(t, { initialState: state, loadedMapPackage: mapPackage });
  assert.equal(api.multiplayer.getStatus().connected, true);
  assert.equal(api.multiplayer.getStatus().applyingRemote, false);
  assert.deepEqual(api.world.get(), state.preferences.worldV2,
    'compare every World field; do not exclude Actor defaults, timestamps or rule data');
  for (let index = 0; index < 3; index++) {
    await socket.receive({ type: 'world.snapshot', revision: 40 + index, state: structuredClone(state) });
    await settle();
    assert.deepEqual(api.world.get(), state.preferences.worldV2);
    assert.deepEqual(api.exportState().preferences.worldV2, state.preferences.worldV2);
  }
  assert.deepEqual(writes(socket), []);
  assert.deepEqual(state, original, 'hosted import does not mutate the caller-owned canonical input');
});

test('fixture preparation rejects a different map, rule or invalid Token count instead of silently substituting content', () => {
  const input = { mapPackage, ruleset, definitions };
  for (const invalid of [
    { mapPackage: { ...mapPackage, version: '2' } }, { mapPackage: { ...mapPackage, id: 'other-map' } },
    { ruleset: { ...ruleset, id: 'other-rule' } }, { ruleset: { ...ruleset, version: '2' } },
    { tokenCount: 0 }, { tokenCount: 501 }, { tokenCount: 1.5 },
  ]) assert.throws(() => createBrowserBenchmarkFixture({ ...input, ...invalid }));
});
