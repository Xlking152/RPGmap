import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { verifyLocalValidation, visionSourceAtCommit } from '../scripts/verify-local-validation.mjs';
import { worldWalChecksum } from '../deployment/local-server/world-wal.mjs';
import { deriveSceneState } from '../src/engine/state.js';
import { sceneEventsHash } from '../scripts/ruins-lan-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40), baselineCommit = 'ed7e13baab0f116222333c20431e19ab63b60e37';
const baselineSource = await visionSourceAtCommit(root, baselineCommit);
const files = (await execFileAsync('git', ['ls-files', '-z', '--', 'src', 'deployment/local-server',
  'reference/maps/lanzhou/runtime.json'], { cwd: root })).stdout.split('\0').filter(file => /\.(js|mjs)$/.test(file)
    || file === 'reference/maps/lanzhou/runtime.json').sort();
const sourceFileHashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
  hash((await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n'))])));

// A small independent ZIP producer exercises the same stored and deflated
// archive formats used by Windows bsdtar and Linux release packaging.
function zip(entries, compressed = false, version = '2.5.4') {
  const crc32 = buffer => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const local = [], central = []; let offset = 0;
  for (const [file, text] of Object.entries(entries)) {
    const name = Buffer.from(`RPGmap-v${version}/${file}`), raw = Buffer.from(text);
    const payload = compressed ? deflateRawSync(raw) : raw, crc = crc32(raw);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(compressed ? 8 : 0, 10); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(payload.length, 20); directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, payload); central.push(directory, name); offset += header.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function latencies(values) {
  const sorted = [...values].sort((a, b) => a - b), at = q => sorted[Math.ceil(sorted.length * q) - 1];
  return { count: values.length, medianMs: at(0.5), p95Ms: at(0.95) };
}
function largeScenario(sourceCount) {
  const samples = Array.from({ length: 5 }, (_, index) => ({ round: index + 1, warmup: false,
    durableJobs: sourceCount, processedSamples: sourceCount * 171, jobsRemaining: 0, contextsRemaining: 0,
    referenceFogMatches: true, fogHash: hash(`fog-${sourceCount}`),
    requestLatencies: Array.from({ length: sourceCount }, (_, source) => ({ tokenId: `token-${source}`, ackMs: 10 + source, fanoutMs: 20 + source })),
    durableJobProofs: Array.from({ length: sourceCount }, (_, source) => ({ id: `job-${index}-${source}`,
      cursorAtCreation: 0, totalSamples: 171, completedDurably: true })),
    otherPlayerSamples: Array.from({ length: 8 }, (_, probeIndex) => {
      const type = probeIndex % 2 === 0 ? 'status' : 'chat', senderPlayer = 2 + Math.floor(probeIndex / 2);
      return { operationId: `occlusion-lan-probe-${sourceCount}-${index}-${probeIndex}`, type, senderPlayer,
        targetActorId: type === 'status' ? `actor-${senderPlayer - 1}` : null, revision: 10 + index * 10 + probeIndex,
        ackMs: 10 + probeIndex, fanoutMs: 20 + probeIndex,
        initialBaseRevision: 0, retryCount: 0, revisionConflicts: [],
        activeJobIdsAtCommit: [`job-${index}-0`], remainingSamplesAtCommit: 170,
        jobProgressAtCommit: [{ id: `job-${index}-0`, cursor: 1, totalSamples: 171 }] };
    }),
  }));
  const requests = samples.flatMap(sample => sample.requestLatencies);
  const probes = samples.flatMap(sample => sample.otherPlayerSamples);
  const otherPlayerOperations = { perRound: { status: 4, chat: 4 }, warmupSamples: 8, samples: 40,
    ackMeasurement: Object.fromEntries(['status', 'chat', 'aggregate'].map(type => [type,
      latencies(probes.filter(probe => type === 'aggregate' || probe.type === type).map(probe => probe.ackMs))])),
    measurement: Object.fromEntries(['status', 'chat', 'aggregate'].map(type => [type,
      latencies(probes.filter(probe => type === 'aggregate' || probe.type === type).map(probe => probe.fanoutMs))])) };
  return { sourceCount, parties: sourceCount, lighting: 'dark', lights: 3, rangeMeters: 1000, distanceMeters: 425,
    rounds: 5, warmupRounds: 1, warmupProcessedSamples: sourceCount * 171, processedSamples: 5 * sourceCount * 171,
    movementAck: latencies(requests.map(request => request.ackMs)), allClientFanout: latencies(requests.map(request => request.fanoutMs)), otherPlayerOperations, samples };
}
function phase(name, lighting) {
  return { name, seconds: 60, operations: 120, actualMoves: 120,
    scene: { lighting, lineOfSightEnabled: true, enabledTokenLights: lighting === 'dark' ? 3 : 0 },
    sessions: Array.from({ length: 7 }, (_, index) => {
      const tokenId = `browser-token-${index - 1}`, point = { x: index, y: 20 };
      return { name: index ? `Browser Player ${index}` : 'Browser GM', moves: index ? 20 : 0,
        sourceMismatches: 0, inputStimuli: 120, failures: [], exceptions: [],
        diagnostics: { averageFps: 60, metrics: {
          frame: { count: 3600, mean: 1000 / 60, p95: 16.7 }, 'input.frame': { count: 120, p95: 16.5 },
          longtask: { count: 1, max: 90 }, 'network.confirm': { count: 20, p95: 40 },
          'vision.draw': { count: 20 }, 'vision.worker': { count: 20 }, 'vision.feedback': { count: 20 },
        } },
        vision: index ? { tokenId, sourceTokenId: tokenId, token: point,
          source: { tokenId, ...point, lineOfSightEnabled: true, lighting },
          feedback: { rendered: true, source: point }, canvasReady: true, fogRows: 10, fogSpans: 10 } : null,
      };
    }),
  };
}
function timing(scale = 1) {
  return { samplesMs: [1, 2, 3, 4, 5].map(value => value * scale), medianMs: 3 * scale, p95Ms: 5 * scale,
    maxMs: 5 * scale, hash: hash('same visible cells') };
}
function ruinsRenderer() {
  return { renders: 40, maskBuilds: 10, reusedObjects: 20, ruinObjects: 2, craterObjects: 1, floodObjects: 0,
    cachedFeatureGeometry: 2, cachedNodes: 103, lastRenderMs: 2, maxRenderMs: 4,
    ruinObjectsLimit: 103, cachedNodesLimit: 103, featureGeometryLimit: 103, craterObjectsLimit: 1,
    inactiveRuins: 1, inactiveRuinsLimit: 103, largestRuinVersions: 2 };
}

test('v2.5.5 formal large-range LAN evidence rejects diagnostic profiling', async t => {
  const candidate = await fixture(t, false, '2.5.5');
  candidate.reports['large-lan.json'].diagnosticProfiling = true;
  await candidate.save();
  await assert.rejects(candidate.verify(), /LAN diagnostic profiling cannot be formal/);
});
function geometryCache() {
  return { entries: 82, features: 81, maxEntries: 512, maxVersionsPerFeature: 2,
    largestFeatureVersions: 2, hits: 100, misses: 82, evictions: 0, failures: 0 };
}
function ruinsFixture() {
  const eye = { x: 3628.528142813593, y: 1242.984768981114 };
  const feedback = (revision, x = eye.x) => ({ elapsedMs: 30, revision, stateRevision: revision,
    requestedAt: revision * 100, rendered: true, x, y: eye.y });
  const anchor = { x: '3400', y: '1400', width: '100', height: '100', viewBox: '0 0 100 100' };
  const image = (featureId, mask = 'url(#actual-damage-mask)', severeImages = 0) => ({ featureId, groups: 1,
    normalImages: 1, severeImages, taggedEntity: false, mask, anchor: structuredClone(anchor), href: '/rubble.webp' });
  return { passed: true, cleanup: true,
    reproduction: { area: { x: 3581.491689174436, y: 1553.9528916589916 }, radiusMeters: 206.80454093031585,
      source: eye, rangeMeters: 1000,
      first: { commitMs: 10, feedback: feedback(1) }, second: { commitMs: 10, feedback: feedback(2) },
      severe: { commitMs: 10, feedback: feedback(3) } },
    partial: image('partial'), overlap: image('partial'), severe: image('partial', 'url(#severe-mask)', 1),
    whole: { ...image('whole', null), originalHidden: true, destructionConfirmed: true },
    wholeAction: { action: 'damage', featureId: 'whole', commitMs: 10, feedback: feedback(4) },
    movementOrigin: {x:eye.x,y:1345},
    movement: [0.25, 2.5, 0].map((offset, index) => ({...feedback(index + 5, eye.x + offset),y:1345})),
    zoom: [-2, 0.25, 2, 0].map(zoom => ({ zoom, centerAlpha: 0 })),
    beforeReload: { diagnostics: ruinsRenderer(), queue: { queued: 0, running: false } },
    storageMode: 'persistent-offline',
    validationWorker: { started: true, liveCount: 1, asset: '/assets/world-validation-worker-fixture.js' },
    reload: { worldIdRetained: true, sceneEventsRetained: true, attackAreasRetained: true, anchorRetained: true },
    restore: { singleObjectOnly: true, independentCraterRetained: true,
      actions: ['whole', 'partial'].map((featureId, index) => ({ featureId, commitMs: 10, feedbackMs: 30, stateRevision: index + 8 })) },
    afterRestore: { diagnostics: ruinsRenderer(), remainingRuins: 2 },
    stress: { rounds: 12, samples: Array.from({ length: 12 }, (_, round) => ({ round, damageOk: true, restoreOk: true,
      damageCommitMs: 10, damageFeedbackMs: 30, restoreCommitMs: 10, restoreFeedbackMs: 30,
      damageFeedback: feedback(round * 2 + 10), restoreFeedback: feedback(round * 2 + 11),
      diagnostics: ruinsRenderer(), geometryCache: geometryCache() })),
      frames: { count: 24, samplesMs: Array(24).fill(16.5), averageFPS: 1000 / 16.5, p95Ms: 16.5 },
      observerSupported: true, startedAt: 0, endedAt: 1000, durationMs: 1000, longTasks: [], maxLongTaskMs: 0,
      damageP95Ms: 30, restoreP95Ms: 30,
      finalDiagnostics: ruinsRenderer(), finalGeometryCache: geometryCache(), finalQueue: { queued: 0, running: false } } };
}
function facadeFixture() {
  const axes = { geometryIds: ['rect', 'concave', 'hole', 'fragments'], elevations: [0, 15],
    sizes: [[400, 300], [401, 301]], dprs: [1, 1.25, 1.5, 2], scales: [0.25, 1, 3.5],
    modes: ['all', 'normal', 'dark-and-normal'], centers: [[173.37, 131.21], [-20.13, 80.27]] };
  const frames = () => [0, 1].map(frame => ({ frame, differingPixels: 0, maxChannelError: 0,
    maxEdgeErrorCss: 0, interiorLeakedPixels: 0, outsideEdgeHaloPixels: 0 }));
  const rawCases = [];
  for (const geometryId of axes.geometryIds) for (const elevationMeters of axes.elevations) for (const [width, height] of axes.sizes)
    for (const dpr of axes.dprs) for (const scale of axes.scales) for (const mode of axes.modes) for (const center of axes.centers)
      rawCases.push({ geometryId, elevationMeters, width, height, dpr, scale, mode, center, frames: frames() });
  return { passed: true, cases: 1152, framesPerCase: 2, axes, rawCases, differingPixels: 0, maxChannelError: 0,
    boundaryOracle: { kind: 'final-visible-vector', circleSegments: 2048, edgeToleranceCss: 1,
      fractionalCopies: 'legacy-chain', partialAlphaEdges: 'reference-compositing-operands' },
    maxEdgeErrorCss: 0, interiorLeakedPixels: 0, outsideEdgeHaloPixels: 0,
    regression: { sweepReproduced: true, records: axes.dprs.map(dpr => ({ dpr, completed: true,
      frames: [0, 1].map(frame => ({ frame, checkedInteriorPixels: 4000, visibleInteriorPixels: 2000,
        hiddenInteriorPixels: 2000, interiorLeakedPixels: 0, missingVisibleInteriorPixels: 0 })) })) } };
}
function ruinsLanFixture(common) {
  const featureId = 'house', sceneId = 'scene-packaged-smoke';
  const originalSceneEvents = [{ id: 'unrelated-damage', type: 'damage', objectIds: ['other'], clipHits: [],
    craterPolygon: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }] }];
  const polygon = Array.from({ length: 32 }, (_, index) => ({ x: 100 + 6 * Math.cos(index * Math.PI / 16),
    y: 100 + 6 * Math.sin(index * Math.PI / 16) }));
  const area = { shape: 'circle', origin: { x: 100, y: 100 }, radius: 6 };
  const events = [
    { id: 'partial-event', type: 'damage', objectIds: [], clipHits: [{ featureId, polygon }], areaSnapshot: structuredClone(area) },
    { id: 'lan-ruins-whole-event', type: 'damage', objectIds: [featureId], clipHits: [] },
    { id: 'restore-event', type: 'restore', featureIds: [featureId] },
  ];
  const histories = events.map((event, index) => [...originalSceneEvents, ...events.slice(0, index + 1)]);
  const samples = ['partial', 'whole', 'restore'].map((kind, index) => {
    const baseRevision = [10, 12, 16][index], revision = baseRevision + 1, operationId = `smoke-ruins-${kind}`;
    const walRecord = { walVersion: 2, operationId, baseRevision, revision, timestamp: '2026-10-06T05:00:00.000Z',
      patch: { world: { scenes: { content: [{ sceneId, sceneEvents: structuredClone(histories[index]) }] } } },
      results: [], explorationDelta: {} };
    walRecord.checksum = worldWalChecksum(walRecord);
    return { kind, operationId, baseRevision, revision, elapsedMs: 30,
      playerChange: { action: 'create', document: { type: 'SceneEvent', id: events[index].id,
        parent: { type: 'Scene', id: sceneId } }, changed: structuredClone(events[index]) },
      sceneEventsHash: sceneEventsHash(histories[index]), durableSceneEventsHash: sceneEventsHash(histories[index]),
      durableSceneEvents: structuredClone(histories[index]), canonicalSceneEvents: structuredClone(histories[index]),
      walRecord, walConfirmed: true, canonicalConfirmed: true };
  });
  const restart = index => ({ featureId, revision: samples[index].revision + 1,
    sceneEvents: structuredClone(histories[index]), effectiveDamage: deriveSceneState(histories[index]),
    sceneEventsHash: sceneEventsHash(histories[index]), expectedSceneEventsHash: sceneEventsHash(histories[index]),
    sceneEventsRetained: true, wholeDestructionRetained: index === 1, restorationRetained: index === 2,
    privateQueueAbsent: true, queueDrained: true });
  const featureStates = { house: { open: true, vision: { occluder: false }, custom: { label: 'manual Tag' } } };
  return { ...structuredClone(common), identity: true, audienceProjection: true, visionSource: true, documentMovePath: true,
    durableMovementAndPath: true, backgroundFogDrained: true, restartRecovery: true, diagnosticProfiling: false,
    ruinsLan: { ...structuredClone(common), passed: true, featureId, partialCoverage: 0.1,
      fixture: { mapId: 'northern-song-lanzhou-1104', sceneId, source: 'actual-package', area, partialEventId: events[0].id },
      originalSceneEvents, originalFeatureStates: structuredClone(featureStates), restoredFeatureStates: structuredClone(featureStates),
      samples, permissions: ['damage', 'restore'].map(kind => ({ kind, operationId: `smoke-ruins-player-${kind}`,
        code: 'scene_content_replace_gm_only', beforeRevision: 14, revision: 14, noRollbackState: true,
        sceneEvents: structuredClone(histories[1]), sceneEventsHash: sceneEventsHash(histories[1]),
        denial: { type: 'world.operation.denied', operationId: `smoke-ruins-player-${kind}`, code: 'scene_content_replace_gm_only' } })),
      reconnect: { identityRetained: true, identityStatus: 'active', userId: 'player-id', expectedUserId: 'player-id',
        worldId: 'world-id', expectedWorldId: 'world-id', sourceTokenId: 'smoke-pc-token',
        source: { tokenId: 'smoke-pc-token', x: 2940, y: 2500 },
        sceneEvents: structuredClone(histories[1]), sceneEventsHash: sceneEventsHash(histories[1]),
        wholeDestructionRetained: true, hiddenTokenAbsent: true },
      restart: restart(1), restoredRestart: restart(2),
      restoration: { singleObjectOnly: true, tagsAndDoorStateRetained: true, independentCraterRetained: true } } };
}

async function fixture(t, compressed = false, version = '2.5.4') {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-release-evidence-'));
  t.after(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('rpgmap-release-evidence-')) throw new Error('Unexpected fixture directory');
    await rm(directory, { recursive: true, force: true });
  });
  const metadata = { app: 'RPGmap', version, releaseTag: `v${version}`, commit };
  const entries = { 'VERSION.json': JSON.stringify(metadata), 'server.mjs': 'export const server = true;\n',
    'exploration-worker.mjs': 'export const worker = true;\n', 'app/index.html': '<script src="/assets/main.js"></script>',
    'app/.vite/manifest.json': '{"index.html":{"file":"assets/main.js"}}', 'app/assets/main.js': 'const fog = "continuous";\n' };
  const archive = zip(entries, compressed, version);
  const build = { metadata, fileHashes: Object.fromEntries(Object.keys(entries).filter(file => file !== 'VERSION.json')
    .sort().map(file => [file, hash(entries[file])])) };
  const common = { version, build };
  const summary = Object.fromEntries([['move', 100], ['status', 50], ['chat', 50], ['aggregate', 200]]
    .map(([name, count]) => [name, { count, medianMs: 20, p95Ms: 30 }]));
  const lan = { ...common, fixture: { actors: 100, tokens: 500, players: 6 }, warmup: 30,
    measurement: structuredClone(summary), ackMeasurement: structuredClone(summary), moveBytes: { requestMax: 450, responseMax: 550 } };
  const large = { ...common, diagnosticProfiling: false, fixture: { actors: 100, tokens: 500, players: 6, occluders: 81, nearbyOccluders: 51,
    fogCellSizeMeters: 5, pathSampleSpacingMeters: 2.5 },
  scenarios: { singleSource: largeScenario(1), sixConcurrentSources: largeScenario(6) } };
  const browser = { ...common, browser: 'chrome', headless: true,
    fixture: { actors: 100, tokens: 500, sessions: 7, viewport: '1920x1080' },
    phases: [phase('normal', 'normal'), phase('los-light', 'dark')],
    recovery: { outageDelayMs: 3000, recoveredMs: 4500, revisionsBefore: Array(7).fill(100), revisionsAfter: Array(7).fill(100),
      synchronizationComplete: true, projectionMatches: Array(7).fill(true) } };
  const base = { sourceCommit: baselineCommit, version: baselineSource.version, sourceHashEncoding: 'utf8-lf',
    sourceFileHashes: baselineSource.sourceFileHashes, occluders: 81,
    visibility: Object.fromEntries([120, 500, 1000, 10000].map(range => [range, timing()])), multiLight500: timing(), sweep: timing(10) };
  const candidate = { ...structuredClone(base), version, sourceCommit: commit, sourceFileHashes, sweep: timing(9),
    continuous: { ...Object.fromEntries([120, 500, 1000, 10000].map(range => [range, timing()])), multiLight1000: timing() } };
  const smoke = { ...structuredClone(common), diagnosticProfiling:false, mapReady: true, leaflet: true, occlusion: {
    zoom: [1, 1.25, 1.5, 2].map(dpr => ({ dpr, zoomLevels: 37, maxCenterAlpha: 0,
      animations: 1, maxProjectionError: 0.5, maxAnimationError: 0.9 })),
    editor: { drew: true, undoRedo: true, committed: true, reopened: true },
    feedback: { ranges: [120, 500, 1000].map(rangeMeters => ({ rangeMeters, effectiveRangeMeters: rangeMeters,
      samplesMs: Array.from({ length: 20 }, (_, index) => 20 + index), p95Ms: 38,
      phases: Array.from({ length: 20 }, (_, index) => ({ index, totalMs: 20 + index, commitMs: 5,
        maskWaitMs: 15 + index, expectedRevision: index + 1,
        previousVisual: { x: index, y: 0 }, target: { x: index + 1, y: 0 },
        feedbackState: { rendered: true, stateRevision: index + 1, x: index + 1, y: 0 } })) })),
      blackFlash: { inspectedFrames: 44, maxCenterAlpha: 0 }, queue: { queued: 0, running: false } } } };
  const raster = { cases: 2304, framesPerCase: 2, differingPixels: 0,
    maxChannelError: 0, maxAlphaError: 0, maxPremultipliedError: 0 };
  const audit = { metadata: { vulnerabilities: { total: 0 } } };
  const validation = { version, commit, baselineCommit, sha256: hash(archive),
    checks: Object.fromEntries(['tests', 'build', 'bundle', 'package', 'benchmark', 'lanBenchmark', 'chrome',
      'visionBenchmark', 'occlusionLanBenchmark', 'browserBenchmark'].map(check => [check, 'passed'])),
    evidence: { lanBenchmark: 'lan.json', occlusionLanBenchmark: 'large-lan.json', browserBenchmark: 'browser.json',
      visionBenchmark: { baseline: 'vision-v253.json', candidate: 'vision-v254.json' },
      chromeSmoke: 'chrome-smoke.json', maskRaster: 'raster.json',
      dependencyAudit: { all: 'audit.json', production: 'audit-production.json' } } };
  const reports = { 'lan.json': lan, 'large-lan.json': large, 'browser.json': browser,
    'vision-v253.json': base, 'vision-v254.json': candidate, 'chrome-smoke.json': smoke, 'raster.json': raster,
    'audit.json': audit, 'audit-production.json': structuredClone(audit) };
  if (version === '2.5.5') {
    const sourceProof = { version, sourceCommit: candidate.sourceCommit, sourceHashEncoding: candidate.sourceHashEncoding,
      sourceFileHashes: candidate.sourceFileHashes };
    Object.assign(raster, structuredClone(sourceProof));
    smoke.ruins = ruinsFixture();
    reports['facade-raster.json'] = { ...facadeFixture(), ...structuredClone(sourceProof) };
    validation.evidence.facadeRaster = 'facade-raster.json';
    reports['lan-vision.json'] = ruinsLanFixture(common);
    validation.evidence.ruinsLan = 'lan-vision.json';
  }
  const save = async () => {
    await writeFile(path.join(directory, 'local-validation.json'), JSON.stringify(validation));
    await Promise.all(Object.entries(reports).map(([file, report]) => writeFile(path.join(directory, file), JSON.stringify(report))));
  };
  await writeFile(path.join(directory, `RPGmap-v${version}.zip`), archive); await save();
  return { directory, entries, reports, validation, save, verify: () => verifyLocalValidation({ directory, version, commit }) };
}

