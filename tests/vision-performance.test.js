import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibilityRows, computeVisibilityRowsAsync } from '../src/vision/visibility.js';
import { visibleFogRowsForCircle, circleFogRows, computeFogExplorationAsync, computeFogExploration } from '../src/vision/fog.js';
import { normalizeVisionOccluder, inspectLineOfSight, perceptionLevelAtPoint, resolveLightingAtPoint } from '../src/spatial/kernel.js';
import { sceneVisionContext, releaseVisionContexts } from '../src/vision/context.js';
import { applyWorldOperations, applyWorldOperationsAsync } from '../src/world/operations.js';
import { createVisionBackground } from '../src/vision/background.js';
import { createVisionFogSystem } from '../src/vision/system.js';

const map = { width: 120, height: 120, metersPerUnit: 1 };
const wall = { id: 'wall', featureId: 'wall', polygon: [[40, 10], [60, 10], [60, 90], [40, 90]], blockingHeightMeters: 8, passableWhenOpen: true };
function reference(input) {
  const { source, map, occluders, lights, ignoresOcclusion } = input;
  const rows = (range, precise) => Object.entries(visibleFogRowsForCircle({ x: source.x, y: source.y, radiusMeters: range }, map, {
    sourceElevationMeters: source.elevationMeters,
    occluders: ignoresOcclusion || source.lineOfSightEnabled === false ? [] : occluders,
    predicate: precise ? target => perceptionLevelAtPoint({ vision: source, target, ambient: source.lighting,
      lights, occluders, metersPerUnit: map.metersPerUnit, lineOfSightEnabled: false }) === 'precise' : null,
  }));
  return { precise: rows(source.preciseGroundRangeMeters ?? source.preciseRangeMeters, true),
    vague: rows(source.vagueGroundRangeMeters ?? source.vagueRangeMeters, false) };
}

test('shared visibility matches separate precise/vague calculations across lighting, height and range boundaries', () => {
  let seed = 253;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 90; i++) {
    const input = { map: { ...map, metersPerUnit: i % 2 ? 0.5 : 2 },
      occluders: [wall], lights: [{ x: 80, y: 60, elevationMeters: 3, rangeMeters: 70, intensity: 2 }],
      ignoresOcclusion: i % 7 === 0,
      source: { x: random() * 120, y: random() * 120, elevationMeters: i % 15,
        preciseRangeMeters: i % 6 ? 20 + random() * 150 : 0, vagueRangeMeters: 30 + random() * 180,
        lighting: ['normal', 'dim', 'dark'][i % 3], lineOfSightEnabled: i % 9 !== 0,
        senses: { darkvision: i % 4 === 0, lowLightVision: i % 5 === 0 } } };
    assert.deepEqual(computeVisibilityRows(input), reference(input), `fixture ${i}`);
  }
});

test('concave and reversed rings, holes and ground shadow edges agree with exact rays', () => {
  const outer = [[20, 20], [100, 20], [100, 40], [50, 40], [50, 80], [100, 80], [100, 100], [20, 100]];
  const hole = [[30, 50], [40, 50], [40, 70], [30, 70]];
  for (const reverse of [false, true]) for (const point of [[10, 60], [35, 60], [70, 60], [20, 60], [30, 30]]) {
    for (const elevationMeters of [0, 8, 8.0001, 20]) {
      const occluders = Object.freeze([normalizeVisionOccluder({ polygon: outer, polygons: [[
        reverse ? outer.toReversed() : outer, reverse ? hole.toReversed() : hole,
      ]], blockingHeightMeters: 8 })]);
      const source = { x: point[0], y: point[1], elevationMeters };
      const rows = visibleFogRowsForCircle({ ...source, radiusMeters: 180 }, map, { sourceElevationMeters: elevationMeters, occluders });
      for (let row = 0; row < 24; row++) for (let col = 0; col < 24; col++) {
        assert.equal((rows[row] || []).some(([a, b]) => a <= col && col <= b), inspectLineOfSight({
          from: source, to: { x: col * 5 + 2.5, y: row * 5 + 2.5, elevationMeters: 0 }, occluders,
        }).clear, JSON.stringify({ reverse, point, elevationMeters, row, col }));
      }
    }
  }
});

