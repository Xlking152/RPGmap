import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { GM_SECRET, startBenchmarkServer, stopBenchmarkServer, connectBenchmarkClient,
  waitForMessage, measureDocumentBatch, summarizeLatency, benchmarkBuildInfo, benchmarkMessage } from './lan-benchmark-support.mjs';

const argument = key => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const root = path.resolve(argument('repo') || '.');
const packageRoot = argument('package') ? path.resolve(argument('package')) : null;
const buildInfo = await benchmarkBuildInfo(root, packageRoot);
const rounds = Number(argument('rounds') || 5);
assert(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20, '--rounds must be an integer from 1 to 20');
const warmupRounds = Number(argument('warmup-rounds') ?? 1);
assert(Number.isSafeInteger(warmupRounds) && warmupRounds >= 0 && warmupRounds <= 5, '--warmup-rounds must be an integer from 0 to 5');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const [{ createActorFromRulesetImport }, { infiniteHorrorRuleset }, { INFINITE_HORROR_STATUS_DEFINITIONS },
  { normalizeSceneToken }, { deriveVisionOccluders }, { deriveSceneState },
  { createNavigationBase, createNavigationGrid, inspectDirectNavigationPath },
  { exploreFogVisibleSweep, normalizeFogState }, { createWorldWal }, { applyWorldOperationPatch }] = await Promise.all([
  load('src/actor/index.js'), load('src/rulesets/infinite-horror/index.js'), load('src/rulesets/infinite-horror/statuses.js'),
  load('src/token/model.js'), load('src/spatial/kernel.js'), load('src/engine/state.js'), load('src/engine/navigation.js'),
  load('src/vision/fog.js'), load('deployment/local-server/world-wal.mjs'), load('src/world/operations.js'),
]);
const map = JSON.parse(await readFile(path.join(root, 'reference/maps/lanzhou/runtime.json'), 'utf8'));
const sceneId = 'occlusion-lan-scene';
const actorCount = 100, tokenCount = 500, playerCount = 6, distanceMeters = 425, rangeMeters = 1000;
const emptyScene = { id: sceneId, sceneEvents: [], featureStates: {}, tokens: [] };
const occluders = deriveVisionOccluders(map, emptyScene, deriveSceneState([]));
const navigation = createNavigationGrid(map, deriveSceneState([]), createNavigationBase(map), {
  appState: { sceneEvents: [], preferences: { featureStates: {} } },
  moverContext: { diameterMeters: 1, elevationMeters: 0, movementMode: 'walk' },
});

// Pick a physically valid 425 m route near the city, rather than teleporting
// through buildings or placing the benchmark where no occluders are nearby.
const candidates = [];
for (const y of [1400.5, 1300.5, 3200.5, 3300.5, 1200.5, 3400.5, 1800.5, 2500.5]) {
  for (const x of [2200.5, 2500.5, 2800.5, 3100.5]) {
    const lanes = Array.from({ length: playerCount }, (_, index) => ({ x, y: y + index * 12 }));
    if (!lanes.every(from => inspectDirectNavigationPath(navigation, from,
      { x: from.x + distanceMeters / map.metersPerUnit, y: from.y }, { diameterMeters: 1 }).valid)) continue;
    const nearby = occluders.filter(occluder => {
      const points = occluder.polygon || [];
      const minX = Math.min(...points.map(point => point[0])), maxX = Math.max(...points.map(point => point[0]));
      const minY = Math.min(...points.map(point => point[1])), maxY = Math.max(...points.map(point => point[1]));
      return lanes.some(from => [from, { ...from, x: from.x + distanceMeters / map.metersPerUnit }].some(center =>
        Math.hypot(Math.max(minX - center.x, 0, center.x - maxX), Math.max(minY - center.y, 0, center.y - maxY))
          * map.metersPerUnit <= rangeMeters));
    }).length;
    candidates.push({ lanes, nearby });
  }
}
candidates.sort((left, right) => right.nearby - left.nearby);
assert(candidates.length, 'No valid six-lane 425 m route exists in this benchmark fixture');
const route = candidates[0];
assert(route.nearby >= 40, 'The large-range scenario must exercise at least 40 nearby city occluders');

