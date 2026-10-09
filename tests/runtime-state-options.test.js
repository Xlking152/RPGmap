import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as current from '../src/engine/runtime-state.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';

// Frozen public generator entry from the HEAD before prepared continuations.
// Shared helpers are unchanged; this oracle never calls the new prefix or
// continuation, so their option-reading order is independently constrained.
const oldEntry = `function* validateRuntimeStateSteps(raw, { mapPackage, ruleset } = {}) {
  let source = object(raw, 'state');
  const metadata = mapMetadata(mapPackage);
  const hasCanonicalWorld = Boolean(source.preferences?.[WORLD_STATE_KEY]);
  if (hasCanonicalWorld) {
    assertPersistedWorldV2(source.preferences[WORLD_STATE_KEY], {
      acceptedSchemaVersions: [2, 3, WORLD_SCHEMA_VERSION],
    });
    if (!isPlainObject(source)) throw new TypeError('Feature State migration requires a state object');
    const hasLegacy = isPlainObject(source.preferences)
      && (Object.hasOwn(source.preferences, FEATURE_STATE_KEY)
        || Object.hasOwn(source.preferences, LEGACY_FEATURE_INTERACTION_STATE_KEY));
    source = migrateDetachedWorldSchema4State(migrateDetachedLegacySceneFeatureStates(clone(source), { hasLegacy }).state, {
      statusDefinitions: ruleset?.statuses?.definitions,
    }).state;
    yield 'migration';
  }
  const mapId = hasCanonicalWorld ? metadata.id : String(source.mapId ?? metadata.id).trim();
  const mapVersion = hasCanonicalWorld ? metadata.version : String(source.mapVersion ?? metadata.version).trim();
  if (mapId !== metadata.id) throw new TypeError('state.mapId does not match MapPackage');
  if (mapVersion !== metadata.version) throw new TypeError('state.mapVersion does not match MapPackage');
  const { markers: _markers, attackAreas: _areas, sceneEvents: _events, preferences: _preferences,
    ...metadataFields } = source;
  if (_preferences && (typeof _preferences !== 'object' || Array.isArray(_preferences))) clone(_preferences);
  const copiedMetadata = clone(metadataFields);
  let next = {
    ...Object.fromEntries(Object.keys(source).map(key => [key, copiedMetadata[key]])),
    saveVersion: RUNTIME_SAVE_VERSION,
    mapId,
    mapVersion,
    markers: cleanMarkers(source.markers ?? []),
    attackAreas: cleanAttackAreas(source.attackAreas ?? []),
    sceneEvents: cleanSceneEvents(source.sceneEvents ?? []),
    preferences: cleanPreferences(source.preferences, ruleset, { normalizeCanonicalWorld: hasCanonicalWorld }),
  };
  delete next.characters;
  delete next._localExploration;
  yield 'runtime-content';
  const rawWorld = next.preferences?.[WORLD_STATE_KEY];
  if (rawWorld) {
    assertWorldRuleset(rawWorld, ruleset);
    next = projectWorldV2ToRuntimeState(next, rawWorld, { mapPackage, ruleset });
    next.markers = cleanMarkers(next.markers ?? []);
    next.attackAreas = cleanAttackAreas(next.attackAreas ?? []);
    next.sceneEvents = cleanSceneEvents(next.sceneEvents ?? []);
    delete next.characters;
  }
  return next;
}

`;
const sourceUrl = new URL('../src/engine/runtime-state.js', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const withOldEntry = source.replace(/function\* validateRuntimeStateSteps\([\s\S]*?(?=export function validateRuntimeState\()/, oldEntry);
assert.notEqual(withOldEntry, source, 'the independent old entry must replace the current entry');
const oracleSource = withOldEntry.replace(/from (['"])(\.[^'"]+)\1/g,
  (_match, _quote, relative) => `from ${JSON.stringify(new URL(relative, sourceUrl).href)}`);
const original = await import(`data:text/javascript;base64,${Buffer.from(oracleSource).toString('base64')}`);
const methods = ['validateRuntimeState', 'exportRuntimeState', 'exportRuntimeStateAsync'];

async function run(api, method, setup) {
  const input = setup();
  try {
    const value = await api[method](input.state, input.options, { budgetMs: 0, yieldTask: async () => {}, ...input.scheduler });
    return { calls: input.calls, output: JSON.stringify(value) };
  } catch (error) {
    return { calls: input.calls, error: { name: error.name, message: error.message, code: error.code } };
  }
}

function fixture() {
  return { state: worldCopyInput().state, calls: [] };
}

test('public raw validators read inherited options getters and Proxy properties exactly once before raw clone getters', async () => {
  for (const method of methods) for (const kind of ['getters', 'class', 'proxy']) {
    const setup = () => {
      const input = fixture();
      Object.defineProperty(input.state.extension, 'observed', { enumerable: true, get() { input.calls.push('raw'); return 'kept'; } });
      const getters = {
        get mapPackage() { input.calls.push('mapPackage'); return copyMap; },
        get ruleset() { input.calls.push('ruleset'); return copyRuleset; },
      };
      input.options = kind === 'class' ? new (class {
        get mapPackage() { return getters.mapPackage; }
        get ruleset() { return getters.ruleset; }
      })() : kind === 'proxy' ? new Proxy({ mapPackage: copyMap, ruleset: copyRuleset }, {
        get(target, key, receiver) { input.calls.push(String(key)); return Reflect.get(target, key, receiver); },
      }) : getters;
      return input;
    };
    const expected = await run(original, method, setup);
    assert.deepEqual(expected.calls, ['mapPackage', 'ruleset', 'raw']);
    assert.ok(expected.output);
    assert.deepEqual(await run(current, method, setup), expected, `${method}/${kind}`);
  }
});

test('one map getter result controls both metadata and canonical projection', async () => {
  for (const method of methods) {
    const setup = () => {
      const input = fixture(); let reads = 0;
      input.options = {
        get mapPackage() { input.calls.push('mapPackage'); return ++reads === 1 ? copyMap : { ...copyMap, id: 'wrong-second-map' }; },
        get ruleset() { input.calls.push('ruleset'); return copyRuleset; },
      };
      return input;
    };
    const expected = await run(original, method, setup);
    assert.deepEqual(expected.calls, ['mapPackage', 'ruleset']);
    assert.ok(expected.output);
    assert.deepEqual(await run(current, method, setup), expected, method);
  }
});

test('option getter errors retain priority over raw clone getters, unsupported values and invalid raw containers', async () => {
  for (const method of methods) for (const kind of ['raw-getter', 'uncloneable', 'invalid-raw', 'map-error']) {
    const setup = () => {
      const input = fixture();
      if (kind === 'raw-getter') Object.defineProperty(input.state.extension, 'observed', { enumerable: true,
        get() { input.calls.push('raw'); throw new Error('raw getter failed'); } });
      if (kind === 'uncloneable') input.state.extension.uncloneable = () => {};
      if (kind === 'invalid-raw' || kind === 'map-error') input.state = null;
      input.options = {
        get mapPackage() { input.calls.push('mapPackage'); if (kind === 'map-error') throw new Error('map option failed'); return copyMap; },
        get ruleset() { input.calls.push('ruleset'); throw new Error('ruleset option failed'); },
      };
      return input;
    };
    const expected = await run(original, method, setup);
    assert.deepEqual(expected.calls, kind === 'map-error' ? ['mapPackage'] : ['mapPackage', 'ruleset']);
    assert.equal(expected.error.message, kind === 'map-error' ? 'map option failed' : 'ruleset option failed');
    assert.deepEqual(await run(current, method, setup), expected, `${method}/${kind}`);
  }
});

test('async options are read before an already aborted scheduler, preserving the original exception priority', async () => {
  for (const throws of [false, true]) {
    const setup = () => {
      const input = fixture(), controller = new AbortController();
      controller.abort(new Error('cancelled before input reads'));
      input.scheduler = { signal: controller.signal };
      input.options = {
        get mapPackage() { input.calls.push('mapPackage'); return copyMap; },
        get ruleset() { input.calls.push('ruleset'); if (throws) throw new Error('ruleset option failed'); return copyRuleset; },
      };
      return input;
    };
    const expected = await run(original, 'exportRuntimeStateAsync', setup);
    assert.deepEqual(expected.calls, ['mapPackage', 'ruleset']);
    assert.equal(expected.error.message, throws ? 'ruleset option failed' : 'cancelled before input reads');
    assert.deepEqual(await run(current, 'exportRuntimeStateAsync', setup), expected);
  }
});

test('prepared continuation retains old public results, key order and errors for legacy schemas and class or unsupported inputs', async () => {
  for (const method of methods) for (const kind of ['schema-2', 'schema-3', 'ordered', 'canonical-class', 'noncanonical-class', 'uncloneable']) {
    const setup = () => {
      const input = fixture();
      if (kind === 'schema-2' || kind === 'schema-3') input.state.preferences.worldV2.schemaVersion = Number(kind.slice(-1));
      if (kind === 'ordered') input.state = { z: 1, ...input.state, a: 2 };
      if (kind === 'canonical-class' || kind === 'noncanonical-class') {
        if (kind === 'noncanonical-class') delete input.state.preferences.worldV2;
        input.state = Object.assign(new (class RuntimeState {})(), input.state);
      }
      if (kind === 'uncloneable') input.state.extension.uncloneable = () => {};
      input.options = { get mapPackage() { input.calls.push('mapPackage'); return copyMap; },
        get ruleset() { input.calls.push('ruleset'); return copyRuleset; } };
      return input;
    };
    const expected = await run(original, method, setup);
    assert.deepEqual(expected.calls, ['mapPackage', 'ruleset']);
    assert.deepEqual(await run(current, method, setup), expected, `${method}/${kind}`);
  }
});
