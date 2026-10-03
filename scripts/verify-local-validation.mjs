import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const requiredChecks = ['tests', 'build', 'bundle', 'package', 'benchmark', 'lanBenchmark', 'chrome'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireCondition(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  try { assert.deepEqual(actual, expected); } catch { throw new Error(message); }
}

// Read the candidate itself rather than trusting a second manually supplied
// fingerprint. Local packages are ordinary, single-disk ZIP32 archives.
function archiveBuild(archive, version) {
  let end = archive.length - 22;
  for (; end >= Math.max(0, archive.length - 65_557); end--) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
  }
  requireCondition(end >= 0 && archive.readUInt32LE(end) === 0x06054b50, 'Candidate ZIP directory missing');
  const entries = archive.readUInt16LE(end + 10), offset = archive.readUInt32LE(end + 16);
  requireCondition(archive.readUInt32LE(end + 4) === 0 && archive.readUInt16LE(end + 8) === entries
    && entries !== 0xffff && offset !== 0xffffffff, 'Candidate ZIP must be a single-disk ZIP32 archive');
  const prefix = `RPGmap-v${version}/`, files = new Map();
  let cursor = offset, totalBytes = 0;
  for (let index = 0; index < entries; index++) {
    requireCondition(cursor + 46 <= end && archive.readUInt32LE(cursor) === 0x02014b50, 'Candidate ZIP directory invalid');
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20), size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32), local = archive.readUInt32LE(cursor + 42);
    requireCondition(cursor + 46 + nameLength + extraLength + commentLength <= end, 'Candidate ZIP directory truncated');
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    requireCondition(name.startsWith(prefix) && !name.includes('\\') && !name.split('/').includes('..'), 'Candidate ZIP entry outside package');
    if (name.endsWith('/')) continue;
    const relative = name.slice(prefix.length);
    requireCondition(!files.has(relative), 'Candidate ZIP contains duplicate entries');
    requireCondition(!(flags & 1) && [0, 8].includes(method) && size <= 32 * 1024 * 1024
      && (totalBytes += size) <= 128 * 1024 * 1024, 'Candidate ZIP entry is unsupported or too large');
    requireCondition(local + 30 <= offset && archive.readUInt32LE(local) === 0x04034b50, 'Candidate ZIP entry header invalid');
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    requireCondition(start + compressed <= offset, 'Candidate ZIP entry truncated');
    const content = method === 8 ? inflateRawSync(archive.subarray(start, start + compressed), { maxOutputLength: size + 1 })
      : archive.subarray(start, start + compressed);
    requireCondition(content.length === size, 'Candidate ZIP entry size mismatch');
    files.set(relative, content);
  }
  requireCondition(files.has('VERSION.json') && files.has('server.mjs') && files.has('app/index.html'), 'Candidate ZIP build files missing');
  const metadata = JSON.parse(files.get('VERSION.json').toString('utf8'));
  const fileHashes = Object.fromEntries([...files.keys()].filter(file => (file.endsWith('.mjs') && !file.includes('/'))
    || file.startsWith('app/')).sort().map(file => [file, sha256(files.get(file))]));
  return { metadata, fileHashes };
}

function requireBuild(report, build, version, name) {
  requireCondition(report.version === version, `${name} report version mismatch`);
  equal(report.build, build, `${name} report build fingerprint does not match the ZIP`);
}
function latency(summary, name, count, maximum = 60) {
  requireCondition(summary?.count === count && finite(summary.medianMs) && summary.medianMs >= 0
    && finite(summary.p95Ms) && summary.p95Ms >= summary.medianMs && summary.p95Ms <= maximum, `${name} latency gate failed`);
}
function ordinaryLan(report) {
  equal(report.fixture, { actors: 100, tokens: 500, players: 6 }, 'LAN fixture must be GM + 6 Player and 500 Token');
  requireCondition(report.warmup === 30, 'LAN warmup missing');
  for (const measurements of [report.measurement, report.ackMeasurement]) {
    for (const [type, count] of [['move', 100], ['status', 50], ['chat', 50], ['aggregate', 200]]) {
      latency(measurements?.[type], `LAN ${type}`, count);
    }
  }
  requireCondition(finite(report.moveBytes?.requestMax) && report.moveBytes.requestMax > 0 && report.moveBytes.requestMax <= 4096
    && finite(report.moveBytes?.responseMax) && report.moveBytes.responseMax > 0 && report.moveBytes.responseMax <= 4096,
  'LAN move packet gate failed');
}

