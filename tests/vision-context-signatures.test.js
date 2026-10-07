import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { sceneVisionContext, releaseVisionContexts } from '../src/vision/context.js';
import { deriveSceneLightSources } from '../src/spatial/kernel.js';

function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
const wall = () => ({ id: 'wall', polygon: [[10, 0], [20, 0], [20, 100], [10, 100]],
  blockingHeightMeters: 8, passableWhenOpen: true });
const scene = () => ({ id: 'scene', featureStates: {}, sceneEvents: [], occlusionShapes: [], tokens: [] });
const map = () => ({ id: 'map', version: '1', width: 200, height: 200, metersPerUnit: 1,
  features: [], visionOccluders: [wall()], lights: [] });

test('500 immutable non-light Token moves reuse light preparation and all real light changes match the full kernel', () => {
  const packageMap = frozen(map());
  const lamp = frozen({ id: 'lamp', placement: 'map', x: 40, y: 20, elevationMeters: 2,
    light: { enabled: true, rangeMeters: 100, intensity: 1.5, elevationOffsetMeters: 3 } });
  let current = frozen({ ...scene(), tokens: [...Array.from({ length: 499 }, (_, index) => ({
    id: `token-${index}`, placement: 'map', x: index, y: 0, light: { enabled: false },
  })), lamp] });
  const stringify = JSON.stringify;
  let lightPreparations = 0;
  JSON.stringify = function (value, ...options) {
    if (Array.isArray(value) && value.some(item => item?.id === 'token-light:lamp')) lightPreparations++;
    return stringify.call(this, value, ...options);
  };
  try {
    const first = sceneVisionContext(packageMap, current);
    for (let i = 0; i < 30; i++) {
      current = frozen({ ...current, tokens: current.tokens.map((token, index) => index === i ? { ...token, x: token.x + 1 } : token) });
      const value = sceneVisionContext(packageMap, current);
      assert.equal(value.lights, first.lights); assert.equal(value.lightVersion, first.lightVersion);
      assert.deepEqual(value.lights, deriveSceneLightSources(packageMap, current));
    }
    assert.equal(lightPreparations, 1);
    for (const patch of [
      { x: 45 }, { elevationMeters: 7 }, { light: { ...lamp.light, intensity: 2, elevationOffsetMeters: 1 } },
      { placement: 'feature' }, { light: { ...lamp.light, enabled: false } },
    ]) {
      const changed = frozen({ ...current, tokens: current.tokens.map(token => token.id === 'lamp' ? { ...lamp, ...patch } : token) });
      const value = sceneVisionContext(packageMap, changed);
      assert.deepEqual(value.lights, deriveSceneLightSources(packageMap, changed));
      assert.notEqual(value.lightVersion, first.lightVersion);
    }
    const restored = sceneVisionContext(packageMap, current);
    assert.deepEqual(restored.lights, first.lights);
    releaseVisionContexts(packageMap);
    assert.equal(sceneVisionContext(packageMap, current).cacheHit, false);
  } finally { JSON.stringify = stringify; releaseVisionContexts(packageMap); }
});

test('mutable and accessor light inputs cannot retain an immutable light preparation', () => {
  const packageMap = map(), current = scene();
  let range = 20;
  const light = Object.freeze({ enabled: true, get rangeMeters() { return range; } });
  current.tokens = Object.freeze([Object.freeze({ id: 'lamp', placement: 'map', x: 10, y: 10, light })]);
  const first = sceneVisionContext(packageMap, current);
  range = 40;
  const changed = sceneVisionContext(packageMap, current);
  assert.equal(changed.lights[0].rangeMeters, 40); assert.notEqual(changed.lightVersion, first.lightVersion);
  packageMap.lights.push({ id: 'map-lamp', x: 30, y: 30, rangeMeters: 60 });
  assert.deepEqual(sceneVisionContext(packageMap, current).lights, deriveSceneLightSources(packageMap, current));
  packageMap.lights[0].x = 50;
  assert.deepEqual(sceneVisionContext(packageMap, current).lights, deriveSceneLightSources(packageMap, current));
  releaseVisionContexts(packageMap);
});

test('deeply frozen map geometry is serialized once across mutable Scene and token changes', () => {
  const packageMap = frozen(map()), mutable = scene();
  const stringify = JSON.stringify;
  let mapSerializations = 0;
  JSON.stringify = function (value, ...options) {
    if (Array.isArray(value) && value[0] === packageMap.features) mapSerializations++;
    return stringify.call(this, value, ...options);
  };
  try {
    const first = sceneVisionContext(packageMap, mutable);
    for (let i = 0; i < 50; i++) {
      mutable.tokens = [{ id: 'source', placement: 'map', x: i, y: 20 }];
      assert.equal(sceneVisionContext(packageMap, mutable).occluders, first.occluders);
    }
    mutable.featureStates.wall = { open: true };
    assert.equal(sceneVisionContext(packageMap, mutable).occluders.length, 0);
    mutable.featureStates.wall = { vision: { blockingHeightMeters: 2 } };
    assert.equal(sceneVisionContext(packageMap, mutable).occluders[0].blockingHeightMeters, 2);
    assert.equal(mapSerializations, 1, 'mutable Scene checks must not re-encode static map geometry');
    releaseVisionContexts(packageMap);
    assert.equal(sceneVisionContext(packageMap, mutable).cacheHit, false);
    assert.equal(mapSerializations, 2, 'release discards the map signature as well as derived geometry');
  } finally { JSON.stringify = stringify; releaseVisionContexts(packageMap); }
});