test('randomized projected shadows match exact rays at every candidate Fog cell', () => {
  let seed = 25253;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const area = { width: 160, height: 160, metersPerUnit: 1 };
  const rectangle = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  for (let fixture = 0; fixture < 40; fixture++) {
    const occluders = Array.from({ length: 1 + fixture % 5 }, (_, index) => {
      const x = random() * 125, y = random() * 125, w = 8 + random() * 25, h = 8 + random() * 25;
      const outer = rectangle(x, y, w, h), hole = rectangle(x + w / 4, y + h / 4, w / 2, h / 2);
      return normalizeVisionOccluder({ id: `obstacle-${index}`, polygon: outer,
        polygons: [[fixture % 2 ? outer : outer.toReversed(), fixture % 3 ? hole : hole.toReversed()]],
        blockingHeightMeters: 4 + random() * 16 });
    });
    const source = { x: random() * 160, y: random() * 160, elevationMeters: fixture % 4 ? random() * 24 : 0 };
    const circle = { x: source.x, y: source.y, radiusMeters: 10 + random() * 130 };
    const actual = visibleFogRowsForCircle(circle, area, { sourceElevationMeters: source.elevationMeters,
      occluders: Object.freeze([...occluders]) });
    const candidates = circleFogRows(circle, area);
    for (const [rowKey, spans] of Object.entries(candidates)) for (const [start, end] of spans) {
      const row = Number(rowKey);
      for (let column = start; column <= end; column++) {
        const clear = inspectLineOfSight({ from: source, to: { x: column * 5 + 2.5,
          y: row * 5 + 2.5, elevationMeters: 0 }, occluders }).clear;
        assert.equal((actual[rowKey] || []).some(([a, b]) => a <= column && column <= b), clear,
          JSON.stringify({ fixture, row, column, source }));
      }
    }
  }
});

test('spatial index retains ordered first hit and scene contexts invalidate without caching audience state', () => {
  const obstacles = Array.from({ length: 20 }, (_, i) => normalizeVisionOccluder({ ...wall, id: `wall-${i}`,
    polygon: wall.polygon.map(([x, y]) => [x + i * 5, y]) }));
  const ray = { from: { x: 0, y: 50 }, to: { x: 200, y: 50 } };
  assert.deepEqual(inspectLineOfSight({ ...ray, occluders: Object.freeze([...obstacles]) }), inspectLineOfSight({ ...ray, occluders: obstacles }));
  const packageMap = { ...map, visionOccluders: [wall] };
  const scene = { id: 'a', featureStates: {}, tokens: [], sceneEvents: [] };
  const first = sceneVisionContext(packageMap, scene);
  assert.equal(first.cacheHit, false);
  assert.equal(sceneVisionContext(packageMap, structuredClone(scene)).occluders, first.occluders);
  scene.featureStates.wall = { open: true };
  assert.equal(sceneVisionContext(packageMap, scene).occluders.length, 0);
  for (let i = 0; i < 20; i++) assert.ok(sceneVisionContext(packageMap, { ...scene, id: `scene-${i}` }).cacheSize <= 2);
  releaseVisionContexts(packageMap);
  assert.equal(sceneVisionContext(packageMap, scene).cacheHit, false);
});

test('frozen outer arrays with mutable geometry or lights never reuse stale spatial results', () => {
  const raw = { id: 'mutable-wall', polygon: [[10, 10], [20, 10], [20, 20], [10, 20]], blockingHeightMeters: 8 };
  const occluders = Object.freeze([raw]);
  const ray = { from: { x: 0, y: 15 }, to: { x: 30, y: 15 }, occluders };
  assert.equal(inspectLineOfSight(ray).clear, false);
  raw.polygon.forEach(point => { point[0] += 100; });
  assert.equal(inspectLineOfSight(ray).clear, true);
  const light = { x: 5, y: 5, elevationMeters: 0, rangeMeters: 30, intensity: 3 };
  const lights = Object.freeze([light]);
  const point = { x: 10, y: 5, elevationMeters: 0 };
  const options = { occluders: Object.freeze([]), metersPerUnit: 1 };
  assert.equal(resolveLightingAtPoint(point, 'dark', lights, options).level, 'normal');
  light.x = 100;
  assert.equal(resolveLightingAtPoint(point, 'dark', lights, options).level, 'dark');
  assert.deepEqual(inspectLineOfSight({ ...ray, occluders: Object.freeze([null]) }), { clear: true, code: 'ok' });
});