for (const compressed of [false, true]) {
  test(`legitimate package-bound reports pass with ${compressed ? 'deflated' : 'stored'} ZIP`, async t => {
    const candidate = await fixture(t, compressed);
    await assert.doesNotReject(candidate.verify());
  });
}

test('passing labels without raw evidence cannot promote a package', async t => {
  const candidate = await fixture(t); delete candidate.validation.evidence; await candidate.save();
  await assert.rejects(candidate.verify(), /evidence file missing/);
});

test('old candidate and missing complete browser fingerprints are rejected', async t => {
  const candidate = await fixture(t), report = candidate.reports['browser.json'];
  report.build.metadata.commit = 'c'.repeat(40); await candidate.save();
  await assert.rejects(candidate.verify(), /build fingerprint/);
  report.build.metadata.commit = commit;
  delete report.build.fileHashes['app/assets/main.js']; await candidate.save();
  await assert.rejects(candidate.verify(), /build fingerprint/);
});

test('v2.5.5 Chrome and ruins smoke must fingerprint the actual package, including hidden browser assets', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['chrome-smoke.json']);
  for (const [change, message] of [
    [report => { delete report.version; }, /Chrome smoke report version mismatch/],
    [report => { report.version = '2.5.4'; }, /Chrome smoke report version mismatch/],
    [report => { delete report.build; }, /Chrome smoke report build fingerprint/],
    [report => { report.build.metadata.commit = 'c'.repeat(40); }, /Chrome smoke report build fingerprint/],
    [report => { delete report.build.fileHashes['app/.vite/manifest.json']; }, /Chrome smoke report build fingerprint/],
    [report => { report.build.fileHashes['app/assets/main.js'] = 'd'.repeat(64); }, /Chrome smoke report build fingerprint/],
  ]) {
    candidate.reports['chrome-smoke.json'] = structuredClone(original); change(candidate.reports['chrome-smoke.json']);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('v2.5.4 historical smoke remains compatible, while supplied fingerprints remain authoritative', async t => {
  const candidate = await fixture(t), smoke = candidate.reports['chrome-smoke.json'];
  delete smoke.version; delete smoke.build; await candidate.save();
  await assert.doesNotReject(candidate.verify());
  smoke.version = '2.5.4'; smoke.build = structuredClone(candidate.reports['browser.json'].build);
  smoke.build.fileHashes['app/assets/main.js'] = 'd'.repeat(64); await candidate.save();
  await assert.rejects(candidate.verify(), /Chrome smoke report build fingerprint/);
});

test('a changed frontend in the ZIP is rejected even with updated ZIP checksum', async t => {
  const candidate = await fixture(t);
  candidate.entries['app/assets/main.js'] = 'const fog = "old grid";\n';
  const changed = zip(candidate.entries);
  await writeFile(path.join(candidate.directory, 'RPGmap-v2.5.4.zip'), changed);
  candidate.validation.sha256 = hash(changed); await candidate.save();
  await assert.rejects(candidate.verify(), /build fingerprint/);
});

test('failed LAN results cannot be relabeled as passed', async t => {
  const candidate = await fixture(t);
  candidate.reports['lan.json'].ackMeasurement.aggregate.p95Ms = 60.001;
  await candidate.save(); await assert.rejects(candidate.verify(), /LAN aggregate latency gate/);
});

test('one-round diagnostic, missing samples, and incomplete durable jobs are rejected', async t => {
  const candidate = await fixture(t), scenario = candidate.reports['large-lan.json'].scenarios.sixConcurrentSources;
  scenario.rounds = 1; await candidate.save(); await assert.rejects(candidate.verify(), /five complete warmed rounds/);
  scenario.rounds = 5; scenario.samples[0].processedSamples = 1025;
  await candidate.save(); await assert.rejects(candidate.verify(), /exploration proof invalid/);
  scenario.samples[0].processedSamples = 1026; scenario.samples[0].durableJobProofs[0].completedDurably = false;
  await candidate.save(); await assert.rejects(candidate.verify(), /exploration proof invalid/);
});

test('large LAN summaries must agree with the raw samples', async t => {
  const candidate = await fixture(t), scenario = candidate.reports['large-lan.json'].scenarios.sixConcurrentSources;
  scenario.samples[0].requestLatencies[0].ackMs = 70;
  scenario.samples[1].requestLatencies[0].ackMs = 80;
  await candidate.save(); await assert.rejects(candidate.verify(), /raw samples disagree/);
});

test('no-op moves, wrong sources, missing vision, and wrong lighting are rejected', async t => {
  const candidate = await fixture(t), report = candidate.reports['browser.json'];
  const original = structuredClone(report);
  for (const change of [
    current => { current.phases[0].actualMoves = 0; },
    current => { current.phases[0].sessions[1].sourceMismatches = 1; },
    current => { current.phases[0].sessions[1].vision = null; },
    current => { current.phases[1].scene.lighting = 'normal'; },
  ]) {
    candidate.reports['browser.json'] = structuredClone(original); change(candidate.reports['browser.json']);
    await candidate.save(); await assert.rejects(candidate.verify(), /fixture invalid|source invalid|vision\/Fog proof invalid/);
  }
});

test('diagnostic Chrome profiling cannot promote a package even if every metric passes', async t => {
  const candidate = await fixture(t);
  candidate.reports['browser.json'].diagnosticProfileSession = 4;
  await candidate.save();
  await assert.rejects(candidate.verify(), /Diagnostic browser profiles/);
});

test('Chrome metrics preserve strict FPS, frame, input, long-task and network limits', async t => {
  const candidate = await fixture(t), original = structuredClone(candidate.reports['browser.json']);
  const cases = [
    [session => { session.diagnostics.averageFps = 57.999; }, /frame gate/],
    [session => { session.diagnostics.metrics.frame.p95 = 20.001; }, /frame gate/],
    [session => { session.diagnostics.metrics['input.frame'].p95 = 16.701; }, /input gate/],
    [session => { session.diagnostics.metrics['input.frame'].p95 = 16.700001; }, /input gate/],
    [session => { session.diagnostics.metrics.longtask.max = 100.001; }, /long task gate/],
    [session => { session.diagnostics.metrics['network.confirm'].p95 = 60.001; }, /confirmation gate/],
  ];
  for (const [change, message] of cases) {
    candidate.reports['browser.json'] = structuredClone(original); change(candidate.reports['browser.json'].phases[0].sessions[1]);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('raw Chrome timestamp subtraction noise at 16.7 ms preserves the original input budget', async t => {
  const candidate = await fixture(t);
  candidate.reports['browser.json'].phases[0].sessions[1].diagnostics.metrics['input.frame'].p95 = 16.700000047683716;
  await candidate.save(); await assert.doesNotReject(candidate.verify());
});

test('v2.5.5 Chrome FPS must match its finite positive observed frame mean', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['browser.json']);
  for (const change of [
    session => { delete session.diagnostics.metrics.frame.mean; },
    session => { session.diagnostics.metrics.frame.mean = 0; },
    session => { session.diagnostics.metrics.frame.mean = -1; },
    session => { session.diagnostics.metrics.frame.mean = Infinity; },
    session => { session.diagnostics.metrics.frame.mean = 50; },
    session => { session.diagnostics.averageFps = 120; },
  ]) {
    candidate.reports['browser.json'] = structuredClone(original); change(candidate.reports['browser.json'].phases[0].sessions[1]);
    await candidate.save(); await assert.rejects(candidate.verify(), /FPS differs from the observed frame mean/);
  }
});

test('v2.5.4 historical browser evidence remains compatible without a frame mean', async t => {
  const candidate = await fixture(t);
  for (const phase of candidate.reports['browser.json'].phases) for (const session of phase.sessions) delete session.diagnostics.metrics.frame.mean;
  await candidate.save(); await assert.doesNotReject(candidate.verify());
});

test('dropped input observations and incomplete reconnect projection are rejected', async t => {
  const candidate = await fixture(t), report = candidate.reports['browser.json'];
  report.phases[0].sessions[1].diagnostics.metrics['input.frame'].count = 119;
  await candidate.save(); await assert.rejects(candidate.verify(), /input gate/);
  report.phases[0].sessions[1].diagnostics.metrics['input.frame'].count = 120;
  report.recovery.synchronizationComplete = false;
  await candidate.save(); await assert.rejects(candidate.verify(), /reconnect gate/);
  report.recovery.synchronizationComplete = true; report.recovery.projectionMatches[1] = false;
  await candidate.save(); await assert.rejects(candidate.verify(), /reconnect gate/);
});

test('vision fingerprints, complete timings, output equality and non-regression are required', async t => {
  const candidate = await fixture(t), original = structuredClone(candidate.reports['vision-v254.json']);
  for (const [change, message] of [
    [report => { report.sourceCommit = baselineCommit; }, /source commit/],
    [report => { delete report.sourceHashEncoding; }, /fingerprint encoding missing/],
    [report => { delete report.sourceFileHashes['src/spatial/kernel.js']; }, /fingerprint is incomplete/],
    [report => { report.sourceFileHashes['src/spatial/kernel.js'] = 'd'.repeat(64); }, /fingerprint mismatch/],
    [report => { report.sweep.hash = 'e'.repeat(64); }, /sweep output differs/],
    [report => { report.sweep = timing(11); }, /historical exploration regressed/],
    [report => { report.visibility[1000].samplesMs = [1]; }, /five-round timing/],
  ]) {
    candidate.reports['vision-v254.json'] = structuredClone(original); change(candidate.reports['vision-v254.json']);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('baseline complete fingerprints and version must match the immutable claimed Git commit', async t => {
  const candidate = await fixture(t), original = structuredClone(candidate.reports['vision-v253.json']);
  for (const [change, message] of [
    [report => { delete report.sourceFileHashes['src/spatial/kernel.js']; }, /baseline source fingerprint is incomplete/],
    [report => { report.sourceFileHashes['src/spatial/kernel.js'] = 'd'.repeat(64); }, /baseline source fingerprint mismatch/],
    [report => { report.sourceFileHashes['src/unmeasured-fake.js'] = 'd'.repeat(64); }, /baseline source fingerprint is incomplete/],
    [report => { report.version = '2.5.3'; }, /baseline version mismatch/],
  ]) {
    candidate.reports['vision-v253.json'] = structuredClone(original); change(candidate.reports['vision-v253.json']);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('v2.5.5 baseline is fixed to the released v2.5.4 source instead of a self-declared SHA', async t => {
  const candidate = await fixture(t, false, '2.5.5');
  candidate.validation.baselineCommit = 'b'.repeat(40);
  candidate.reports['vision-v253.json'].sourceCommit = candidate.validation.baselineCommit;
  await candidate.save(); await assert.rejects(candidate.verify(), /released v2.5.4 commit/);
});

test('evidence cannot escape the downloaded candidate directory', async t => {
  const candidate = await fixture(t);
  candidate.validation.evidence.lanBenchmark = '../old-report.json'; await candidate.save();
  await assert.rejects(candidate.verify(), /outside candidate/);
});

test('ordinary probes must commit during unfinished large-range exploration', async t => {
  const candidate = await fixture(t), original = structuredClone(candidate.reports['large-lan.json']);
  for (const [change, message] of [
    [scenario => { delete scenario.samples[0].otherPlayerSamples; }, /operations during exploration missing/],
    [scenario => { scenario.samples[0].otherPlayerSamples[0].jobProgressAtCommit[0].cursor = 171; }, /unfinished path samples/],
    [scenario => { scenario.samples[0].otherPlayerSamples[0].activeJobIdsAtCommit = ['unrelated-job']; }, /active path IDs/],
    [scenario => { scenario.samples[0].otherPlayerSamples[0].remainingSamplesAtCommit = 0; }, /sample count disagrees/],
    [scenario => {
      Object.assign(scenario.samples[0].otherPlayerSamples[0], {
        retryCount: 1, revisionConflicts: [{ revision: 1, elapsedMs: 11 }],
      });
    }, /conflict retry timing\/revision invalid/],
    [scenario => { scenario.otherPlayerOperations.ackMeasurement.status.p95Ms = 60.001; }, /ordinary status.*latency gate/],
    [scenario => { scenario.samples[0].otherPlayerSamples[0].ackMs = 59; }, /raw samples disagree/],
  ]) {
    candidate.reports['large-lan.json'] = structuredClone(original);
    change(candidate.reports['large-lan.json'].scenarios.sixConcurrentSources); await candidate.save();
    await assert.rejects(candidate.verify(), message);
  }
});

test('Chrome smoke rejects missing or duplicate DPR/ranges, fake feedback and incomplete masks', async t => {
  const candidate = await fixture(t), original = structuredClone(candidate.reports['chrome-smoke.json']);
  for (const [change, message] of [
    [report => { report.occlusion.zoom[3].dpr = 1; }, /DPR coverage differs/],
    [report => { report.occlusion.feedback.ranges = []; }, /range coverage missing/],
    [report => { report.occlusion.feedback.ranges[2].rangeMeters = 500; }, /range coverage differs/],
    [report => { report.occlusion.feedback.ranges[0].samplesMs.pop(); }, /raw feedback samples missing/],
    [report => { report.occlusion.feedback.ranges[0].p95Ms = 1; }, /p95 gate failed/],
    [report => { report.occlusion.feedback.ranges[0].phases[0].feedbackState.rendered = false; }, /complete-mask proof invalid/],
    [report => { report.occlusion.feedback.blackFlash.inspectedFrames = 0; }, /black-flash\/queue gate/],
    [report => { report.occlusion.editor.committed = false; }, /editor proof/],
  ]) {
    candidate.reports['chrome-smoke.json'] = structuredClone(original); change(candidate.reports['chrome-smoke.json']);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('release requires original zero-error raster and both zero-vulnerability audits', async t => {
  const candidate = await fixture(t);
  candidate.reports['raster.json'].framesPerCase = 1; await candidate.save();
  await assert.rejects(candidate.verify(), /raster gate failed/);
  candidate.reports['raster.json'].framesPerCase = 2;
  candidate.reports['audit-production.json'].metadata.vulnerabilities.total = 1; await candidate.save();
  await assert.rejects(candidate.verify(), /Production dependency audit gate/);
  candidate.reports['audit-production.json'].metadata.vulnerabilities.total = 0;
  delete candidate.validation.evidence.chromeSmoke; await candidate.save();
  await assert.rejects(candidate.verify(), /Chrome smoke evidence file missing/);
});

for (const compressed of [false, true]) {
  test(`v2.5.5 requires and accepts full ruins/facade raw evidence with ${compressed ? 'deflated' : 'stored'} ZIP`, async t => {
    const candidate = await fixture(t, compressed, '2.5.5');
    await assert.doesNotReject(candidate.verify());
  });
}

test('v2.5.5 mask and facade raster must bind their complete source proof to the measured vision candidate', async t => {
  const candidate = await fixture(t, false, '2.5.5');
  for (const file of ['raster.json', 'facade-raster.json']) {
    const original = structuredClone(candidate.reports[file]);
    for (const [change, message] of [
      [report => { delete report.sourceCommit; }, /source identity mismatch/],
      [report => { report.sourceCommit = baselineCommit; }, /source identity mismatch/],
      [report => { report.version = '2.5.4'; }, /source identity mismatch/],
      [report => { report.sourceHashEncoding = 'utf8-crlf'; }, /source fingerprint encoding/],
      [report => { delete report.sourceFileHashes; }, /complete source fingerprint missing/],
      [report => { delete report.sourceFileHashes['src/spatial/kernel.js']; }, /source proof differs/],
      [report => { report.sourceFileHashes['src/vision/mask-renderer.js'] = 'd'.repeat(64); }, /source proof differs/],
      [report => { report.sourceFileHashes['src/unmeasured-extra.js'] = 'd'.repeat(64); }, /source proof differs/],
    ]) {
      candidate.reports[file] = structuredClone(original); change(candidate.reports[file]);
      await candidate.save(); await assert.rejects(candidate.verify(), message);
    }
    candidate.reports[file] = original;
  }
});

test('v2.5.5 passing labels without ruins and facade evidence cannot promote a package', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['chrome-smoke.json'].ruins);
  delete candidate.reports['chrome-smoke.json'].ruins; await candidate.save();
  await assert.rejects(candidate.verify(), /Ruins SweepEvent reproduction fixture/);
  candidate.reports['chrome-smoke.json'].ruins = original;
  delete candidate.validation.evidence.facadeRaster; await candidate.save();
  await assert.rejects(candidate.verify(), /facade raster evidence file missing/);
});

test('v2.5.5 requires actual package-bound LAN destruction and rejects forged WAL/history/recovery summaries', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['lan-vision.json']);
  delete candidate.validation.evidence.ruinsLan; await candidate.save();
  await assert.rejects(candidate.verify(), /Ruins LAN evidence file missing/);
  candidate.validation.evidence.ruinsLan = 'lan-vision.json';
  for (const [change, message] of [
    [report => { report.build.fileHashes['app/assets/main.js'] = 'd'.repeat(64); }, /Ruins LAN report build fingerprint/],
    [report => { report.diagnosticProfiling = true; }, /baseline\/profile proof/],
    [report => { report.ruinsLan.build.metadata.commit = baselineCommit; }, /destruction report build fingerprint/],
    [report => { report.ruinsLan.samples.pop(); }, /three transactions/],
    [report => { report.ruinsLan.samples[0].revision = report.ruinsLan.samples[0].baseRevision; }, /raw revision/],
    [report => { report.ruinsLan.samples[0].playerChange.document.parent.id = 'another-scene'; }, /actual Player SceneEvent/],
    [report => { report.ruinsLan.samples[0].playerChange.changed.clipHits[0].featureId = 'other'; }, /range geometry/],
    [report => { report.ruinsLan.samples[0].durableSceneEvents = []; }, /durable history/],
    [report => { report.ruinsLan.samples[0].canonicalSceneEvents = []; }, /canonical history/],
    [report => { report.ruinsLan.samples[0].sceneEventsHash = 'd'.repeat(64); }, /raw history hash/],
    [report => { report.ruinsLan.samples[0].walRecord.checksum = 'd'.repeat(64); }, /WAL record\/checksum/],
    [report => {
      const wal = report.ruinsLan.samples[0].walRecord; wal.patch.world.scenes.content[0].sceneEvents = [];
      wal.checksum = worldWalChecksum(wal);
    }, /WAL history/],
    [report => { report.ruinsLan.permissions[0].denial.state = {}; }, /raw denial/],
    [report => { report.ruinsLan.permissions[1].revision += 1; }, /raw denial/],
    [report => { report.ruinsLan.permissions[1].sceneEvents = []; }, /changed damage history/],
    [report => { report.ruinsLan.reconnect.userId = 'another-player'; }, /identity\/source reconnect/],
    [report => { report.ruinsLan.reconnect.sceneEvents = []; }, /reconnect lost/],
    [report => { report.ruinsLan.restart.sceneEvents = []; }, /restart lost durable history/],
    [report => { report.ruinsLan.restoredRestart.effectiveDamage.damagedFeatureIds.push('house'); }, /effective destruction/],
    [report => { report.ruinsLan.restoredFeatureStates.house.open = false; }, /Tag\/door overrides/],
    [report => { report.ruinsLan.restoration.singleObjectOnly = false; }, /restoration scope/],
  ]) {
    candidate.reports['lan-vision.json'] = structuredClone(original); change(candidate.reports['lan-vision.json']);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('v2.5.5 ruins gate rejects fake regression, wrong cut masks, entity tags and shifted textures', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['chrome-smoke.json'].ruins);
  for (const [change, message] of [
    [report => { report.reproduction.area.x += 1; }, /attack differs/],
    [report => { report.reproduction.first.feedback.rendered = false; }, /completed-mask/],
    [report => { report.reproduction.first.feedback.x += 2; }, /confirmed position/],
    [report => { report.partial.mask = null; }, /actual-cut mask missing/],
    [report => { report.partial.taggedEntity = true; }, /untagged texture/],
    [report => { report.overlap.anchor.x = '3401'; }, /world anchor/],
    [report => { report.severe.severeImages = 0; }, /behavior proof/],
    [report => { report.whole.originalHidden = false; }, /behavior proof/],
    [report => { report.movement.pop(); }, /movement samples/],
    [report => { report.zoom[0].centerAlpha = 255; }, /became opaque/],
  ]) {
    candidate.reports['chrome-smoke.json'].ruins = structuredClone(original); change(candidate.reports['chrome-smoke.json'].ruins);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('v2.5.5 ruins gate requires saved damage, isolated restoration and drained queues', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['chrome-smoke.json'].ruins);
  for (const [change, message] of [
    [report => { report.storageMode = 'memory-overlay'; }, /persistence/],
    [report => { delete report.validationWorker; }, /Module Worker/],
    [report => { report.validationWorker.started = false; }, /Module Worker/],
    [report => { report.validationWorker.liveCount = 2; }, /Module Worker/],
    [report => { report.validationWorker.asset = '/assets/visibility-worker-fixture.js'; }, /Module Worker/],
    [report => { report.reload.worldIdRetained = false; }, /persistence/],
    [report => { report.reload.sceneEventsRetained = false; }, /persistence/],
    [report => { report.restore.singleObjectOnly = false; }, /persistence/],
    [report => { report.restore.actions[1].featureId = 'unrelated'; }, /restoration targets/],
    [report => { report.restore.independentCraterRetained = false; }, /persistence/],
    [report => { report.beforeReload.queue.running = true; }, /before reload exploration/],
    [report => { report.stress.finalQueue.queued = 1; }, /final exploration/],
  ]) {
    candidate.reports['chrome-smoke.json'].ruins = structuredClone(original); change(candidate.reports['chrome-smoke.json'].ruins);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('v2.5.5 ruins stress gate validates twelve actual operations and bounded renderer/geometry caches', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['chrome-smoke.json'].ruins);
  for (const [change, message] of [
    [report => { report.stress.samples.pop(); }, /twelve complete rounds/],
    [report => { report.stress.samples[0].restoreOk = false; }, /actual operation/],
    [report => { report.stress.samples[0].restoreFeedback.revision = report.stress.samples[0].damageFeedback.revision; }, /revisions did not advance/],
    [report => { report.stress.samples[0].diagnostics.ruinObjects = 104; }, /renderer cache limit/],
    [report => { report.stress.samples[0].diagnostics.featureGeometryLimit = 1000; }, /renderer cache limit/],
    [report => { report.stress.samples[0].diagnostics.inactiveRuins = 104; }, /renderer cache limit/],
    [report => { report.stress.samples[0].diagnostics.largestRuinVersions = 3; }, /renderer cache limit/],
    [report => { report.stress.samples[0].geometryCache.entries = 513; }, /geometry cache bounds/],
    [report => { report.stress.samples[0].geometryCache.largestFeatureVersions = 3; }, /geometry cache bounds/],
    [report => { delete report.stress.samples[0].geometryCache; }, /geometry cache bounds/],
    [report => { report.stress.finalGeometryCache.maxEntries = 1024; }, /geometry cache bounds/],
  ]) {
    candidate.reports['chrome-smoke.json'].ruins = structuredClone(original); change(candidate.reports['chrome-smoke.json'].ruins);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('v2.5.5 ruins stress preserves feedback, FPS, frame and long-task gates from raw observations', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['chrome-smoke.json'].ruins);
  for (const [change, message] of [
    [report => { report.stress.samples[0].damageFeedbackMs = report.stress.samples[0].damageFeedback.elapsedMs = 100.001;
      report.stress.damageP95Ms = 100.001; }, /damage feedback p95/],
    [report => { report.stress.samples[0].restoreFeedbackMs = report.stress.samples[0].restoreFeedback.elapsedMs = 100.001;
      report.stress.restoreP95Ms = 100.001; }, /restore feedback p95/],
    [report => { report.stress.damageP95Ms = 1; }, /damage feedback p95/],
    [report => { report.stress.samples[0].damageFeedback.elapsedMs = 1; }, /raw samples disagree/],
    [report => { report.stress.frames.samplesMs.pop(); }, /raw frame observations/],
    [report => { report.stress.frames.p95Ms = 1; }, /frame summary/],
    [report => { report.stress.frames.samplesMs = Array(24).fill(21); report.stress.frames.p95Ms = 21;
      report.stress.frames.averageFPS = 1000 / 21; }, /frame summary/],
    [report => { report.stress.observerSupported = false; }, /raw long-task/],
    [report => { report.stress.longTasks = [{ startTime: 2, duration: 100.001 }]; report.stress.maxLongTaskMs = 100.001; }, /long-task gate/],
    [report => { report.stress.longTasks = [{ startTime: 2, duration: 90 }]; report.stress.maxLongTaskMs = 0; }, /long-task gate/],
  ]) {
    candidate.reports['chrome-smoke.json'].ruins = structuredClone(original); change(candidate.reports['chrome-smoke.json'].ruins);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('v2.5.5 facade raster gate requires every raw geometry/viewport/DPR case and both frames', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['facade-raster.json']);
  for (const [change, message] of [
    [report => { report.passed = false; }, /1152 raw cases/],
    [report => { report.rawCases.pop(); }, /1152 raw cases/],
    [report => { report.rawCases[1] = structuredClone(report.rawCases[0]); }, /duplicated/],
    [report => { report.axes.dprs[3] = 1; }, /coverage differs/],
    [report => { delete report.boundaryOracle; }, /vector boundary proof/],
    [report => { report.boundaryOracle.kind = 'nearest-raster-neighbor'; }, /vector boundary proof/],
    [report => { report.boundaryOracle.edgeToleranceCss = 1.01; }, /vector boundary proof/],
    [report => { report.diagnosticSubset = true; }, /Diagnostic facade raster/],
    [report => { delete report.boundaryOracle.partialAlphaEdges; }, /vector boundary proof/],
    [report => { report.rawCases[0].frames.pop(); }, /case missing/],
    [report => { report.rawCases[0].frames[1].frame = 0; }, /frame edge/],
    [report => { report.rawCases[0].frames[0].interiorLeakedPixels = 1; }, /frame edge/],
    [report => { report.rawCases[0].frames[0].outsideEdgeHaloPixels = 1; }, /frame edge/],
    [report => { report.rawCases[0].frames[0].maxEdgeErrorCss = 1.001; }, /frame edge/],
    [report => { report.differingPixels = 1; }, /disagree with summary/],
  ]) {
    candidate.reports['facade-raster.json'] = structuredClone(original); change(candidate.reports['facade-raster.json']);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('v2.5.5 facade raster original SweepEvent fixture must render real visible and hidden interiors', async t => {
  const candidate = await fixture(t, false, '2.5.5'), original = structuredClone(candidate.reports['facade-raster.json']);
  for (const [change, message] of [
    [report => { report.regression.sweepReproduced = false; }, /original SweepEvent/],
    [report => { report.regression.records[3].dpr = 1; }, /SweepEvent DPR/],
    [report => { report.regression.records[0].completed = false; }, /SweepEvent frames/],
    [report => { report.regression.records[0].frames[0].visibleInteriorPixels = 0; }, /actual visible\/hidden/],
    [report => { report.regression.records[0].frames[0].checkedInteriorPixels = 1; }, /actual visible\/hidden/],
    [report => { report.regression.records[0].frames[0].missingVisibleInteriorPixels = 1; }, /actual visible\/hidden/],
  ]) {
    candidate.reports['facade-raster.json'] = structuredClone(original); change(candidate.reports['facade-raster.json']);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
});

test('release ZIP cannot accidentally bundle the independent ruins authoring library', async t => {
  const candidate = await fixture(t, false, '2.5.5');
  candidate.entries['素材库/废墟/unused.webp'] = 'authoring-only texture';
  const archive = zip(candidate.entries, false, '2.5.5');
  await writeFile(path.join(candidate.directory, 'RPGmap-v2.5.5.zip'), archive);
  candidate.validation.sha256 = hash(archive); await candidate.save();
  await assert.rejects(candidate.verify(), /complete ruins authoring library/);
});
