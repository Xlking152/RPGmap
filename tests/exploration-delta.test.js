import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFogExplorationAsync, mergeExploration, normalizeFogState, hideFogCircle } from '../src/vision/fog.js';
import { computeFogExplorationDeltaAsync } from '../src/vision/exploration-delta.js';
import { createLocalExplorationQueue } from '../src/vision/local-exploration.js';

const map = { width: 100, height: 100, metersPerUnit: 1 };
const rectangle = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
const wall = (extra = {}) => ({ id: 'wall', kind: 'wall', polygon: rectangle(40, 10, 5, 80), blockingHeightMeters: 3, ...extra });
const input = (extra = {}) => ({ partyId: 'party', map, occluders: [], lineOfSightEnabled: true,
  payload: { x: 25, y: 50, radiusMeters: 40 }, ...extra });
const history = rows => ({ schemaVersion: 1, cellSizeMeters: 5, note: { kept: true }, exploredByParty: {
  party: { rows, name: 'Party memory' }, other: { rows: { 1: [[1, 4]] }, private: 'unchanged' },
} });
const cells = rows => new Set(Object.entries(rows).flatMap(([row, spans]) => spans.flatMap(([a, b]) =>
  Array.from({ length: b - a + 1 }, (_, index) => `${row}:${a + index}`))));

async function compareUnion(request, fog) {
  const partyId = String(request.partyId).trim().slice(0, 80);
  const before = structuredClone({ request, fog });
  const normalized = normalizeFogState(fog, request.map);
  // The old calculation starts with no history and never consumes exploredRows.
  const oldAdded = await computeFogExplorationAsync(request, {}, { budgetMs: Infinity });
  const known = normalized.exploredByParty[partyId]?.rows || {};
  const delta = await computeFogExplorationDeltaAsync({ ...request, exploredRows: known }, { budgetMs: Infinity });
  assert.deepEqual(mergeExploration(fog, delta, request.map), mergeExploration(fog, oldAdded, request.map));
  const oldCells = cells(oldAdded.exploredByParty[partyId].rows), knownCells = cells(known);
  assert.deepEqual(cells(delta.exploredByParty[partyId].rows), new Set([...oldCells].filter(cell => !knownCells.has(cell))));
  assert.deepEqual({ request, fog }, before, 'borrowed confirmed Fog and geometry stay unchanged');
  return delta;
}

test('circle deltas preserve the old union for heights, wall interiors, holes, fragments, hosts and xray', async () => {
  const hole = { id: 'hole', kind: 'building', polygon: rectangle(20, 20, 60, 60), blockingHeightMeters: 8,
    polygons: [[rectangle(20, 20, 60, 60), rectangle(35, 35, 30, 30).reverse()]] };
  const fragment = wall({ polygons: [[rectangle(40, 10, 5, 25)], [rectangle(40, 60, 5, 30)]] });
  const cases = [
    input(), input({ occluders: [wall()] }),
    input({ occluders: [wall()], payload: { x: 42, y: 50, radiusMeters: 40 } }),
    input({ occluders: [wall()], payload: { x: 25, y: 50, radiusMeters: 40, elevationMeters: 5 }, sourceRangeMeters: 45 }),
    input({ occluders: [hole], payload: { x: 50, y: 50, radiusMeters: 40 } }),
    input({ occluders: [fragment] }),
    input({ occluders: [hole, wall()], payload: { x: 25, y: 25, radiusMeters: 40, visionSourceTokenId: 'scout' } }),
    input({ occluders: [wall()], lineOfSightEnabled: false }),
    input({ map: { ...map, metersPerUnit: 2.5 } }),
  ];
  for (const request of cases) await compareUnion(request, history({ 3: [[1, 5], [8, 10]], 9: [[2, 5]], 12: [[0, 3]] }));
});

test('sweep deltas keep all 171 old 2.5 meter samples and sphere heights', async () => {
  const sweepMap = { width: 500, height: 30, metersPerUnit: 1 };
  const request = input({ map: sweepMap, occluders: [wall({ polygon: rectangle(210, 0, 5, 25), blockingHeightMeters: 6 })],
    payload: { from: { x: 10, y: 15, elevationMeters: 0 }, to: { x: 435, y: 15, elevationMeters: 4 },
      radiusMeters: 12, visionSourceTokenId: 'scout' }, sourceRangeMeters: 12 });
  await compareUnion(request, history({ 1: [[0, 9], [30, 35]], 2: [[5, 25]], 3: [[70, 80]] }));
  const sampleFog = {};
  let sampled = sampleFog;
  for (let index = 0; index <= 170; index++) {
    const ratio = index / 170;
    sampled = await computeFogExplorationAsync({ ...request,
      payload: { x: 10 + 425 * ratio, y: 15, elevationMeters: 4 * ratio, radiusMeters: 12,
        visionSourceTokenId: 'scout' } }, sampled, { budgetMs: Infinity });
  }
  assert.deepEqual(await computeFogExplorationAsync(request, {}, { budgetMs: Infinity }), sampled);
});