function largeLan(report) {
  const fixture = report.fixture;
  requireCondition(fixture?.actors === 100 && fixture.tokens === 500 && fixture.players === 6
    && fixture.fogCellSizeMeters === 5 && fixture.pathSampleSpacingMeters === 2.5
    && fixture.occluders === 81 && fixture.nearbyOccluders >= 40, 'Large-range LAN fixture invalid');
  for (const [name, sources] of [['singleSource', 1], ['sixConcurrentSources', 6]]) {
    const scenario = report.scenarios?.[name];
    requireCondition(scenario?.sourceCount === sources && scenario.parties === sources && scenario.lighting === 'dark'
      && scenario.lights === 3 && scenario.rangeMeters === 1000 && scenario.distanceMeters === 425
      && scenario.rounds === 5 && scenario.warmupRounds === 1 && scenario.warmupProcessedSamples === sources * 171
      && scenario.processedSamples === 5 * sources * 171 && scenario.samples?.length === 5, `${name} requires five complete warmed rounds`);
    const requests = [];
    for (const [index, sample] of scenario.samples.entries()) {
      requireCondition(sample.round === index + 1 && sample.warmup === false && sample.durableJobs === sources
        && sample.processedSamples === sources * 171 && sample.jobsRemaining === 0 && sample.contextsRemaining === 0
        && sample.referenceFogMatches === true && digest(sample.fogHash) && sample.requestLatencies?.length === sources
        && sample.durableJobProofs?.length === sources && sample.durableJobProofs.every(job => job.totalSamples === 171
          && job.cursorAtCreation === 0 && job.completedDurably === true), `${name} round ${index + 1} exploration proof invalid`);
      requireCondition(sample.requestLatencies.every(request => finite(request.ackMs) && request.ackMs >= 0
        && finite(request.fanoutMs) && request.fanoutMs >= 0), `${name} raw latencies missing`);
      requests.push(...sample.requestLatencies);
    }
    for (const [key, raw] of [['movementAck', 'ackMs'], ['allClientFanout', 'fanoutMs']]) {
      latency(scenario[key], `${name} ${key}`, 5 * sources);
      const sorted = requests.map(request => request[raw]).sort((a, b) => a - b);
      const p95 = Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3));
      requireCondition(p95 === scenario[key].p95Ms, `${name} ${key} raw samples disagree with summary`);
    }
  }
}