function fixture() {
  const actors = Array.from({ length: actorCount }, (_, index) => createActorFromRulesetImport({
    formName: 'Default', identity: { name: `LAN Actor ${index}` },
    resources: { hp: { max: 12 }, stamina: { max: 5 }, willpower: { max: 5 } },
    attributes: [{ id: 'perception', name: 'Perception', base: 1 }],
    checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] },
    tokenAppearance: { color: '#397783', scale: 1 }, source: { type: 'manual' },
  }, { id: `actor-${index}`, name: `LAN Actor ${index}`, type: 'pc', partyId: `party-${index % playerCount}`,
    variantId: `actor-${index}-form`, variantName: 'Default', ruleset: infiniteHorrorRuleset }));
  const tokens = Array.from({ length: tokenCount }, (_, index) => {
    const actor = actors[index % actorCount];
    const position = index < playerCount ? route.lanes[index] : {
      x: route.lanes[0].x - 300 + (index % 25) * 24, y: route.lanes[0].y + 100 + Math.floor(index / 25) * 24,
    };
    const lightIndex = index - (tokenCount - 3);
    const light = lightIndex >= 0 ? { enabled: true, rangeMeters: 800, intensity: 1.2 + lightIndex * 0.3,
      elevationOffsetMeters: 3, occlusion: 'scene' } : null;
    return normalizeSceneToken({ id: `token-${index}`, actorId: actor.id, actorLink: true,
      placement: 'map', ...position, elevationMeters: 0, diameterMeters: 1,
      visibility: { mode: 'public', userIds: [] }, light,
      vision: { enabled: true, preciseRangeOverrideMeters: rangeMeters, vagueRangeOverrideMeters: rangeMeters },
    }, { actor, ruleset: infiniteHorrorRuleset });
  });
  const world = { schemaVersion: 3, id: 'occlusion-lan-world', name: 'Occlusion LAN Benchmark',
    ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: sceneId,
    actors, statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
    scenes: [{ ...emptyScene, name: 'LAN Large Range', mapPackage: { id: map.id, version: map.version }, tokens,
      markers: [], attackAreas: [], fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
      settings: { gridVisible: true, lighting: 'dark' } }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  return { version: 2, mapId: map.id, mapVersion: map.version, markers: [], attackAreas: [], sceneEvents: [],
    preferences: { worldV2: world,
      entitySystem: { schemaVersion: 3, actors: structuredClone(actors), tokens: structuredClone(tokens),
        statusDefinitions: structuredClone(world.statusDefinitions) },
      combatSystem: { schemaVersion: 2, combat: null }, chatSystem: { schemaVersion: 1, messages: [] } } };
}

async function durableWorld(runtime) {
  const snapshot = JSON.parse(await readFile(path.join(runtime.mapDir, 'world.json'), 'utf8'));
  const wal = createWorldWal({ filePath: path.join(runtime.mapDir, 'world.operations.ndjson'),
    applyPatch: (state, patch) => applyWorldOperationPatch(state, patch, { project: false }) });
  return wal.replay(snapshot, { repairTail: false });
}

// Observe complete newly appended WAL records once. This records every job's
// sample count/cursor/removal even if the server checkpoints during the run.
async function observeExploration(runtime) {
  const initial = await durableWorld(runtime);
  const handle = await open(path.join(runtime.mapDir, 'world.operations.ndjson'), 'r');
  const jobs = new Map(Object.entries(initial.exploration.jobs));
  const created = new Map(), completed = new Set(), probes = new Map();
  let offset = 0, tail = '', latestRevision = initial.revision, scheduled = false, closed = false, failure = null;
  let chain = Promise.resolve();
  const readNew = async () => {
    const size = (await handle.stat()).size;
    if (size < offset) {
      // A checkpoint may truncate a Fog-completion record before the watcher
      // reads it. Its durable job absence proves completion only when neither
      // the World nor that party's cancellation epoch changed.
      const checkpoint = JSON.parse(await readFile(path.join(runtime.mapDir, 'world.json'), 'utf8'));
      if (checkpoint.revision > latestRevision) {
        const remaining = checkpoint.exploration.jobs;
        for (const [id, job] of jobs) {
          if (Object.hasOwn(remaining, id)) continue;
          const epochKey = JSON.stringify([job.sceneId, job.partyId]);
          if (id.startsWith('occlusion-lan-move-')) {
            assert.equal(checkpoint.exploration.worldEpoch, job.worldEpoch, `World invalidated benchmark path ${id}`);
            assert.equal(checkpoint.exploration.partyEpochs[epochKey] || 0, job.epoch, `Party invalidated benchmark path ${id}`);
          }
          completed.add(id);
        }
        jobs.clear();
        for (const [id, job] of Object.entries(remaining)) {
          if (!created.has(id)) created.set(id, job);
          jobs.set(id, job);
        }
        latestRevision = checkpoint.revision;
      }
      offset = 0; tail = '';
    }
    if (size === offset) return;
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    offset += bytesRead;
    const lines = (tail + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
    tail = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.revision <= latestRevision) continue;
      latestRevision = record.revision;
      if (String(record.operationId || '').startsWith('occlusion-lan-probe-')) {
        // WAL order proves these operations committed while path samples were
        // still pending, rather than trusting a stale client queue snapshot.
        const jobProgressAtCommit = [...jobs].filter(([id, job]) => id.startsWith('occlusion-lan-move-')
          && job.cursor < job.totalSamples).map(([id, job]) => ({ id, cursor: job.cursor, totalSamples: job.totalSamples }));
        probes.set(record.operationId, { revision: record.revision, jobProgressAtCommit,
          activeJobIdsAtCommit: jobProgressAtCommit.map(job => job.id),
          remainingSamplesAtCommit: jobProgressAtCommit.reduce((sum, job) => sum + job.totalSamples - job.cursor, 0) });
      }
      const delta = record.explorationDelta;
      if (!delta) continue;
      if (delta.replace) { jobs.clear(); for (const [id, job] of Object.entries(delta.replace.jobs || {})) jobs.set(id, job); }
      for (const [id, job] of Object.entries(delta.jobs || {})) {
        const previous = jobs.get(id);
        if (!previous) created.set(id, job);
        assert(!previous || job.cursor >= previous.cursor, `Exploration cursor regressed for ${id}`);
        jobs.set(id, job);
      }
      for (const id of delta.removeJobs || []) {
        if (jobs.has(id)) {
          if (id.startsWith('occlusion-lan-move-')) {
            assert(record.operationId.startsWith('fog-'), `Benchmark path was cancelled instead of completed: ${id}`);
          }
          completed.add(id);
        }
        jobs.delete(id);
      }
    }
  };
  const flush = () => {
    chain = chain.then(readNew).catch(error => { failure ||= error; });
    return chain.then(() => { if (failure) throw failure; });
  };
  const watcher = watch(runtime.mapDir, (event, file) => {
    if (String(file) !== 'world.operations.ndjson' || scheduled || closed) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; if (!closed) flush().catch(() => {}); });
  });
  await flush();
  return { jobs, created, completed, probes, flush,
    async close() { closed = true; watcher.close(); await chain; await handle.close(); } };
}