test('known rows normalize and clip with existing rules while only the current party is transferred', async () => {
  const request = input({ partyId: ' party ' });
  const known = { 1: [[1, 2], [2, 6], [10, 11]], 9: [[-1, 4], [2, 100]], 100: [[0, 2]], invalid: [[0, 1]] };
  const delta = await compareUnion(request, history(known));
  assert.deepEqual(Object.keys(delta.exploredByParty), ['party']);
  assert.equal(delta.note, undefined);
  assert.equal(delta.exploredByParty.party.name, undefined);
  const truncated = 'p'.repeat(80);
  await compareUnion(input({ partyId: `  ${truncated}extra` }), { exploredByParty: { [truncated]: { rows: known } } });
});

test('damage, restore and hide use the current history; repeated unions produce empty deltas', async () => {
  let fog = history({});
  for (const occluders of [[wall()], [], [wall()], [], [wall()]]) {
    const request = input({ occluders });
    const delta = await compareUnion(request, fog);
    fog = mergeExploration(fog, delta, map);
    const repeated = await compareUnion(request, fog);
    assert.deepEqual(repeated.exploredByParty.party.rows, {});
  }
  fog = hideFogCircle(fog, 'party', { x: 25, y: 50, radiusMeters: 15 }, map);
  assert.ok(Object.keys((await compareUnion(input(), fog)).exploredByParty.party.rows).length);
  assert.ok(Object.keys((await compareUnion(input(), history({}))).exploredByParty.party.rows).length);
});

test('fully confirmed circle and sweep rows avoid repeated geometry preparation', async () => {
  const obstacle = wall();
  const polygon = obstacle.polygon;
  let reads = 0;
  Object.defineProperty(obstacle, 'polygon', { enumerable: true, get() { reads++; return polygon; } });
  for (const payload of [input().payload, { from: { x: 10, y: 50 }, to: { x: 30, y: 50 }, radiusMeters: 25 }]) {
    const request = input({ payload, occluders: [obstacle] });
    const allCircleRows = (await computeFogExplorationAsync({ ...request, lineOfSightEnabled: false })).exploredByParty.party.rows;
    reads = 0;
    const delta = await computeFogExplorationDeltaAsync({ ...request, exploredRows: allCircleRows });
    assert.deepEqual(delta.exploredByParty.party.rows, {});
    assert.equal(reads, 0, 'confirmed cells do not prepare the same occlusion geometry again');
    await computeFogExplorationAsync(request);
    assert.ok(reads > 0, 'the empty-history reference still prepares geometry');
  }
});

test('delta outputs remain mutable and isolated, and legacy inputs keep the complete result', async () => {
  const request = input({ lineOfSightEnabled: false });
  assert.deepEqual(await computeFogExplorationDeltaAsync(request), await computeFogExplorationAsync(request));
  const known = { 4: [[0, 2]] }, snapshot = structuredClone(known);
  const first = await computeFogExplorationDeltaAsync({ ...request, exploredRows: known });
  const row = Object.keys(first.exploredByParty.party.rows)[0];
  first.exploredByParty.party.rows[row][0][0] = 999;
  const second = await computeFogExplorationDeltaAsync({ ...request, exploredRows: known });
  assert.notEqual(first.exploredByParty.party.rows[row], second.exploredByParty.party.rows[row]);
  assert.notDeepEqual(first, second);
  assert.deepEqual(known, snapshot);
});

