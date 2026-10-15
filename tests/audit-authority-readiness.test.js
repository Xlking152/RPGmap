import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hostedBrowserRuntime } from './helpers/hosted-browser-runtime.js';
import { createAuditAuthorityReader, waitForAuditAuthority, comparableAuditWorld } from '../scripts/audit-authority-readiness.mjs';
import { createWorldWal } from '../deployment/local-server/world-wal.mjs';
import { emptyExploration, enqueueExploration, finishExplorationChunk, invalidateExploration } from '../deployment/local-server/exploration-queue.mjs';
import { applyWorldOperations, createWorldOperationPatch } from '../src/world/operations.js';
import { normalizeWorldV2 } from '../src/world/model.js';
import { normalizeStatusDefinition } from '../src/status/model.js';

function snapshot(api, revision = 40, exploration = emptyExploration()) {
  return { revision, state: api.exportState(), exploration };
}
function replica(api, authoritative) {
  return { status: { ...api.multiplayer.getStatus(), revision: authoritative.revision },
    world: structuredClone(authoritative.state.preferences.worldV2), hostRevision: api.getStateRevision(),
    map: { id: api.mapPackage.id, version: api.mapPackage.version, fingerprint: api.mapPackage.fingerprint },
    ruleset: { id: api.ruleset.id, version: api.ruleset.version }, sourceId: api.vision.getSource() };
}
function clock() {
  let value = 0;
  return { now: () => value, pause: async () => { value++; }, stableMs: 1, pollMs: 1, timeoutMs: 8 };
}
function pendingExploration() {
  return enqueueExploration(emptyExploration(), { map: { id: 'audit-map', width: 100, height: 100, metersPerUnit: 1 },
    occluders: [], lights: [] }, { id: 'real-durable-job', createdRevision: 40, sceneId: 'scene', partyId: 'party',
    tokenId: 'token', vagueRangeMeters: 1000, senses: {}, path: [{ x: 10, y: 10, elevationMeters: 0 }] });
}

test('readiness compares the real hosted Runtime and actual World/status normalizer, allowing only absent no-duration defaults', async t => {
  const { api } = await hostedBrowserRuntime(t);
  const original = api.world.get();
  const normalized = normalizeWorldV2(original, { mapPackage: api.mapPackage, ruleset: api.ruleset });
  assert.deepEqual(normalized, original, 'fixture is the real canonical hosted World, not a partial dummy');
  assert(normalized.statusDefinitions.length > 0);
  const authoritative = snapshot(api);
  for (const definition of authoritative.state.preferences.worldV2.statusDefinitions) {
    if (definition.defaultDuration === null) delete definition.defaultDuration;
  }
  const observed = replica(api, authoritative);
  observed.world = structuredClone(normalized);
  for (const definition of observed.world.statusDefinitions) {
    if (!Object.hasOwn(definition, 'defaultDuration')) {
      definition.defaultDuration = normalizeStatusDefinition(definition).defaultDuration;
    }
  }
  assert.notDeepEqual(observed.world, authoritative.state.preferences.worldV2);
  assert.deepEqual(comparableAuditWorld(observed.world), comparableAuditWorld(authoritative.state.preferences.worldV2));
  assert.equal(normalizeStatusDefinition({ ...normalized.statusDefinitions[0], defaultDuration: undefined }).defaultDuration, null);
  const proof = await waitForAuditAuthority({ ...clock(), readAuthority: async () => authoritative,
    readReplica: async () => observed, expectedMap: observed.map });
  assert.equal(proof.serverRevision, 40);
  assert(proof.stableMs >= 1);
  assert.deepEqual(api.world.get(), original, 'readiness must not mutate the World or its status records');
  for (const alter of [world => { world.name += '!'; },
    world => { world.statusDefinitions[0].defaultDuration = { kind: 'rounds', rounds: 2 }; },
    world => { world.statusDefinitions[0].unexpectedPrivateField = 'must compare'; },
    world => { world.updatedAt = 'different'; }]) {
    const changed = structuredClone(observed); alter(changed.world);
    await assert.rejects(waitForAuditAuthority({ ...clock(), readAuthority: async () => authoritative,
      readReplica: async () => changed }), error => {
      assert.equal(error.code, 'audit_readiness_timeout');
      assert(error.readiness.worldDifferences.length > 0 && error.readiness.worldDifferences.length <= 8);
      assert(error.readiness.worldDifferences.every(item => item.path.startsWith('world.')));
      return true;
    });
  }
});