async function waitForDrain(runtime, observer, { expectedJobIds = [], timing = null } = {}) {
  const started = performance.now();
  while (performance.now() - started < 60_000) {
    await observer.flush();
    if (!observer.jobs.size && expectedJobIds.every(id => observer.completed.has(id))) {
      const observedDrainAt = performance.now();
      const observedDrainTimeUs = Number(process.hrtime.bigint() / 1000n);
      const durable = await durableWorld(runtime);
      if (!Object.keys(durable.exploration.jobs).length) {
        assert.equal(Object.keys(durable.exploration.contexts).length, 0, 'Derived contexts remain after queue drain');
        if (timing) Object.assign(timing, { observedDrainAt, observedDrainTimeUs,
          storageVerificationMs: performance.now() - observedDrainAt });
        return durable;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Exploration queue did not drain all samples: ${JSON.stringify([...observer.jobs.values()])}`);
}

function fogHash(fog) { return createHash('sha256').update(JSON.stringify(normalizeFogState(fog, map))).digest('hex'); }

async function scenario(sourceCount) {
  const profileDir = argument('profile') ? path.resolve(argument('profile'), `sources-${sourceCount}`) : null;
  if (profileDir) await mkdir(profileDir, { recursive: true });
  const runtime = await startBenchmarkServer(root, { packageRoot,
    nodeArgs: profileDir ? ['--cpu-prof', `--cpu-prof-dir=${profileDir}`] : [] });
  let observer;
  try {
    const health = await (await fetch(`${runtime.httpUrl}/api/health`)).json();
    const schemas = { operationSchema: health.operationSchema, statusSchema: health.statusSchema, accessSchema: health.accessSchema };
    const gm = await connectBenchmarkClient(runtime, schemas, { name: 'Occlusion LAN GM', requestedRole: 'gm', gmSecret: GM_SECRET });
    const imported = waitForMessage(gm.socket, message => message.type === 'world.snapshot' && message.revision === 1, 'Benchmark import');
    gm.socket.send({ type: 'world.push', baseRevision: 0, state: fixture(), reason: 'file-import:occlusion-lan' });
    await imported;
    const players = [];
    for (let index = 0; index < playerCount; index++) {
      const name = `Occlusion LAN Player ${index + 1}`;
      const claim = waitForMessage(gm.socket, message => message.type === 'access.claim', `${name} claim`);
      gm.socket.send({ type: 'access.user.create', name, defaultActorId: `actor-${index}`, ownership: { [`actor-${index}`]: 'owner' } });
      players.push(await connectBenchmarkClient(runtime, schemas, { name, requestedRole: 'player', claimCode: (await claim).claimCode }));
    }
    let revision = 1;
    for (const client of [gm, ...players]) client.socket.addEventListener('message', event => {
      const message = benchmarkMessage(event);
      if (!message) return;
      if (['world.snapshot', 'audience.snapshot', 'vision.source.ack', 'document.batch.committed',
        'world.operation.committed', 'document.batch.ack', 'world.operation.ack'].includes(message.type)) {
        revision = Math.max(revision, Number(message.revision) || 0);
      }
    });
    observer = await observeExploration(runtime);
    for (let index = 0; index < sourceCount; index++) {
      const ack = waitForMessage(players[index].socket, message => message.type === 'vision.source.ack'
        || message.type === 'vision.source.denied', 'Vision source');
      players[index].socket.send({ type: 'vision.source.set', tokenId: `token-${index}` });
      assert.equal((await ack).type, 'vision.source.ack');
    }
    const warmed = await waitForDrain(runtime, observer);
    revision = Math.max(revision, warmed.revision);
    const recipients = [gm, ...players].map(client => client.socket);
    const samples = [], ackTimes = [], fanoutTimes = [], queueTimes = [], durableQueueTimes = [], verificationTimes = [];
    const probeRecords = [];
    const statusId = 'status-strengthened';
    const probeDefinition = INFINITE_HORROR_STATUS_DEFINITIONS.find(definition => definition.id === statusId);
    assert(probeDefinition && probeDefinition.changes.length === 0
      && Object.keys(probeDefinition.capabilities).length === 0,
    'Concurrent status probe must not alter movement, lighting or perception');
    let previous = route.lanes.slice(0, sourceCount).map(position => ({ ...position, elevationMeters: 0 }));
    for (let iteration = 0; iteration < rounds + warmupRounds; iteration++) {
      const resetId = `occlusion-lan-reset-${sourceCount}-${iteration}`;
      await measureDocumentBatch(gm.socket, recipients, { type: 'document.batch', operationSchema: schemas.operationSchema,
        operationId: resetId, baseRevision: revision, writes: Array.from({ length: sourceCount }, (_, index) => ({
          action: 'update', document: { type: 'Fog', id: sceneId, parent: { type: 'Scene', id: sceneId } },
          intent: 'fog.reset', data: { partyId: `party-${index}` }, precondition: {},
        })) });
      const before = await waitForDrain(runtime, observer);
      revision = Math.max(revision, before.revision);
      const start = performance.now();
      const movementWindowStartUs = Number(process.hrtime.bigint() / 1000n);
      const target = previous.map((position, index) => ({ ...position,
        x: route.lanes[index].x + (iteration % 2 === 0 ? distanceMeters / map.metersPerUnit : 0) }));
      const ids = target.map((position, index) => `occlusion-lan-move-${sourceCount}-${iteration}-${index}`);
      const measured = await Promise.all(target.map((destination, index) => measureDocumentBatch(players[index].socket, recipients, {
        type: 'document.batch', operationSchema: schemas.operationSchema, operationId: ids[index], baseRevision: revision,
        writes: [{ action: 'move', document: { type: 'Token', id: `token-${index}`, parent: { type: 'Scene', id: sceneId } },
          intent: 'token.movePath', data: { tokenIds: [`token-${index}`], waypoints: [destination], method: 'keyboard' },
          precondition: { expectedOrigins: { [`token-${index}`]: previous[index] } } }],
      })));
      const movementWindowEndUs = Number(process.hrtime.bigint() / 1000n);
      const otherPlayerSamples = [];
      // Four status/chat pairs exercise ordinary Player transactions while
      // the acknowledged 425 m paths are still exploring. No extra movement
      // or vision changes may add samples to the original path/Fog oracle.
      for (let probeIndex = 0; probeIndex < 4; probeIndex++) {
        const playerIndex = 1 + ((iteration * 4 + probeIndex) % (playerCount - 1));
        for (const type of ['status', 'chat']) {
          await observer.flush();
          const operationId = `occlusion-lan-probe-${sourceCount}-${iteration}-${type}-${probeIndex}`;
          const targetActorId = type === 'status' ? `actor-${playerIndex}` : null;
          const write = type === 'status' ? {
            action: 'update', document: { type: 'Status', id: targetActorId, parent: null },
            intent: 'status.apply', data: { scope: 'actor', targetId: targetActorId, statusId }, precondition: {},
          } : {
            action: 'append', document: { type: 'ChatMessage', id: `${operationId}-message`, parent: null },
            intent: 'chat.append', data: { text: `Exploration active ${sourceCount}/${iteration}/${probeIndex}` }, precondition: {},
          };
          const measuredProbe = await measureDocumentBatch(players[playerIndex].socket, recipients, {
            type: 'document.batch', operationSchema: schemas.operationSchema, operationId, baseRevision: revision,
            writes: [write],
          }, { revisionConflictRetries: 3 });
          revision = Math.max(revision, Number(measuredProbe.ack.revision) || 0);
          await observer.flush();
          const proof = observer.probes.get(operationId);
          assert(proof && proof.revision === measuredProbe.ack.revision
            && proof.remainingSamplesAtCommit > 0 && proof.activeJobIdsAtCommit.length > 0
            && proof.activeJobIdsAtCommit.every(id => ids.some(moveId => id === `${moveId}:0`)),
          `Ordinary ${type} did not commit while this round's exploration was active: ${operationId}`);
          otherPlayerSamples.push({ operationId, type, senderPlayer: playerIndex + 1, targetActorId,
            ackMs: Number(measuredProbe.ackMs.toFixed(3)), fanoutMs: Number(measuredProbe.fanoutMs.toFixed(3)),
            initialBaseRevision: measuredProbe.initialBaseRevision, retryCount: measuredProbe.retryCount,
            revisionConflicts: measuredProbe.revisionConflicts.map(conflict => ({ ...conflict,
              elapsedMs: Number(conflict.elapsedMs.toFixed(3)) })), ...proof });
        }
      }
      const drainTiming = {};
      const drained = await waitForDrain(runtime, observer, {
        expectedJobIds: ids.map(id => `${id}:0`), timing: drainTiming,
      });
      const explorationWindowEndUs = Number(process.hrtime.bigint() / 1000n);
      revision = Math.max(revision, drained.revision);
      const drainedMs = performance.now() - start;
      const durableExplorationMs = drainTiming.observedDrainAt - start;
      let expectedFog = before.state.preferences.worldV2.scenes[0].fog;
      const durableJobProofs = [];
      for (let index = 0; index < sourceCount; index++) {
        const jobId = `${ids[index]}:0`, job = observer.created.get(jobId);
        assert(job, `Missing durable exploration job ${jobId}`);
        assert.equal(job.cursor, 0, 'The benchmark must observe creation before exploration progress');
        assert.equal(job.totalSamples, 171, '425 m movement must retain every 2.5 m exploration sample');
        assert(observer.completed.has(jobId), `Job ${jobId} disappeared without a durable completion`);
        durableJobProofs.push({ id: jobId, contextId: job.contextId,
          cursorAtCreation: job.cursor, totalSamples: job.totalSamples, completedDurably: true });
        expectedFog = exploreFogVisibleSweep(expectedFog, `party-${index}`, previous[index], target[index], rangeMeters, map,
          { occluders, allowHostExemption: true, sourceRangeMeters: rangeMeters });
      }
      const actualFog = drained.state.preferences.worldV2.scenes[0].fog;
      assert.deepEqual(normalizeFogState(actualFog, map), normalizeFogState(expectedFog, map), 'Completed Fog differs from full path reference');
      const sample = { round: iteration - warmupRounds + 1, warmup: iteration < warmupRounds,
        movementAck: summarizeLatency(measured.map(item => item.ackMs)),
        allClientFanout: summarizeLatency(measured.map(item => item.fanoutMs)), completeExplorationMs: Number(drainedMs.toFixed(3)),
        durableExplorationMs: Number(durableExplorationMs.toFixed(3)),
        storageVerificationMs: Number(drainTiming.storageVerificationMs.toFixed(3)),
        movementCpuWindow: { startTimeUs: movementWindowStartUs, endTimeUs: movementWindowEndUs },
        explorationCpuWindow: { startTimeUs: movementWindowEndUs, endTimeUs: drainTiming.observedDrainTimeUs },
        storageVerificationCpuWindow: { startTimeUs: drainTiming.observedDrainTimeUs, endTimeUs: explorationWindowEndUs },
        requestLatencies: measured.map((item, index) => ({ tokenId: `token-${index}`,
          ackMs: Number(item.ackMs.toFixed(3)), fanoutMs: Number(item.fanoutMs.toFixed(3)) })),
        otherPlayerSamples,
        durableJobs: sourceCount, processedSamples: sourceCount * 171, jobsRemaining: 0, contextsRemaining: 0,
        durableJobProofs,
        referenceFogMatches: true, fogHash: fogHash(actualFog),
        maxCommittedBytes: Math.max(...measured.flatMap(item => item.messages.map(message => Buffer.byteLength(JSON.stringify(message))))) };
      if (iteration >= warmupRounds) {
        ackTimes.push(...measured.map(item => item.ackMs));
        fanoutTimes.push(...measured.map(item => item.fanoutMs));
        queueTimes.push(drainedMs);
        durableQueueTimes.push(durableExplorationMs);
        verificationTimes.push(drainTiming.storageVerificationMs);
        samples.push(sample);
        probeRecords.push(...otherPlayerSamples);
      }
      previous = target;
      if (process.argv.includes('--debug')) console.error(JSON.stringify({ scenario: sourceCount, ...sample }));
    }
    return { sourceCount, parties: sourceCount, lighting: 'dark', lights: 3, rangeMeters, distanceMeters,
      rounds, warmupRounds, warmupProcessedSamples: warmupRounds * sourceCount * 171,
      cpuProfileDirectory: profileDir, profileProcessId: profileDir ? runtime.child.pid : null,
      movementAck: summarizeLatency(ackTimes), allClientFanout: summarizeLatency(fanoutTimes),
      completeExploration: summarizeLatency(queueTimes), durableExploration: summarizeLatency(durableQueueTimes),
      storageVerification: summarizeLatency(verificationTimes), processedSamples: rounds * sourceCount * 171,
      otherPlayerOperations: {
        perRound: { status: 4, chat: 4 }, warmupSamples: warmupRounds * 8, samples: probeRecords.length,
        ackMeasurement: Object.fromEntries(['status', 'chat', 'aggregate'].map(type => [type,
          summarizeLatency(probeRecords.filter(record => type === 'aggregate' || record.type === type).map(record => record.ackMs))])),
        measurement: Object.fromEntries(['status', 'chat', 'aggregate'].map(type => [type,
          summarizeLatency(probeRecords.filter(record => type === 'aggregate' || record.type === type).map(record => record.fanoutMs))])),
      }, samples };
  } catch (error) {
    if (runtime.stderr()) console.error(runtime.stderr());
    throw error;
  } finally {
    if (observer) await observer.close();
    await stopBenchmarkServer(runtime);
    const diagnosticDir = argument('canonical-diagnostics-dir');
    if (diagnosticDir) {
      await mkdir(diagnosticDir, { recursive: true });
      await writeFile(path.join(diagnosticDir, `sources-${sourceCount}.log`), runtime.stderr());
    }
  }
}