test('scene contexts reuse immutable inputs while replacement and shallow freezing invalidate correctly', () => {
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  const packageMap = { ...map, visionOccluders: [wall] };
  const scene = freeze({ id: 'immutable-context', featureStates: {}, sceneEvents: [], tokens: [
    { id: 'lamp', placement: 'map', x: 10, y: 20, light: { enabled: true, rangeMeters: 50 } },
  ] });
  const first = sceneVisionContext(packageMap, scene);
  const repeated = sceneVisionContext(packageMap, { ...scene });
  assert.equal(repeated.occluders, first.occluders);
  assert.equal(repeated.lights, first.lights);
  const moved = sceneVisionContext(packageMap, freeze({ ...scene, tokens: [{ ...scene.tokens[0], x: 30 }] }));
  assert.equal(moved.occluders, first.occluders);
  assert.equal(moved.lights[0].x, 30);
  assert.notEqual(moved.lightVersion, first.lightVersion);
  const opened = sceneVisionContext(packageMap, freeze({ ...scene, featureStates: { wall: { open: true } } }));
  assert.equal(opened.occluders.length, 0);
  const shallow = Object.freeze({ ...scene, featureStates: Object.freeze({ wall: { open: false } }),
    tokens: Object.freeze([{ ...scene.tokens[0] }]) });
  assert.equal(sceneVisionContext(packageMap, shallow).occluders.length, 1);
  shallow.featureStates.wall.open = true; shallow.tokens[0].x = 60;
  const mutated = sceneVisionContext(packageMap, shallow);
  assert.equal(mutated.occluders.length, 0);
  assert.equal(mutated.lights[0].x, 60);
  releaseVisionContexts(packageMap);
  assert.equal(sceneVisionContext(packageMap, scene).cacheHit, false);
});

test('scene context invalidates for destruction, restoration and token light motion', () => {
  const packageMap = { ...map, visionOccluders: [wall] };
  const scene = { id: 'a', featureStates: {}, sceneEvents: [], tokens: [
    { id: 'torch', placement: 'map', x: 10, y: 20, elevationMeters: 1,
      light: { enabled: true, rangeMeters: 40, intensity: 2 } },
  ] };
  const first = sceneVisionContext(packageMap, scene);
  const sight = { x: 20, y: 50, elevationMeters: 0, preciseRangeMeters: 100,
    vagueRangeMeters: 100, lighting: 'normal', lineOfSightEnabled: true };
  const visibleAt = (context, source, column, row) => {
    const rows = Object.fromEntries(computeVisibilityRows({ source, map: packageMap,
      occluders: context.occluders, lights: context.lights }).precise);
    return (rows[String(row)] || []).some(([a, b]) => a <= column && column <= b);
  };
  assert.equal(visibleAt(first, sight, 16, 10), false);
  scene.featureStates.wall = { open: true };
  const opened = sceneVisionContext(packageMap, scene);
  assert.equal(visibleAt(opened, sight, 16, 10), true);
  scene.featureStates.wall = { open: false };
  scene.tokens[0].x = 15;
  const movedLight = sceneVisionContext(packageMap, scene);
  assert.equal(movedLight.occluders.length, first.occluders.length);
  assert.notEqual(movedLight.lightVersion, first.lightVersion);
  assert.equal(movedLight.lights[0].x, 15);
  const darkSight = { x: 20, y: 20, elevationMeters: 0, preciseRangeMeters: 60,
    vagueRangeMeters: 60, lighting: 'dark', senses: {} };
  assert.equal(visibleAt(movedLight, darkSight, 5, 4), true);
  scene.tokens[0].x = 100;
  scene.tokens[0].y = 100;
  const movedFar = sceneVisionContext(packageMap, scene);
  assert.equal(visibleAt(movedFar, darkSight, 5, 4), false);
  scene.sceneEvents = [{ id: 'destroy-wall', type: 'damage', objectIds: ['wall'] }];
  const destroyed = sceneVisionContext(packageMap, scene);
  assert.equal(destroyed.occluders.length, 0);
  assert.notEqual(destroyed.geometryVersion, first.geometryVersion);
  assert.equal(visibleAt(destroyed, sight, 16, 10), true);
  scene.sceneEvents = [{ id: 'destroy-wall', type: 'damage', objectIds: ['wall'] },
    { id: 'restore-wall', type: 'restore', featureIds: ['wall'] }];
  const restored = sceneVisionContext(packageMap, scene);
  assert.equal(restored.occluders.length, 1);
  assert.notEqual(restored.geometryVersion, destroyed.geometryVersion);
  assert.equal(visibleAt(restored, sight, 16, 10), false);
  releaseVisionContexts(packageMap);
});

