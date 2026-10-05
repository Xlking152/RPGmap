import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyExploration, enqueueExploration, explorationDelta, applyExplorationDelta,
  invalidateExploration, finishExplorationChunk, selectExplorationJob } from '../deployment/local-server/exploration-queue.mjs';
import { createWorldWal } from '../deployment/local-server/world-wal.mjs';
import { computeExplorationChunk, mergeExplorationChunkFog } from '../src/server/exploration-compute.js';
import { computeFogExploration, mergeExploration } from '../src/vision/fog.js';

const context = { map: { width: 1000, height: 1000, metersPerUnit: 1 }, occluders: [], lights: [], ambient: 'normal' };
const jobInput = (id = 'move:0', tokenId = 'token-a', revision = 1) => ({ id, tokenId, createdRevision: revision,
  sceneId: 'scene-a', partyId: 'party-a', vagueRangeMeters: 30, senses: {},
  path: [{ x: 10, y: 20, elevationMeters: 0 }, { x: 80, y: 20, elevationMeters: 0 }] });

test('incremental durable Fog merging matches normalized union without mutating earlier party memory', () => {
  const map = { width: 100, height: 100, metersPerUnit: 1 };
  const original = { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {
    'party-a': { rows: { 1: [[1, 2], [5, 7]] } }, 'party-b': { rows: { 2: [[1, 4]] } } } };
  const saved = structuredClone(original);
  const addedRows = { 1: [[3, 4]], 2: [[2, 6]] };
  const expected = mergeExploration(original, { exploredByParty: { 'party-a': { rows: addedRows } } }, map);
  const merged = mergeExplorationChunkFog(original, 'party-a', addedRows, map);
  assert.deepEqual(merged, expected);
  assert.deepEqual(original, saved);
  const secondRows = { 2: [[7, 9]] };
  const next = mergeExplorationChunkFog(merged, 'party-a', secondRows, map);
  assert.deepEqual(next, mergeExploration(expected, { exploredByParty: { 'party-a': { rows: secondRows } } }, map));
  assert.deepEqual(merged, expected);
  assert.equal(next.exploredByParty['party-b'], merged.exploredByParty['party-b']);
});

test('same WAL fsync replays the confirmed movement and its private exploration job', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rpgmap-exploration-wal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'world.operations.ndjson');
  const wal = createWorldWal({ filePath, applyPatch: (state, patch) => ({ ...state, ...patch }) });
  const before = emptyExploration(), queued = enqueueExploration(before, context, jobInput());
  await wal.append({ baseRevision: 0, revision: 1, operationId: 'move', patch: { x: 80 },
    explorationDelta: explorationDelta(before, queued) });
  const recovered = await wal.replay({ revision: 0, state: { x: 10 } });
  assert.equal(recovered.state.x, 80);
  assert.deepEqual(recovered.exploration, JSON.parse(JSON.stringify(queued)));
  const job = queued.jobs['move:0'];
  const finished = finishExplorationChunk(queued, { id: job.id, worldEpoch: job.worldEpoch, epoch: job.epoch,
    fromCursor: 0, cursor: job.totalSamples });
  await wal.append({ baseRevision: 1, revision: 2, operationId: 'fog', patch: { fog: 'explored' },
    explorationDelta: explorationDelta(queued, finished) });
  const after = await wal.replay({ revision: 0, state: { x: 10 } });
  assert.equal(after.state.fog, 'explored');
  assert.deepEqual(after.exploration.jobs, {});
  assert.deepEqual(after.exploration.contexts, {});
  const record = JSON.parse((await readFile(filePath, 'utf8')).split('\n')[0]);
  assert.equal(record.walVersion, 2);
  assert.ok(record.explorationDelta.jobs['move:0']);
});