const report = { repo: root, packageRoot, version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  build: buildInfo,
  diagnosticProfiling: Boolean(argument('profile') || argument('canonical-diagnostics-dir')
    || process.env.RPGMAP_CANONICAL_DIAGNOSTICS === '1'),
  fixture: { actors: actorCount, tokens: tokenCount, players: playerCount, mapId: map.id, occluders: occluders.length,
    nearbyOccluders: route.nearby, lanes: route.lanes, fogCellSizeMeters: 5, pathSampleSpacingMeters: 2.5 },
  scope: 'Loopback WebSocket/WAL measurement. Movement is acknowledged before background Fog; queue completion is checked against all 171 samples and full-path Fog union. Durable WAL job drain is timed separately from read-only checkpoint/WAL replay; completeExploration includes both for comparison with earlier reports. It does not measure Wi-Fi transport, browser input latency, Canvas or FPS. Large-range scenarios also measure four status/chat pairs from other Player sessions per round while their WAL commits still have unfinished exploration samples. Ordinary intents may retry a revision conflict up to three times with the same operation ID; all denied attempts remain inside the first-submission-to-ACK/fanout clock and are reported in raw samples. No additional moves or Fog samples are added. --assert requires movement and ordinary status/chat/aggregate ACK and final fanout p95 <=60 ms in each scenario.',
  scenarios: { singleSource: await scenario(1), sixConcurrentSources: await scenario(6) } };