function browser(report) {
  requireCondition(report.browser === 'chrome' && report.headless === true && report.fixture?.sessions === 7
    && report.fixture.actors === 100 && report.fixture.tokens === 500 && report.fixture.viewport === '1920x1080', 'Chrome fixture invalid');
  requireCondition(report.phases?.length === 2, 'Chrome phases missing');
  for (const [index, lighting] of ['normal', 'dark'].entries()) {
    const phase = report.phases[index], expectedName = index === 0 ? 'normal' : 'los-light';
    requireCondition(phase.name === expectedName && phase.seconds === 60 && Number.isSafeInteger(phase.operations)
      && phase.operations > 0 && phase.actualMoves === phase.operations && phase.sessions?.length === 7
      && phase.scene?.lighting === lighting && phase.scene.lineOfSightEnabled === true
      && phase.scene.enabledTokenLights === (index === 0 ? 0 : 3), `${expectedName} real movement/light fixture invalid`);
    let moves = 0;
    for (const [sessionIndex, session] of phase.sessions.entries()) {
      const metrics = session.diagnostics?.metrics;
      const metric = name => metrics?.[name];
      requireCondition(session.name === (sessionIndex === 0 ? 'Browser GM' : `Browser Player ${sessionIndex}`)
        && session.failures?.length === 0 && session.exceptions?.length === 0, `${expectedName} Chrome session errors`);
      requireCondition(finite(session.diagnostics.averageFps) && session.diagnostics.averageFps >= 58
        && finite(metric('frame')?.p95) && metric('frame').p95 >= 0 && metric('frame').p95 <= 20 && metric('frame').count > 0,
      `${expectedName}/${session.name} Chrome frame gate failed`);
      requireCondition(session.inputStimuli === phase.operations && finite(metric('input.frame')?.p95)
        && metric('input.frame').p95 >= 0 && metric('input.frame').p95 <= 16.7
        && metric('input.frame').count >= session.inputStimuli, `${expectedName}/${session.name} Chrome input gate failed`);
      requireCondition(!metric('longtask') || (finite(metric('longtask').max) && metric('longtask').max >= 0 && metric('longtask').max <= 100),
        `${expectedName}/${session.name} Chrome long task gate failed`);
      if (sessionIndex === 0) continue;
      requireCondition(Number.isSafeInteger(session.moves) && session.moves > 0 && session.sourceMismatches === 0,
        `${expectedName}/${session.name} real moving source invalid`);
      moves += session.moves;
      const vision = session.vision, tokenId = `browser-token-${sessionIndex - 1}`;
      const matches = (left, right) => finite(left) && finite(right) && Math.abs(left - right) <= 1e-6;
      requireCondition(vision?.tokenId === tokenId && vision.sourceTokenId === tokenId && vision.source?.tokenId === tokenId
        && vision.source.lineOfSightEnabled === true && vision.source.lighting === lighting && vision.canvasReady === true
        && vision.fogRows > 0 && vision.fogSpans > 0 && vision.feedback?.rendered === true
        && matches(vision.source.x, vision.token?.x) && matches(vision.source.y, vision.token?.y)
        && matches(vision.feedback.source?.x, vision.token?.x) && matches(vision.feedback.source?.y, vision.token?.y)
        && metric('vision.draw')?.count >= Math.ceil(session.moves / 2) && metric('vision.worker')?.count >= 1
        && metric('vision.feedback')?.count >= 1, `${expectedName}/${session.name} moving vision/Fog proof invalid`);
      requireCondition(finite(metric('network.confirm')?.p95) && metric('network.confirm').p95 >= 0 && metric('network.confirm').p95 <= 60
        && metric('network.confirm').count === session.moves, `${expectedName}/${session.name} Chrome confirmation gate failed`);
    }
    requireCondition(moves === phase.actualMoves, `${expectedName} per-player movement counts disagree`);
  }
  requireCondition(finite(report.recovery?.recoveredMs) && report.recovery.recoveredMs <= 13_000
    && report.recovery.outageDelayMs === 3000 && report.recovery.revisionsBefore?.length === 7
    && report.recovery.synchronizationComplete === true && report.recovery.projectionMatches?.length === 7
    && report.recovery.projectionMatches.every(value => value === true), 'Chrome reconnect gate failed');
  equal(report.recovery.revisionsAfter, report.recovery.revisionsBefore, 'Chrome reconnect changed revision');
}

