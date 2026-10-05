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
import { verifyLocalValidation } from '../scripts/verify-local-validation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40), baselineCommit = 'b'.repeat(40);
const files = (await execFileAsync('git', ['ls-files', '-z', '--', 'src', 'deployment/local-server',
  'reference/maps/lanzhou/runtime.json'], { cwd: root })).stdout.split('\0').filter(file => /\.(js|mjs)$/.test(file)
    || file === 'reference/maps/lanzhou/runtime.json').sort();
const sourceFileHashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
  hash((await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n'))])));

// A small independent ZIP producer exercises the same stored and deflated
// archive formats used by Windows bsdtar and Linux release packaging.
function zip(entries, compressed = false) {
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
    const name = Buffer.from(`RPGmap-v2.5.4/${file}`), raw = Buffer.from(text);
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
          frame: { count: 3600, p95: 16.7 }, 'input.frame': { count: 120, p95: 16.5 },
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
async function fixture(t, compressed = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-release-evidence-'));
  t.after(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('rpgmap-release-evidence-')) throw new Error('Unexpected fixture directory');
    await rm(directory, { recursive: true, force: true });
  });
  const metadata = { app: 'RPGmap', version: '2.5.4', releaseTag: 'v2.5.4', commit };
  const entries = { 'VERSION.json': JSON.stringify(metadata), 'server.mjs': 'export const server = true;\n',
    'exploration-worker.mjs': 'export const worker = true;\n', 'app/index.html': '<script src="/assets/main.js"></script>',
    'app/.vite/manifest.json': '{"index.html":{"file":"assets/main.js"}}', 'app/assets/main.js': 'const fog = "continuous";\n' };
  const archive = zip(entries, compressed);
  const build = { metadata, fileHashes: Object.fromEntries(Object.keys(entries).filter(file => file !== 'VERSION.json')
    .sort().map(file => [file, hash(entries[file])])) };
  const common = { version: '2.5.4', build };
  const summary = Object.fromEntries([['move', 100], ['status', 50], ['chat', 50], ['aggregate', 200]]
    .map(([name, count]) => [name, { count, medianMs: 20, p95Ms: 30 }]));
  const lan = { ...common, fixture: { actors: 100, tokens: 500, players: 6 }, warmup: 30,
    measurement: structuredClone(summary), ackMeasurement: structuredClone(summary), moveBytes: { requestMax: 450, responseMax: 550 } };
  const large = { ...common, fixture: { actors: 100, tokens: 500, players: 6, occluders: 81, nearbyOccluders: 51,
    fogCellSizeMeters: 5, pathSampleSpacingMeters: 2.5 },
  scenarios: { singleSource: largeScenario(1), sixConcurrentSources: largeScenario(6) } };
  const browser = { ...common, browser: 'chrome', headless: true,
    fixture: { actors: 100, tokens: 500, sessions: 7, viewport: '1920x1080' },
    phases: [phase('normal', 'normal'), phase('los-light', 'dark')],
    recovery: { outageDelayMs: 3000, recoveredMs: 4500, revisionsBefore: Array(7).fill(100), revisionsAfter: Array(7).fill(100),
      synchronizationComplete: true, projectionMatches: Array(7).fill(true) } };
  const base = { sourceCommit: baselineCommit, version: '2.5.3', sourceHashEncoding: 'utf8-lf', sourceFileHashes, occluders: 81,
    visibility: Object.fromEntries([120, 500, 1000, 10000].map(range => [range, timing()])), multiLight500: timing(), sweep: timing(10) };
  const candidate = { ...structuredClone(base), version: '2.5.4', sourceCommit: commit, sweep: timing(9),
    continuous: { ...Object.fromEntries([120, 500, 1000, 10000].map(range => [range, timing()])), multiLight1000: timing() } };
  const smoke = { mapReady: true, leaflet: true, occlusion: {
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
  const validation = { version: '2.5.4', commit, baselineCommit, sha256: hash(archive),
    checks: Object.fromEntries(['tests', 'build', 'bundle', 'package', 'benchmark', 'lanBenchmark', 'chrome',
      'visionBenchmark', 'occlusionLanBenchmark', 'browserBenchmark'].map(check => [check, 'passed'])),
    evidence: { lanBenchmark: 'lan.json', occlusionLanBenchmark: 'large-lan.json', browserBenchmark: 'browser.json',
      visionBenchmark: { baseline: 'vision-v253.json', candidate: 'vision-v254.json' },
      chromeSmoke: 'chrome-smoke.json', maskRaster: 'raster.json',
      dependencyAudit: { all: 'audit.json', production: 'audit-production.json' } } };
  const reports = { 'lan.json': lan, 'large-lan.json': large, 'browser.json': browser,
    'vision-v253.json': base, 'vision-v254.json': candidate, 'chrome-smoke.json': smoke, 'raster.json': raster,
    'audit.json': audit, 'audit-production.json': structuredClone(audit) };
  const save = async () => {
    await writeFile(path.join(directory, 'local-validation.json'), JSON.stringify(validation));
    await Promise.all(Object.entries(reports).map(([file, report]) => writeFile(path.join(directory, file), JSON.stringify(report))));
  };
  await writeFile(path.join(directory, 'RPGmap-v2.5.4.zip'), archive); await save();
  return { directory, entries, reports, validation, save, verify: () => verifyLocalValidation({ directory, version: '2.5.4', commit }) };
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
    [session => { session.diagnostics.metrics.longtask.max = 100.001; }, /long task gate/],
    [session => { session.diagnostics.metrics['network.confirm'].p95 = 60.001; }, /confirmation gate/],
  ];
  for (const [change, message] of cases) {
    candidate.reports['browser.json'] = structuredClone(original); change(candidate.reports['browser.json'].phases[0].sessions[1]);
    await candidate.save(); await assert.rejects(candidate.verify(), message);
  }
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