assert.deepEqual(await benchmarkBuildInfo(root, packageRoot), buildInfo, 'Benchmark candidate changed during measurement');
for (const result of Object.values(report.scenarios)) {
  if (!result.cpuProfileDirectory) continue;
  result.cpuProfileFiles = (await readdir(result.cpuProfileDirectory)).filter(file => file.endsWith('.cpuprofile')
    && file.includes(`.${result.profileProcessId}.`))
    .map(file => path.join(result.cpuProfileDirectory, file));
  assert(result.cpuProfileFiles.length > 0, 'CPU profiler did not persist a profile on graceful shutdown');
}
console.log(JSON.stringify(report, null, 2));
if (argument('output')) {
  const output = path.resolve(argument('output'));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
if (process.argv.includes('--assert')) {
  for (const [name, result] of Object.entries(report.scenarios)) {
    if (result.movementAck.p95Ms > 60 || result.allClientFanout.p95Ms > 60) {
      throw new Error(`${name} LAN performance gate failed: ACK p95 ${result.movementAck.p95Ms} ms, final fanout p95 ${result.allClientFanout.p95Ms} ms; both must be <=60 ms`);
    }
    for (const type of ['status', 'chat', 'aggregate']) {
      const ack = result.otherPlayerOperations.ackMeasurement[type], fanout = result.otherPlayerOperations.measurement[type];
      assert.equal(ack.count, rounds * (type === 'aggregate' ? 8 : 4));
      assert.equal(fanout.count, ack.count);
      if (ack.p95Ms > 60 || fanout.p95Ms > 60) {
        throw new Error(`${name} concurrent ${type} performance gate failed: ACK p95 ${ack.p95Ms} ms, fanout p95 ${fanout.p95Ms} ms; both must be <=60 ms`);
      }
    }
  }
}