function timing(result, name) {
  requireCondition(result?.samplesMs?.length === 5 && result.samplesMs.every(value => finite(value) && value >= 0)
    && finite(result.medianMs) && result.medianMs > 0 && digest(result.hash), `${name} five-round timing/hash missing`);
  const sorted = [...result.samplesMs].sort((a, b) => a - b);
  requireCondition(result.medianMs === sorted[2] && result.p95Ms === sorted[4], `${name} timing summary invalid`);
}
async function vision(baseline, candidate, validation, sourceRoot) {
  requireCondition(/^[a-f0-9]{40}$/.test(validation.baselineCommit || '') && baseline.sourceCommit === validation.baselineCommit
    && candidate.sourceCommit === validation.commit && candidate.version === validation.version, 'Vision source commit mismatch');
  requireCondition(baseline.occluders === 81 && candidate.occluders === baseline.occluders, 'Vision geometry differs');
  const files = candidate.sourceFileHashes;
  requireCondition(files && Object.keys(files).length > 0 && Object.keys(baseline.sourceFileHashes || {}).length > 0,
    'Vision source fingerprint missing');
  requireCondition(candidate.sourceHashEncoding === 'utf8-lf' && baseline.sourceHashEncoding === 'utf8-lf',
    'Vision source fingerprint encoding missing');
  const tracked = (await execFileAsync('git', ['ls-files', '-z', '--', 'src', 'deployment/local-server',
    'reference/maps/lanzhou/runtime.json'], { cwd: sourceRoot })).stdout.split('\0').filter(file => /\.(js|mjs)$/.test(file)
      || file === 'reference/maps/lanzhou/runtime.json').sort();
  equal(Object.keys(files).sort(), tracked, 'Vision source fingerprint is incomplete');
  for (const [file, hash] of Object.entries(files)) {
    requireCondition(/^(src\/|deployment\/local-server\/|reference\/maps\/lanzhou\/runtime\.json$)/.test(file)
      && !file.split('/').includes('..') && digest(hash), 'Vision source fingerprint entry invalid');
    requireCondition(sha256((await readFile(path.join(sourceRoot, file), 'utf8')).replaceAll('\r\n', '\n')) === hash,
      `Vision source fingerprint mismatch: ${file}`);
  }
  requireCondition(digest(files['reference/maps/lanzhou/runtime.json'])
    && files['reference/maps/lanzhou/runtime.json'] === baseline.sourceFileHashes['reference/maps/lanzhou/runtime.json'], 'Vision map input differs');
  for (const range of [120, 500, 1000, 10000]) {
    timing(baseline.visibility?.[range], `Baseline ${range}`); timing(candidate.visibility?.[range], `Candidate ${range}`);
    requireCondition(baseline.visibility[range].hash === candidate.visibility[range].hash, `${range} visibility output differs`);
    timing(candidate.continuous?.[range], `Continuous ${range}`);
  }
  for (const key of ['multiLight500', 'sweep']) {
    timing(baseline[key], `Baseline ${key}`); timing(candidate[key], `Candidate ${key}`);
    requireCondition(baseline[key].hash === candidate[key].hash, `${key} output differs`);
  }
  timing(candidate.continuous?.multiLight1000, 'Continuous multi-light');
  requireCondition(candidate.sweep.medianMs <= baseline.sweep.medianMs, '425 metre historical exploration regressed');
}

export async function verifyLocalValidation({ directory, version, commit, sourceRoot = projectRoot }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '')) {
    throw new Error('Expected candidate directory, version and full commit');
  }
  const validation = JSON.parse(await readFile(path.join(directory, 'local-validation.json'), 'utf8'));
  if (validation.version !== version || validation.commit !== commit) throw new Error('Local validation source mismatch');
  const [major, minor, patch] = version.split('.').map(Number);
  const needsEvidence = major > 2 || (major === 2 && (minor > 5 || (minor === 5 && patch >= 4)));
  const checks = needsEvidence ? [...requiredChecks, 'visionBenchmark', 'occlusionLanBenchmark', 'browserBenchmark'] : requiredChecks;
  for (const check of checks) {
    if (validation.checks?.[check] !== 'passed') throw new Error(`Local check missing: ${check}`);
  }
  const archive = await readFile(path.join(directory, `RPGmap-v${version}.zip`));
  if (sha256(archive) !== validation.sha256) throw new Error('Validated ZIP checksum mismatch');
  if (!needsEvidence) return;
  const build = archiveBuild(archive, version);
  requireCondition(build.metadata.version === version && build.metadata.releaseTag === `v${version}`
    && build.metadata.commit === commit, 'Candidate ZIP source mismatch');
  const readEvidence = async (file, name) => {
    requireCondition(typeof file === 'string' && file.length > 0 && !path.isAbsolute(file) && !/^[a-z]:/i.test(file)
      && !file.split(/[\\/]/).includes('..'), `${name} evidence file missing or outside candidate`);
    return JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  };
  for (const [name, verify] of [['lanBenchmark', ordinaryLan], ['occlusionLanBenchmark', largeLan], ['browserBenchmark', browser]]) {
    const report = await readEvidence(validation.evidence?.[name], name);
    requireBuild(report, build, version, name); verify(report);
  }
  const evidence = validation.evidence?.visionBenchmark;
  await vision(await readEvidence(evidence?.baseline, 'vision baseline'), await readEvidence(evidence?.candidate, 'vision candidate'),
    validation, sourceRoot);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, commit] = process.argv.slice(2);
  await verifyLocalValidation({ directory, version, commit });
  console.log('Local validation source, checks, raw performance evidence and ZIP fingerprint verified');
}