test('frozen Scene never qualifies mutable nested map geometry for identity reuse', () => {
  const packageMap = map(), immutableScene = frozen(scene());
  packageMap.visionOccluders = Object.freeze(packageMap.visionOccluders);
  const first = sceneVisionContext(packageMap, immutableScene);
  packageMap.visionOccluders[0].polygon[0][0] = 5;
  const moved = sceneVisionContext(packageMap, immutableScene);
  assert.notEqual(moved.geometryVersion, first.geometryVersion);
  assert.equal(moved.occluders[0].polygon[0][0], 5);
  assert.equal(first.occluders[0].polygon[0][0], 10);
  packageMap.visionOccluders[0].blockingHeightMeters = 0;
  assert.equal(sceneVisionContext(packageMap, immutableScene).occluders[0].blockingHeightMeters, 0);
  packageMap.metersPerUnit = 2;
  assert.notEqual(sceneVisionContext(packageMap, immutableScene).geometryVersion, moved.geometryVersion);
  packageMap.visionOccluders = [];
  assert.equal(sceneVisionContext(packageMap, immutableScene).occluders.length, 0);
  releaseVisionContexts(packageMap);
});

test('mutable feature fallback polygons, tags and custom shapes keep invalidating', () => {
  const packageMap = prepareMapPackage({ id: 'public-map', version: '1', width: 200, height: 200,
    layers: ['base'], svg: '<svg></svg>', features: [{ id: 'feature', category: 'building',
      geometry: { points: [[10, 0], [20, 0], [20, 100], [10, 100]] } }] });
  const immutableScene = frozen({ ...scene(), featureStates: { feature: { vision: { occluder: true } } } });
  const first = sceneVisionContext(packageMap, immutableScene);
  packageMap.features[0].geometry.points[0][0] = 5;
  assert.equal(sceneVisionContext(packageMap, immutableScene).occluders[0].polygon[0][0], 5);
  assert.equal(first.occluders[0].polygon[0][0], 10, 'accepted geometry stays detached from mutable callers');
  const mutable = { ...scene(), occlusionShapes: [{ id: 'custom', kind: 'wall',
    points: [[50, 0], [60, 0], [60, 100], [50, 100]] }] };
  const custom = sceneVisionContext(packageMap, mutable);
  mutable.occlusionShapes[0].points[0][0] = 45;
  assert.equal(sceneVisionContext(packageMap, mutable).occluders[0].polygon[0][0], 45);
  mutable.occlusionShapes[0].enabled = false;
  assert.equal(sceneVisionContext(packageMap, mutable).occluders.length, 0);
  assert.equal(custom.occluders[0].polygon[0][0], 50);
  releaseVisionContexts(packageMap);
});

test('frozen accessors, toJSON values and functions cannot qualify an evolving geometry signature', () => {
  for (const mode of ['getter', 'toJSON', 'function']) {
    let height = 8;
    const blocker = mode === 'getter'
      ? Object.freeze({ ...frozen(wall()), get blockingHeightMeters() { return height; } })
      : mode === 'toJSON'
        ? Object.freeze({ ...frozen(wall()), toJSON() { return { ...wall(), blockingHeightMeters: height }; } })
        : Object.freeze({ ...frozen(wall()), extra: Object.freeze(Object.assign(() => {}, { toJSON() { return height; } })) });
    const packageMap = { ...map(), visionOccluders: Object.freeze([blocker]) }, immutableScene = frozen(scene());
    const first = sceneVisionContext(packageMap, immutableScene);
    height = 2;
    const changed = sceneVisionContext(packageMap, immutableScene);
    assert.notEqual(changed.geometryVersion, first.geometryVersion, mode);
    assert.equal(changed.occluders[0].blockingHeightMeters, mode === 'getter' ? 2 : 8, mode);
    releaseVisionContexts(packageMap);
  }
});

test('default JSON loader owns immutable geometry while public adapters leave caller data mutable', async () => {
  let source = await readFile(new URL('../src/map-package/default-map.js', import.meta.url), 'utf8');
  // Node cannot resolve Vite asset URLs. Replace only those imports, so the
  // production fetch/prepare/freeze path itself runs unchanged.
  source = source.replace(/^import runtimeSvgUrl .*;$/m, "const runtimeSvgUrl = '/runtime.svg';")
    .replace(/^import runtimeDataUrl .*;$/m, "const runtimeDataUrl = '/runtime.json';")
    .replace(/^import \{ createLanzhouGeneratedArtAssets \} .*;$/m, 'const createLanzhouGeneratedArtAssets = () => ({});')
    .replace("'./contract.js'", JSON.stringify(new URL('../src/map-package/contract.js', import.meta.url).href));
  const { createDefaultMapPackage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const data = JSON.parse(await readFile(new URL('../reference/maps/lanzhou/runtime.json', import.meta.url), 'utf8'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, status: 200,
    text: async () => '<svg></svg>', json: async () => { assert.equal(url, '/runtime.json'); return data; } });
  try {
    const loaded = await createDefaultMapPackage();
    assert.ok(Object.isFrozen(loaded.features[0].geometry.points[0]));
    assert.ok(Object.isFrozen(loaded.features[0].geometry));
    assert.throws(() => { loaded.features[0].geometry.points[0][0] += 1; }, TypeError);
    const mutable = scene(), stringify = JSON.stringify;
    let mapSerializations = 0;
    JSON.stringify = function (value, ...options) {
      if (Array.isArray(value) && value[0] === loaded.features) mapSerializations++;
      return stringify.call(this, value, ...options);
    };
    try {
      const first = sceneVisionContext(loaded, mutable);
      for (let i = 0; i < 5; i++) assert.equal(sceneVisionContext(loaded, { ...mutable }).occluders, first.occluders);
      assert.equal(mapSerializations, 1, 'real prepared default geometry qualifies for static signature reuse');
    } finally { JSON.stringify = stringify; releaseVisionContexts(loaded); }
  } finally { globalThis.fetch = previousFetch; }
});