test('abort stops both existing sweep work and row subtraction', async () => {
  const controller = new AbortController();
  let turns = 0;
  await assert.rejects(computeFogExplorationDeltaAsync({ ...input(), exploredRows: {} }, {
    signal: controller.signal, budgetMs: -1,
    yieldTask: async () => { turns++; controller.abort(new Error('cancel subtraction')); },
  }), /cancel subtraction/);
  assert.equal(turns, 1);
  const sweepController = new AbortController();
  await assert.rejects(computeFogExplorationDeltaAsync({ ...input({ payload: {
    from: { x: 5, y: 10 }, to: { x: 70, y: 10 }, radiusMeters: 20 }, }), exploredRows: {} }, {
    signal: sweepController.signal, budgetMs: -1,
    yieldTask: async () => sweepController.abort(new Error('cancel sweep')),
  }), /cancel sweep/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await tick(); }
  assert.fail('local delta queue did not settle');
}
function queueApi(initial = { schemaVersion: 1, jobs: [] }) {
  let metadata = structuredClone(initial);
  const messages = [];
  return { getLocalExploration: () => structuredClone(metadata),
    setLocalExploration: value => { metadata = structuredClone(value); },
    persistNow: () => true, showToast: message => messages.push(message),
    metadata: () => metadata, messages };
}
function fakeWorker(requests, fail = false) {
  return class {
    postMessage(message) {
      if (fail) throw new Error('worker post failure');
      requests.push({ worker: this, message: structuredClone(message) });
    }
    terminate() { this.terminated = true; }
  };
}

test('queue captures current original-scene history per job without changing durable input', async () => {
  const original = globalThis.Worker, requests = [], readCalls = [], commits = [], api = queueApi();
  globalThis.Worker = fakeWorker(requests);
  let fog = history({ 1: [[1, 2]] });
  const queue = createLocalExplorationQueue(api, async (job, added, options) => {
    commits.push({ job, added, options }); fog = mergeExploration(fog, added, map);
  }, { getExploredRows(sceneId, partyId) { readCalls.push([sceneId, partyId]); return fog.exploredByParty.party.rows; } });
  try {
    queue.enqueue({ ...input(), contextVersion: 'same-geometry' }, 'original-scene');
    queue.enqueue({ ...input(), contextVersion: 'same-geometry' }, 'original-scene'); queue.persist(); queue.start();
    await until(() => requests.length === 1);
    assert.deepEqual(readCalls, [['original-scene', 'party']]);
    assert.equal(api.metadata().jobs[0].input.exploredRows, undefined);
    assert.equal(api.metadata().jobs[1].input.exploredRows, undefined);
    const first = requests[0], confirmedBefore = structuredClone(fog);
    first.message.input.exploredRows[1][0][0] = 0;
    assert.deepEqual(fog, confirmedBefore);
    first.message.input.exploredRows = structuredClone(confirmedBefore.exploredByParty.party.rows);
    const firstDelta = await computeFogExplorationDeltaAsync(first.message.input);
    first.worker.onmessage({ data: { id: first.message.id, result: firstDelta } });
    await until(() => requests.length === 2);
    assert.deepEqual(requests[1].message.input.exploredRows, fog.exploredByParty.party.rows);
    assert.equal(requests[1].message.input.map, undefined, 'unchanged Worker context stays versioned');
    const secondInput = { ...input(), ...requests[1].message.input };
    requests[1].worker.onmessage({ data: { id: requests[1].message.id,
      result: await computeFogExplorationDeltaAsync(secondInput) } });
    await until(() => !queue.stats().running);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map(commit => commit.options), [{ explorationDelta: true }, { explorationDelta: true }]);
    assert.deepEqual(commits[1].added.exploredByParty.party.rows, {});
    assert.equal(api.metadata().jobs.length, 0);
    assert.equal(commits[0].job.input.exploredRows, undefined);
  } finally { queue.dispose(); globalThis.Worker = original; }
});

test('Worker failure and unavailable Worker share delta math, while the two-argument queue stays legacy', async () => {
  const original = globalThis.Worker;
  const request = input(), fog = history((await computeFogExplorationAsync(request)).exploredByParty.party.rows);
  try {
    for (const worker of [undefined, fakeWorker([], true)]) {
      globalThis.Worker = worker;
      const api = queueApi(), results = [];
      const queue = createLocalExplorationQueue(api, async (_job, added, options) => {
        assert.deepEqual(options, { explorationDelta: true }); results.push(added);
      }, {
        getExploredRows: () => fog.exploredByParty.party.rows,
      });
      queue.enqueue(request, 'scene'); queue.start();
      await until(() => !queue.stats().queued && !queue.stats().running);
      assert.deepEqual(results[0].exploredByParty.party.rows, {});
      assert.equal(api.metadata().jobs.length, 0); queue.dispose();
    }
    globalThis.Worker = undefined;
    const results = [], api = queueApi();
    const queue = createLocalExplorationQueue(api, async function (_job, added) {
      assert.equal(arguments.length, 2); results.push(added);
    });
    queue.enqueue({ ...request, exploredRows: fog.exploredByParty.party.rows }, 'scene'); queue.start();
    await until(() => !queue.stats().queued && !queue.stats().running);
    assert.deepEqual(results[0], await computeFogExplorationAsync(request)); queue.dispose();
  } finally { globalThis.Worker = original; }
});