test('readiness drains actual exploration jobs without changing epochs and waits for the GM to catch the durable revision', async t => {
  const { api } = await hostedBrowserRuntime(t);
  const pending = pendingExploration(), job = pending.jobs['real-durable-job'];
  const drained = finishExplorationChunk(pending, { id: job.id, worldEpoch: job.worldEpoch, epoch: job.epoch, fromCursor: 0, cursor: 1 });
  assert.deepEqual(drained.jobs, {}); assert.deepEqual(drained.contexts, {});
  const initial = snapshot(api, 40, pending), complete = snapshot(api, 41, drained);
  const time = clock(); let phase = 0;
  const proof = await waitForAuditAuthority({ ...time, pause: async () => { phase++; await time.pause(); },
    readAuthority: async () => phase === 0 ? initial : complete,
    readReplica: async () => replica(api, phase < 2 ? initial : complete) });
  assert.equal(proof.polls, 4);
  assert.equal(proof.serverRevision, 41);
  assert.equal(proof.elapsedMs, 3);
  assert.deepEqual(proof.completedJobs.map(item => [item.id, item.totalSamples, item.completedRevision]), [['real-durable-job', 1, 41]]);
  assert.equal(proof.completedJobs[0].worldEpoch, job.worldEpoch);
  assert.equal(proof.completedJobs[0].partyEpoch, job.epoch);
});

test('cancelled jobs and orphan contexts cannot count as completed preparation', async t => {
  const { api } = await hostedBrowserRuntime(t);
  const pending = pendingExploration(), initial = snapshot(api, 40, pending);
  const cancelled = snapshot(api, 41, invalidateExploration(pending, 'scene', 'party'));
  let reads = 0;
  await assert.rejects(waitForAuditAuthority({ ...clock(), readAuthority: async () => ++reads === 1 ? initial : cancelled,
    readReplica: async () => replica(api, initial) }), { code: 'audit_exploration_cancelled' });
  const orphan = snapshot(api, 40, { ...pending, jobs: {} });
  await assert.rejects(waitForAuditAuthority({ ...clock(), readAuthority: async () => orphan,
    readReplica: async () => replica(api, orphan) }), { code: 'audit_exploration_context_leak' });
});

test('authority reads must bracket one exact GM revision, identity and idle operation queue', async t => {
  const { api } = await hostedBrowserRuntime(t);
  const authoritative = snapshot(api), observed = replica(api, authoritative);
  for (const alter of [value => { value.status.pendingOperationCount = 1; },
    value => { value.status.applyingRemote = true; }, value => { value.status.resuming = true; },
    value => { value.status.revision--; }]) {
    const changed = structuredClone(observed); alter(changed);
    await assert.rejects(waitForAuditAuthority({ ...clock(), readAuthority: async () => authoritative,
      readReplica: async () => changed }), { code: 'audit_readiness_timeout' });
  }
  let reads = 0;
  await assert.rejects(waitForAuditAuthority({ ...clock(), readAuthority: async () => ({ ...authoritative, revision: ++reads }),
    readReplica: async () => observed }), { code: 'audit_readiness_timeout' });
  await assert.rejects(waitForAuditAuthority({ ...clock(), readAuthority: async () => authoritative,
    readReplica: async () => observed, expectedMap: { ...observed.map, fingerprint: 'wrong-content' } }),
  { code: 'audit_authority_identity_mismatch' });
});

test('the actual checkpoint/WAL reader replays durable records without repairing a torn tail or changing source files', async t => {
  const { api } = await hostedBrowserRuntime(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-audit-authority-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = snapshot(api), file = path.join(directory, 'world.json'), walFile = path.join(directory, 'world.operations.ndjson');
  await writeFile(file, JSON.stringify(initial));
  const after = applyWorldOperations(initial.state, [{ type: 'world.rename', payload: { name: 'Durably updated' } }],
    { ruleset: api.ruleset, mapPackage: api.mapPackage, source: { role: 'gm' } }).state;
  const wal = createWorldWal({ filePath: walFile, applyPatch: () => { throw new Error('append does not apply'); } });
  await wal.append({ baseRevision: 40, revision: 41, operationId: 'actual-record',
    patch: createWorldOperationPatch(initial.state, after) });
  await appendFile(walFile, '{"torn-tail":');
  const source = await Promise.all([readFile(file), readFile(walFile)]);
  const result = await createAuditAuthorityReader(directory)();
  assert.equal(result.revision, 41); assert.equal(result.state.preferences.worldV2.name, 'Durably updated');
  assert.deepEqual(await Promise.all([readFile(file), readFile(walFile)]), source);
});