test('asynchronous exploration yields, cancels and remains identical to synchronous exploration', async () => {
  const input = { partyId: 'party', map, occluders: [wall], lineOfSightEnabled: true,
    payload: { from: { x: 5, y: 5, elevationMeters: 0 }, to: { x: 110, y: 110, elevationMeters: 15 }, radiusMeters: 80 } };
  const expected = computeFogExploration(input);
  assert.deepEqual(await computeFogExplorationAsync(input), expected);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(computeFogExplorationAsync(input, {}, { signal: controller.signal }), { name: 'AbortError' });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    await computeFogExplorationAsync(input, {}, { budgetMs: 0 });
    assert.ok(ticks > 0);
  } finally { clearInterval(timer); }
});

test('non-LOS sweep yields and aborts without changing the authoritative Fog input', async () => {
  const fog = { exploredByParty: { party: { rows: { 0: [[0, 1]] } } } };
  const before = structuredClone(fog);
  const input = { partyId: 'party', map, occluders: [], lineOfSightEnabled: false,
    payload: { from: { x: 0, y: 0 }, to: { x: 110, y: 110 }, radiusMeters: 20 } };
  assert.deepEqual(await computeFogExplorationAsync(input, fog), computeFogExploration(input, fog));
  const controller = new AbortController();
  let yields = 0;
  await assert.rejects(computeFogExplorationAsync(input, fog, { signal: controller.signal,
    budgetMs: 0, yieldTask: async () => { if (++yields === 3) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(yields, 3);
  assert.deepEqual(fog, before);
});

test('async World batches preserve order, atomic errors and input immutability', async () => {
  const state = { preferences: { worldV2: { schemaVersion: 4, id: 'world', activeSceneId: 's', actors: [],
    scenes: [{ id: 's', tokens: [], markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, fog: {}, settings: {} }] } } };
  const before = structuredClone(state);
  const operation = { type: 'scene.fog.explore', payload: { sceneId: 's', partyId: 'p', x: 20, y: 20, radiusMeters: 20 } };
  const operations = [operation, { type: 'scene.fog.reset', payload: { sceneId: 's', partyId: 'p' } }, operation];
  const context = { mapPackage: map, now: '2026-09-26T00:00:00Z' };
  assert.deepEqual(await applyWorldOperationsAsync(state, operations, context), applyWorldOperations(state, operations, context));
  await assert.rejects(applyWorldOperationsAsync(state, [operation, { ...operation, payload: { ...operation.payload, sceneId: 'missing' } }], context));
  assert.deepEqual(state, before);
});

test('background transfers geometry once per version and retransmits after cancellation', async () => {
  const original = globalThis.Worker;
  const messages = [];
  globalThis.Worker = class {
    postMessage(message) { messages.push(message); queueMicrotask(() => this.onmessage({ data: { id: message.id, result: {} } })); }
    terminate() {}
  };
  try {
    const background = createVisionBackground();
    const input = { contextVersion: 1, map, occluders: [wall], source: { x: 10 } };
    await background.run(input);
    await background.run({ ...input, source: { x: 20 } });
    assert.ok(messages[0].input.occluders);
    assert.equal(messages[1].input.occluders, undefined);
    background.cancel();
    await background.run(input);
    assert.ok(messages[2].input.occluders);
    background.dispose();
  } finally { globalThis.Worker = original; }
});

function createVisionCanvasFixture() {
  const frames = [];
  const handlers = new Map();
  let sizeReads = 0, rects = 0, nextFrame = 0;
  const toasts = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'fillRect', 'save', 'restore',
    'beginPath', 'rect', 'clip', 'drawImage', 'arc', 'fill'].map(name => [name, () => {}]));
  context.fillRect = () => { rects++; };
  const documentNode = { defaultView: { requestAnimationFrame(callback) { frames.push(callback); return frames.length; } },
    createElement() { return { style: {}, dataset: {}, setAttribute() {}, remove() {},
      getContext: () => context }; } };
  const pane = { style: {}, append() {} };
  const scene = { id: 's', tokens: [{ id: 'scout', actorId: 'actor', placement: 'map', x: 20, y: 20 }],
    featureStates: {}, sceneEvents: [], fog: {} };
  const state = { preferences: { worldV2: { activeSceneId: 's', actors: [{ id: 'actor' }], scenes: [scene] } } };
  const api = { mapPackage: map, map: { getContainer: () => ({ ownerDocument: documentNode }),
    getPane: () => pane, on() {}, off() {}, getSize() { sizeReads++; return { x: 100, y: 100 }; },
    latLngToContainerPoint: point => ({ x: point.lng, y: map.height - point.lat }),
    containerPointToLayerPoint: point => ({ x: point[0], y: point[1] }) },
    getState: () => state, getStateRevision: () => 1,
    ruleset: { vision: { describe: () => ({ preciseRangeMeters: 60, vagueRangeMeters: 80 }) } },
    showToast(message) { toasts.push(message); },
    on(name, callback) { const listeners = handlers.get(name) || []; listeners.push(callback); handlers.set(name, listeners);
      return () => handlers.set(name, listeners.filter(item => item !== callback)); },
    emit(name, detail) { for (const callback of handlers.get(name) || []) callback(detail); } };
  createVisionFogSystem().register(api);
  return { api, frames, toasts,
    get sizeReads() { return sizeReads; }, get rects() { return rects; },
    flushFrame() { assert.ok(frames[nextFrame]); frames[nextFrame++](); },
    dispose() { api.emit('app:destroy'); } };
}

test('asynchronous visibility yields through shadow, fallback ray and lighting phases', async () => {
  const input = { source: { x: 30, y: 40, elevationMeters: 4, preciseRangeMeters: 90,
    vagueRangeMeters: 100, lighting: 'dark', senses: { lowLightVision: false, darkvision: false } },
    map, occluders: [wall], lights: [{ x: 20, y: 40, elevationMeters: 3, rangeMeters: 80, intensity: 2 }] };
  for (const x of [30, 40]) {
    const value = { ...input, source: { ...input.source, x } };
    let yields = 0;
    assert.deepEqual(await computeVisibilityRowsAsync(value, { budgetMs: 0,
      yieldTask: async () => { yields++; } }), computeVisibilityRows(value));
    assert.ok(yields > 10, `x=${x} must yield across rows`);
  }
  const controller = new AbortController();
  let yields = 0;
  await assert.rejects(computeVisibilityRowsAsync(input, { signal: controller.signal, budgetMs: 0,
    yieldTask: async () => { if (++yields === 35) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(yields, 35);
});

test('source changes coalesce Canvas rendering and cancel source/scene Worker results', async () => {
  const previousWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { this.terminated = false; workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
  };
  try {
    const fixture = createVisionCanvasFixture();
    const { api, frames } = fixture;
    await api.vision.setSource('scout');
    assert.equal(fixture.sizeReads, 0);
    assert.equal(frames.length, 1);
    await api.vision.setSource(null);
    assert.equal(frames.length, 1);
    fixture.flushFrame();
    assert.equal(fixture.sizeReads, 0);
    await api.vision.setSource('scout');
    fixture.flushFrame();
    assert.equal(workers.length, 1);
    assert.equal(fixture.sizeReads, 1);
    await api.vision.setSource(null);
    assert.equal(workers[0].terminated, true);
    const scheduledAfterSource = frames.length;
    workers[0].onmessage({ data: { id: workers[0].message.id, result: { precise: [['0', [[0, 20]]]], vague: [] } } });
    assert.equal(frames.length, scheduledAfterSource);
    await api.vision.setSource('scout');
    fixture.flushFrame();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workers.length, 2);
    api.emit('scene:activate');
    assert.equal(workers[1].terminated, true);
    const scheduledAfterScene = frames.length;
    workers[1].onmessage({ data: { id: workers[1].message.id, result: { precise: [['0', [[0, 20]]]], vague: [] } } });
    assert.equal(frames.length, scheduledAfterScene);
    fixture.dispose();
  } finally { globalThis.Worker = previousWorker; }
});

test('missing or failing Worker uses asynchronous main-thread visibility and displays its result', async () => {
  const previousWorker = globalThis.Worker;
  try {
    for (const mode of ['missing', 'failure']) {
      let terminated = 0;
      globalThis.Worker = mode === 'missing' ? undefined : class {
        postMessage() { throw new Error('Worker unavailable'); }
        terminate() { terminated++; }
      };
      const fixture = createVisionCanvasFixture();
      await fixture.api.vision.setSource('scout');
      fixture.flushFrame();
      const before = fixture.rects;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fixture.frames.length, 1, `${mode}: completed mask needs no extra RAF`);
      assert.ok(fixture.rects > before, mode);
      assert.equal(fixture.api.vision.getFeedbackState()?.rendered, true, mode);
      assert.deepEqual(fixture.toasts, []);
      assert.equal(terminated, mode === 'failure' ? 1 : 0);
      fixture.dispose();
    }
  } finally { globalThis.Worker = previousWorker; }
});