test('empty delta commit failure keeps a recoverable job and refresh re-reads current history', async () => {
  const original = globalThis.Worker; globalThis.Worker = undefined;
  const request = input(), rows = (await computeFogExplorationAsync(request)).exploredByParty.party.rows;
  const api = queueApi(); let attempts = 0;
  const queue = createLocalExplorationQueue(api, async (_job, added) => {
    attempts++; assert.deepEqual(added.exploredByParty.party.rows, {}); throw new Error('save refused');
  }, { getExploredRows: () => rows });
  try {
    queue.enqueue(request, 'scene'); queue.persist(); queue.start();
    await until(() => attempts && !queue.stats().running);
    assert.equal(queue.stats().queued, 1);
    assert.equal(api.metadata().jobs.length, 1);
    assert.equal(api.metadata().jobs[0].input.exploredRows, undefined);
    assert.match(api.messages[0], /save refused/); queue.dispose();
    const recovered = createLocalExplorationQueue(api, async (_job, added) => {
      assert.deepEqual(added.exploredByParty.party.rows, {});
    }, { getExploredRows: () => rows });
    recovered.start(); await until(() => !recovered.stats().queued && !recovered.stats().running);
    assert.equal(api.metadata().jobs.length, 0); recovered.dispose();
  } finally { queue.dispose(); globalThis.Worker = original; }
});

test('reset aborts in-flight delta and commit failure after cancellation cannot resurrect it', async () => {
  const original = globalThis.Worker, requests = [], api = queueApi(); globalThis.Worker = fakeWorker(requests);
  let committed = 0;
  const queue = createLocalExplorationQueue(api, async () => { committed++; }, { getExploredRows: () => ({}) });
  try {
    queue.enqueue(input(), 'scene'); queue.start(); await until(() => requests.length === 1);
    const late = requests[0]; queue.cancel('scene', 'party'); queue.persist();
    late.worker.onmessage({ data: { id: late.message.id, result: await computeFogExplorationDeltaAsync(late.message.input) } });
    await until(() => !queue.stats().running);
    assert.equal(committed, 0); assert.equal(api.metadata().jobs.length, 0); queue.dispose();
    globalThis.Worker = undefined;
    let rejectCommit;
    const known = (await computeFogExplorationAsync(input())).exploredByParty.party.rows;
    const awaiting = createLocalExplorationQueue(api, () => new Promise((_resolve, reject) => { rejectCommit = reject; }), {
      getExploredRows: () => known,
    });
    awaiting.enqueue(input(), 'scene'); awaiting.start(); await until(() => Boolean(rejectCommit));
    awaiting.cancel('scene', 'party'); awaiting.persist(); rejectCommit(new Error('reset during save'));
    await until(() => !awaiting.stats().running);
    assert.equal(api.metadata().jobs.length, 0); awaiting.dispose();
  } finally { queue.dispose(); globalThis.Worker = original; }
});

test('history snapshot failures preserve the confirmed path without committing partial Fog', async () => {
  const original = globalThis.Worker; globalThis.Worker = undefined;
  const api = queueApi(); let committed = 0;
  const queue = createLocalExplorationQueue(api, async () => { committed++; }, {
    getExploredRows: () => ({ unsupported: () => 1 }),
  });
  try {
    queue.enqueue(input(), 'scene'); queue.start();
    await until(() => api.messages.length && !queue.stats().running);
    assert.equal(committed, 0); assert.equal(api.metadata().jobs.length, 1);
    assert.equal(api.metadata().jobs[0].input.exploredRows, undefined);
  } finally { queue.dispose(); globalThis.Worker = original; }
});

test('the actual Worker handler computes deltas across versioned geometry without retaining history', async () => {
  const original = globalThis.self, replies = [];
  globalThis.self = { postMessage: reply => replies.push(reply) };
  try {
    await import('../src/vision/worker.js?exploration-delta-test');
    const request = input(), old = await computeFogExplorationAsync(request);
    await self.onmessage({ data: { id: 1, input: { ...request, explorationDelta: true,
      exploredRows: old.exploredByParty.party.rows } } });
    assert.deepEqual(replies[0].result.exploredByParty.party.rows, {});
    const { map: _map, occluders: _occluders, ...second } = request;
    await self.onmessage({ data: { id: 2, input: { ...second, explorationDelta: true, exploredRows: {} } } });
    assert.deepEqual(replies[1].result, old, 'new job reads its own current history, not the previous message');
    await self.onmessage({ data: { id: 3, input: { ...second, exploredRows: old.exploredByParty.party.rows } } });
    assert.deepEqual(replies[2].result, old, 'legacy Worker exploration without a history snapshot stays complete');
  } finally { globalThis.self = original; }
});
