import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneVisionContext, releaseVisionContexts } from '../src/vision/context.js';
import { sceneVisionContext as oldContext, releaseVisionContexts as releaseOld } from './fixtures/vision-context-before-light-proof.js';
import { deriveSceneLightSources } from '../src/spatial/kernel.js';

function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
const map = () => frozen({ id: 'map', width: 100, height: 100, metersPerUnit: 1,
  features: [], visionOccluders: [], occlusionShapes: [], lights: [] });
const lamp = (id = 'lamp', x = 10) => frozen({ id, placement: 'map', x, y: 20,
  light: { enabled: true, rangeMeters: 50 } });
const scene = tokens => frozen({ id: 'scene', featureStates: {}, sceneEvents: [], occlusionShapes: [], tokens });
function countPreparations(callback) {
  const original = JSON.stringify; let calls = 0;
  JSON.stringify = function (value, ...options) {
    if (Array.isArray(value) && value.some(item => String(item?.id || '').startsWith('token-light:'))) calls++;
    return original.call(this, value, ...options);
  };
  try { callback(); return calls; } finally { JSON.stringify = original; }
}

test('canonical to mutable to canonical non-light movement preserves lights and avoids one repeated preparation', () => {
  const packageMap = map(), light = lamp(), initial = scene([light, { id: 'ordinary', placement: 'map', x: 1, y: 1 }]);
  const moved = frozen({ ...initial, tokens: [light, { ...initial.tokens[1], x: 5 }] });
  const sequence = [initial, structuredClone(initial), moved], actual = [], expected = [];
  const oldCalls = countPreparations(() => { for (const state of sequence) expected.push(oldContext(packageMap, state)); });
  const calls = countPreparations(() => { for (const state of sequence) actual.push(sceneVisionContext(packageMap, state)); });
  assert.equal(oldCalls, 3); assert.equal(calls, 2);
  for (let index = 0; index < sequence.length; index++) {
    assert.deepEqual(actual[index].lights, expected[index].lights);
    assert.equal(actual[index].lightKey, expected[index].lightKey);
    assert.equal(actual[index].lightVersion, actual[0].lightVersion);
  }
  assert.equal(actual[2].lights, actual[0].lights);
  releaseVisionContexts(packageMap); releaseOld(packageMap);
});

test('a mutable light change cannot reuse the old proof or override the current light version', () => {
  const packageMap = map(), light = lamp(), initial = scene([light]), changed = structuredClone(initial);
  changed.tokens[0].x = 40;
  const states = [initial, changed, initial, { ...initial, tokens: [] }, initial];
  for (const state of states) {
    const actual = sceneVisionContext(packageMap, state), expected = oldContext(packageMap, state);
    assert.deepEqual(actual.lights, expected.lights);
    assert.equal(actual.lightKey, expected.lightKey);
    assert.deepEqual(actual.lights, deriveSceneLightSources(packageMap, state));
  }
  releaseVisionContexts(packageMap); releaseOld(packageMap);
});

test('light order, document replacement, height, disabled state and cache release match the old context', () => {
  const packageMap = map(), first = lamp(), second = lamp('second', 30);
  for (const state of [scene([first, second]), { ...scene([first, second]), tokens: [first, second] },
    scene([second, first]), scene([frozen({ ...first, elevationMeters: 8 }), second]),
    scene([frozen({ ...first, light: { ...first.light, enabled: false } }), second]), scene([first, second])]) {
    const actual = sceneVisionContext(packageMap, state), expected = oldContext(packageMap, state);
    assert.deepEqual(actual.lights, expected.lights); assert.equal(actual.lightKey, expected.lightKey);
  }
  releaseVisionContexts(packageMap);
  assert.equal(sceneVisionContext(packageMap, scene([first, second])).cacheHit, false);
  releaseVisionContexts(packageMap); releaseOld(packageMap);
});

test('accessor owners and mutable light documents keep complete preparation after an immutable interlude', () => {
  const packageMap = map(), light = lamp(), initial = scene([light]); let reads = 0;
  const accessor = Object.freeze({ ...initial, get tokens() { reads++; return initial.tokens; } });
  const calls = countPreparations(() => {
    sceneVisionContext(packageMap, initial);
    sceneVisionContext(packageMap, structuredClone(initial));
    assert.deepEqual(sceneVisionContext(packageMap, accessor).lights, deriveSceneLightSources(packageMap, accessor));
  });
  assert.equal(calls, 3); assert.ok(reads > 0);
  let range = 20;
  const mutable = { ...initial, tokens: Object.freeze([Object.freeze({ id: 'dynamic', placement: 'map', x: 10, y: 10,
    light: Object.freeze({ enabled: true, get rangeMeters() { return range; } }) })]) };
  assert.equal(sceneVisionContext(packageMap, mutable).lights[0].rangeMeters, 20);
  range = 40; assert.equal(sceneVisionContext(packageMap, mutable).lights[0].rangeMeters, 40);
  releaseVisionContexts(packageMap); releaseOld(packageMap);
});