test('checkpoint replay skips duplicate jobs and a second replay cannot resurrect completed work', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rpgmap-exploration-checkpoint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wal = createWorldWal({ filePath: path.join(dir, 'wal'), applyPatch: (state, patch) => ({ ...state, ...patch }) });
  const before = emptyExploration(), queued = enqueueExploration(before, context, jobInput());
  await wal.append({ baseRevision: 0, revision: 1, operationId: 'move', patch: { x: 80 }, explorationDelta: explorationDelta(before, queued) });
  const checkpoint = { revision: 1, state: { x: 80 }, exploration: queued };
  assert.deepEqual(await wal.replay(checkpoint), checkpoint);
  await wal.reset();
  assert.deepEqual(await wal.replay(checkpoint), checkpoint);
});

test('reset cancels its party epoch atomically while preserving other parties and sources', () => {
  const first = enqueueExploration(emptyExploration(), context, jobInput());
  const queued = enqueueExploration(first, context, { ...jobInput('other:0', 'other-token', 2), partyId: 'party-b' });
  const oldJob = queued.jobs['move:0'], reset = invalidateExploration(queued, 'scene-a', 'party-a');
  assert.equal(reset.jobs['move:0'], undefined);
  assert.ok(reset.jobs['other:0']);
  assert.equal(finishExplorationChunk(reset, { id: oldJob.id, worldEpoch: oldJob.worldEpoch, epoch: oldJob.epoch,
    fromCursor: 0, cursor: 1 }), null);
  const fresh = enqueueExploration(reset, context, jobInput('new:0'));
  assert.equal(fresh.jobs['new:0'].epoch, oldJob.epoch + 1);
  assert.deepEqual(applyExplorationDelta(queued, explorationDelta(queued, reset)), reset);
});

test('round robin preserves each source FIFO and allows another player after one chunk', () => {
  let queue = enqueueExploration(emptyExploration(), context, jobInput('a:0', 'a', 1));
  queue = enqueueExploration(queue, context, jobInput('a:1', 'a', 2));
  queue = enqueueExploration(queue, context, jobInput('b:0', 'b', 3));
  const first = selectExplorationJob(queue);
  assert.equal(first.job.id, 'a:0');
  const second = selectExplorationJob(queue, first.lane);
  assert.equal(second.job.id, 'b:0');
  assert.equal(selectExplorationJob(queue, second.lane).job.id, 'a:0');
  assert.equal(Object.keys(queue.contexts).length, 1);
});

test('chunk cursor resumes all 2.5 metre samples and multi-segment paths reproduce the synchronous union', () => {
  const input = { ...jobInput(), path: [{ x: 10, y: 20, elevationMeters: 0 },
    { x: 80, y: 20, elevationMeters: 0 }, { x: 80, y: 100, elevationMeters: 0 }] };
  const queued = enqueueExploration(emptyExploration(), context, input);
  let job = queued.jobs[input.id], fog = {}, rounds = 0;
  while (job.cursor < job.totalSamples) {
    const result = computeExplorationChunk({ job, context, exploredRows: fog.exploredByParty?.['party-a']?.rows, budgetMs: 0 });
    assert.equal(result.cursor, job.cursor + 1);
    fog = mergeExploration(fog, { exploredByParty: { 'party-a': { rows: result.rows } } }, context.map);
    job = { ...job, cursor: result.cursor }; rounds++;
  }
  assert.equal(rounds, 62);
  let reference = {};
  for (let i = 1; i < input.path.length; i++) reference = computeFogExploration({ partyId: 'party-a',
    payload: { from: input.path[i - 1], to: input.path[i], radiusMeters: 30 }, map: context.map, occluders: [], lineOfSightEnabled: true }, reference);
  assert.deepEqual(fog, reference);
});

test('stale or duplicate chunk cannot advance a job twice', () => {
  const queued = enqueueExploration(emptyExploration(), context, jobInput());
  const job = queued.jobs['move:0'];
  const result = { id: job.id, worldEpoch: job.worldEpoch, epoch: job.epoch, fromCursor: 0, cursor: 1 };
  const advanced = finishExplorationChunk(queued, result);
  assert.equal(finishExplorationChunk(advanced, result), null);
  assert.equal(finishExplorationChunk(queued, { ...result, worldEpoch: 'old-import' }), null);
  assert.throws(() => finishExplorationChunk(queued, { ...result, cursor: job.totalSamples + 1 }));
});
