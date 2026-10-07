import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { worldWalChecksum } from '../deployment/local-server/world-wal.mjs';
import { withinMillisecondsBudget } from './performance-budget.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const requiredChecks = ['tests', 'build', 'bundle', 'package', 'benchmark', 'lanBenchmark', 'chrome'];
const v254Commit = 'ed7e13baab0f116222333c20431e19ab63b60e37';
const committedVisionSources = new Map();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireCondition(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  try { assert.deepEqual(actual, expected); } catch { throw new Error(message); }
}

// Git objects are immutable, so one batch can bind every measured baseline
// source to its claimed commit without depending on a local baseline checkout.
export async function visionSourceAtCommit(sourceRoot, commit) {
  requireCondition(/^[a-f0-9]{40}$/.test(commit || ''), 'Vision baseline commit invalid');
  const key = `${path.resolve(sourceRoot)}:${commit}`;
  if (!committedVisionSources.has(key)) committedVisionSources.set(key, (async () => {
    const tree = (await execFileAsync('git', ['ls-tree', '-r', '-z', commit, '--', 'src', 'deployment/local-server',
      'reference/maps/lanzhou/runtime.json', 'package.json'], { cwd: sourceRoot, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const entries = tree.split('\0').filter(Boolean).map(record => {
      const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(record);
      requireCondition(match, 'Vision baseline source tree invalid');
      return { object: match[1], file: match[2] };
    }).filter(({ file }) => /\.(js|mjs)$/.test(file) || file === 'reference/maps/lanzhou/runtime.json' || file === 'package.json');
    requireCondition(entries.some(entry => entry.file === 'package.json')
      && entries.some(entry => entry.file === 'src/spatial/kernel.js'), 'Vision baseline source tree missing');
    const contents = await new Promise((resolve, reject) => {
      const child = spawn('git', ['cat-file', '--batch'], { cwd: sourceRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const chunks = [], errors = []; let bytes = 0;
      child.stdout.on('data', chunk => {
        if ((bytes += chunk.length) > 64 * 1024 * 1024) {
          child.kill(); reject(new Error('Vision baseline source objects too large'));
        } else chunks.push(chunk);
      });
      child.stderr.on('data', chunk => errors.push(chunk));
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks))
        : reject(new Error(`Vision baseline source objects unavailable: ${Buffer.concat(errors).toString('utf8')}`)));
      child.stdin.end(entries.map(entry => entry.object).join('\n') + '\n');
    });
    const sourceFileHashes = {}; let cursor = 0, version;
    for (const entry of entries) {
      const end = contents.indexOf(10, cursor);
      requireCondition(end >= cursor, 'Vision baseline source object truncated');
      const header = /^([a-f0-9]{40}) blob (\d+)$/.exec(contents.subarray(cursor, end).toString('ascii'));
      requireCondition(header && header[1] === entry.object, 'Vision baseline source object invalid');
      const size = Number(header[2]), start = end + 1;
      requireCondition(Number.isSafeInteger(size) && size >= 0 && start + size < contents.length
        && contents[start + size] === 10, 'Vision baseline source object truncated');
      const text = contents.subarray(start, start + size).toString('utf8').replaceAll('\r\n', '\n');
      if (entry.file === 'package.json') version = JSON.parse(text).version;
      else sourceFileHashes[entry.file] = sha256(text);
      cursor = start + size + 1;
    }
    requireCondition(cursor === contents.length && typeof version === 'string', 'Vision baseline source objects invalid');
    return { version, sourceFileHashes };
  })());
  return structuredClone(await committedVisionSources.get(key));
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
    requireCondition(!relative.startsWith('素材库/'), 'Release must not contain the complete ruins authoring library');
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
function requireRasterSource(report, candidate, validation, name) {
  requireCondition(report?.version === validation.version && report.sourceCommit === validation.commit
    && /^[a-f0-9]{40}$/.test(report.sourceCommit || ''), `${name} source identity mismatch`);
  requireCondition(report.sourceHashEncoding === 'utf8-lf', `${name} source fingerprint encoding missing`);
  requireCondition(report.sourceFileHashes && typeof report.sourceFileHashes === 'object'
    && !Array.isArray(report.sourceFileHashes) && Object.keys(report.sourceFileHashes).length > 0
    && Object.values(report.sourceFileHashes).every(digest), `${name} complete source fingerprint missing`);
  equal({ version: report.version, sourceCommit: report.sourceCommit, sourceHashEncoding: report.sourceHashEncoding,
    sourceFileHashes: report.sourceFileHashes },
  { version: candidate.version, sourceCommit: candidate.sourceCommit, sourceHashEncoding: candidate.sourceHashEncoding,
    sourceFileHashes: candidate.sourceFileHashes }, `${name} source proof differs from the vision candidate`);
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
    const requests = [], otherPlayerRequests = [];
    for (const [index, sample] of scenario.samples.entries()) {
      requireCondition(sample.round === index + 1 && sample.warmup === false && sample.durableJobs === sources
        && sample.processedSamples === sources * 171 && sample.jobsRemaining === 0 && sample.contextsRemaining === 0
        && sample.referenceFogMatches === true && digest(sample.fogHash) && sample.requestLatencies?.length === sources
        && sample.durableJobProofs?.length === sources && sample.durableJobProofs.every(job => job.totalSamples === 171
          && job.cursorAtCreation === 0 && job.completedDurably === true), `${name} round ${index + 1} exploration proof invalid`);
      requireCondition(sample.requestLatencies.every(request => finite(request.ackMs) && request.ackMs >= 0
        && finite(request.fanoutMs) && request.fanoutMs >= 0), `${name} raw latencies missing`);
      requests.push(...sample.requestLatencies);
      requireCondition(sample.otherPlayerSamples?.length === 8, `${name} ordinary operations during exploration missing`);
      for (const [probeIndex, probe] of sample.otherPlayerSamples.entries()) {
        const type = probeIndex % 2 === 0 ? 'status' : 'chat';
        const expectedJobIds = new Set(sample.durableJobProofs.map(job => job.id));
        requireCondition(probe.type === type && typeof probe.operationId === 'string'
          && probe.operationId.startsWith('occlusion-lan-probe-') && Number.isSafeInteger(probe.senderPlayer)
          && probe.senderPlayer >= 2 && probe.senderPlayer <= 6
          && probe.targetActorId === (type === 'status' ? `actor-${probe.senderPlayer - 1}` : null)
          && Number.isSafeInteger(probe.revision) && probe.revision > 0
          && Number.isSafeInteger(probe.initialBaseRevision) && probe.initialBaseRevision >= 0
          && probe.revision > probe.initialBaseRevision && Number.isSafeInteger(probe.retryCount)
          && probe.retryCount >= 0 && probe.retryCount <= 3
          && probe.revisionConflicts?.length === probe.retryCount
          && finite(probe.ackMs) && probe.ackMs >= 0 && finite(probe.fanoutMs) && probe.fanoutMs >= 0
          && probe.jobProgressAtCommit?.length > 0 && probe.jobProgressAtCommit.length <= sources
          && probe.jobProgressAtCommit.every(job => expectedJobIds.has(job.id) && job.totalSamples === 171
            && Number.isSafeInteger(job.cursor) && job.cursor >= 0 && job.cursor < job.totalSamples),
        `${name} ordinary ${type} did not prove unfinished path samples at its WAL commit`);
        let previousConflictRevision = probe.initialBaseRevision, previousConflictOffset = 0;
        for (const conflict of probe.revisionConflicts) {
          requireCondition(Number.isSafeInteger(conflict.revision) && conflict.revision > previousConflictRevision
            && conflict.revision < probe.revision && finite(conflict.elapsedMs)
            && conflict.elapsedMs >= previousConflictOffset && conflict.elapsedMs <= probe.ackMs,
          `${name} ordinary ${type} conflict retry timing/revision invalid`);
          previousConflictRevision = conflict.revision; previousConflictOffset = conflict.elapsedMs;
        }
        equal(probe.activeJobIdsAtCommit, probe.jobProgressAtCommit.map(job => job.id), `${name} active path IDs disagree`);
        requireCondition(new Set(probe.activeJobIdsAtCommit).size === probe.activeJobIdsAtCommit.length
          && probe.remainingSamplesAtCommit === probe.jobProgressAtCommit.reduce((sum, job) => sum + job.totalSamples - job.cursor, 0),
        `${name} unfinished path sample count disagrees`);
      }
      otherPlayerRequests.push(...sample.otherPlayerSamples);
    }
    for (const [key, raw] of [['movementAck', 'ackMs'], ['allClientFanout', 'fanoutMs']]) {
      latency(scenario[key], `${name} ${key}`, 5 * sources);
      const sorted = requests.map(request => request[raw]).sort((a, b) => a - b);
      const p95 = Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3));
      requireCondition(p95 === scenario[key].p95Ms, `${name} ${key} raw samples disagree with summary`);
    }
    const ordinary = scenario.otherPlayerOperations;
    equal(ordinary?.perRound, { status: 4, chat: 4 }, `${name} ordinary operation mix invalid`);
    requireCondition(ordinary?.warmupSamples === 8 && ordinary.samples === 40
      && new Set(otherPlayerRequests.map(request => request.operationId)).size === 40,
    `${name} ordinary operation warmup/count invalid`);
    for (const type of ['status', 'chat', 'aggregate']) {
      const raw = otherPlayerRequests.filter(request => type === 'aggregate' || request.type === type);
      const count = type === 'aggregate' ? 40 : 20;
      requireCondition(raw.length === count, `${name} ordinary ${type} count invalid`);
      for (const [summaryKey, rawKey] of [['ackMeasurement', 'ackMs'], ['measurement', 'fanoutMs']]) {
        const summary = ordinary[summaryKey]?.[type];
        latency(summary, `${name} ordinary ${type} ${summaryKey}`, count);
        const sorted = raw.map(request => request[rawKey]).sort((a, b) => a - b);
        requireCondition(summary.medianMs === Number(sorted[Math.ceil(count * 0.5) - 1].toFixed(3))
          && summary.p95Ms === Number(sorted[Math.ceil(count * 0.95) - 1].toFixed(3)),
        `${name} ordinary ${type} raw samples disagree with summary`);
      }
    }
  }
}

function chromeSmoke(report) {
  requireCondition(report.mapReady === true && report.leaflet === true, 'Chrome smoke map did not load');
  const occlusion = report.occlusion;
  requireCondition(occlusion?.zoom?.length === 4, 'Chrome smoke DPR coverage missing');
  equal(occlusion.zoom.map(item => item.dpr), [1, 1.25, 1.5, 2], 'Chrome smoke DPR coverage differs');
  requireCondition(occlusion.zoom.every(item => item.zoomLevels === 37 && item.maxCenterAlpha === 0
    && Number.isSafeInteger(item.animations) && item.animations > 0
    && finite(item.maxProjectionError) && item.maxProjectionError >= 0 && item.maxProjectionError <= 1
    && finite(item.maxAnimationError) && item.maxAnimationError >= 0 && item.maxAnimationError <= 1),
  'Chrome smoke zoom/animation gate failed');
  requireCondition(['drew', 'undoRedo', 'committed', 'reopened'].every(key => occlusion.editor?.[key] === true),
    'Chrome smoke editor proof missing');
  const feedback = occlusion.feedback;
  requireCondition(feedback?.ranges?.length === 3, 'Chrome smoke range coverage missing');
  equal(feedback.ranges.map(range => range.rangeMeters), [120, 500, 1000], 'Chrome smoke range coverage differs');
  for (const range of feedback.ranges) {
    requireCondition(range.effectiveRangeMeters === range.rangeMeters && range.samplesMs?.length === 20
      && range.samplesMs.every(value => finite(value) && value >= 0) && range.phases?.length === 20,
    `Chrome smoke ${range.rangeMeters} raw feedback samples missing`);
    const raw = [];
    for (const [index, phase] of range.phases.entries()) {
      requireCondition(phase.index === index && finite(phase.totalMs) && phase.totalMs >= 0
        && finite(phase.commitMs) && phase.commitMs >= 0 && finite(phase.maskWaitMs) && phase.maskWaitMs >= 0
        && Math.abs(phase.totalMs - phase.commitMs - phase.maskWaitMs) <= 1e-6
        && Number.isSafeInteger(phase.expectedRevision) && phase.expectedRevision > 0
        && phase.feedbackState?.rendered === true && phase.feedbackState.stateRevision >= phase.expectedRevision
        && finite(phase.feedbackState.x) && finite(phase.feedbackState.y)
        && finite(phase.previousVisual?.x) && finite(phase.previousVisual?.y)
        && finite(phase.target?.x) && finite(phase.target?.y)
        && (phase.target.x !== phase.previousVisual.x || phase.target.y !== phase.previousVisual.y),
      `Chrome smoke ${range.rangeMeters} moving complete-mask proof invalid`);
      raw.push(phase.totalMs);
    }
    const sorted = raw.sort((a, b) => a - b);
    equal(range.samplesMs, sorted, `Chrome smoke ${range.rangeMeters} raw phases disagree with samples`);
    requireCondition(range.p95Ms === sorted[18] && range.p95Ms <= (range.rangeMeters === 1000 ? 100 : 50),
      `Chrome smoke ${range.rangeMeters} p95 gate failed`);
  }
  requireCondition(Number.isSafeInteger(feedback.blackFlash?.inspectedFrames) && feedback.blackFlash.inspectedFrames > 0
    && feedback.blackFlash.maxCenterAlpha === 0 && feedback.queue?.queued === 0 && feedback.queue.running === false,
  'Chrome smoke black-flash/queue gate failed');
}

function maskRaster(report) {
  requireCondition(report.cases === 2304 && report.framesPerCase === 2 && report.differingPixels === 0
    && report.maxChannelError === 0 && report.maxAlphaError === 0 && report.maxPremultipliedError === 0,
  'Continuous mask raster gate failed');
}

function ruinsRendererDiagnostics(value, name) {
  requireCondition(Number.isSafeInteger(value?.renders) && value.renders > 0
    && Number.isSafeInteger(value.maskBuilds) && value.maskBuilds >= 0
    && Number.isSafeInteger(value.reusedObjects) && value.reusedObjects >= 0,
  `${name} renderer observations missing`);
  for (const [key, limitKey, limit] of [['ruinObjects', 'ruinObjectsLimit', 103], ['cachedNodes', 'cachedNodesLimit', 103],
    ['cachedFeatureGeometry', 'featureGeometryLimit', 103], ['craterObjects', 'craterObjectsLimit', 1]]) {
    requireCondition(value[limitKey] === limit && Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= limit,
      `${name} renderer cache limit failed: ${key}`);
  }
  requireCondition(Number.isSafeInteger(value.floodObjects) && value.floodObjects >= 0
    && finite(value.lastRenderMs) && value.lastRenderMs >= 0 && finite(value.maxRenderMs)
    && value.maxRenderMs >= value.lastRenderMs, `${name} renderer timing/count invalid`);
}

function ruinsGeometryCache(value, name) {
  requireCondition(value?.maxEntries === 512 && value.maxVersionsPerFeature === 2
    && Number.isSafeInteger(value.entries) && value.entries >= 0 && value.entries <= 512
    && Number.isSafeInteger(value.features) && value.features >= 0 && value.features <= value.entries
    && Number.isSafeInteger(value.largestFeatureVersions) && value.largestFeatureVersions >= 0 && value.largestFeatureVersions <= 2
    && (value.entries === 0 ? value.features === 0 && value.largestFeatureVersions === 0 : value.features > 0 && value.largestFeatureVersions > 0)
    && ['hits', 'misses', 'evictions', 'failures'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0),
  `${name} geometry cache bounds/observations invalid`);
}

function ruinsFeedback(value, name, point = null) {
  requireCondition(value?.rendered === true && finite(value.elapsedMs) && value.elapsedMs >= 0
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && Number.isSafeInteger(value.stateRevision) && value.stateRevision >= value.revision
    && finite(value.requestedAt) && value.requestedAt >= 0 && finite(value.x) && finite(value.y),
  `${name} completed-mask/revision proof invalid`);
  if (point) requireCondition(Math.abs(value.x - point.x) <= 0.001 && Math.abs(value.y - point.y) <= 0.001,
    `${name} vision source differs from confirmed position`);
}

function ruinsSmoke(value) {
  const eye = { x: 3628.528142813593, y: 1242.984768981114 };
  requireCondition(value?.passed === true && value.cleanup === true && value.reproduction?.rangeMeters === 1000
    && value.reproduction.radiusMeters === 206.80454093031585, 'Ruins SweepEvent reproduction fixture missing');
  equal(value.reproduction.area, { x: 3581.491689174436, y: 1553.9528916589916 }, 'Ruins SweepEvent attack differs');
  equal(value.reproduction.source, eye, 'Ruins SweepEvent source differs');
  for (const name of ['first', 'second', 'severe']) {
    const operation = value.reproduction[name];
    requireCondition(finite(operation?.commitMs) && operation.commitMs >= 0, `Ruins ${name} commit timing missing`);
    ruinsFeedback(operation.feedback, `Ruins ${name}`, eye);
    requireCondition(operation.feedback.elapsedMs >= operation.commitMs, `Ruins ${name} feedback precedes commit`);
  }
  const image = (record, name) => {
    requireCondition(typeof record?.featureId === 'string' && record.featureId.length > 0 && record.groups === 1
      && record.normalImages === 1 && [0, 1].includes(record.severeImages) && record.taggedEntity === false
      && typeof record.href === 'string' && record.href.length > 0,
    `Ruins ${name} bound untagged texture proof invalid`);
    requireCondition(['x', 'y', 'width', 'height'].every(key => typeof record.anchor?.[key] === 'string'
      && Number.isFinite(Number(record.anchor[key]))) && Number(record.anchor.width) > 0 && Number(record.anchor.height) > 0
      && (record.anchor.viewBox === null || typeof record.anchor.viewBox === 'string'), `Ruins ${name} world anchor invalid`);
  };
  for (const name of ['partial', 'overlap', 'severe', 'whole']) image(value[name], name);
  for (const name of ['partial', 'overlap', 'severe']) requireCondition(typeof value[name].mask === 'string'
    && value[name].mask.length > 0, `Ruins ${name} actual-cut mask missing`);
  equal(value.overlap.anchor, value.partial.anchor, 'Ruins overlap changed world anchor');
  equal(value.severe.anchor, value.partial.anchor, 'Ruins severe damage changed world anchor');
  requireCondition(value.partial.featureId === value.overlap.featureId && value.partial.featureId === value.severe.featureId
    && value.partial.href === value.overlap.href && value.partial.severeImages === 0 && value.overlap.severeImages === 0
    && value.severe.severeImages === 1 && value.whole.featureId !== value.partial.featureId && value.whole.mask === null
    && value.whole.originalHidden === true && value.whole.destructionConfirmed === true,
  'Ruins partial/overlap/severe/whole behavior proof invalid');
  requireCondition(value.wholeAction?.action === 'damage' && value.wholeAction.featureId === value.whole.featureId
    && finite(value.wholeAction.commitMs) && value.wholeAction.commitMs >= 0, 'Ruins whole-damage action missing');
  ruinsFeedback(value.wholeAction.feedback, 'Ruins whole damage', eye);
  requireCondition(value.wholeAction.feedback.elapsedMs >= value.wholeAction.commitMs, 'Ruins whole feedback precedes commit');
  requireCondition(value.movement?.length === 3, 'Ruins damaged-scene movement samples missing');
  equal(value.movementOrigin, {x:eye.x,y:1345}, 'Ruins damaged-scene movement must start on its dry-ground fixture');
  for (const [index, offset] of [0.25, 2.5, 0].entries()) ruinsFeedback(value.movement[index], `Ruins movement ${index}`,
    { x: value.movementOrigin.x + offset, y: value.movementOrigin.y });
  equal(value.zoom?.map(sample => sample.zoom), [-2, 0.25, 2, 0], 'Ruins damaged-scene zoom coverage differs');
  requireCondition(value.zoom.every(sample => Number.isSafeInteger(sample.centerAlpha)
    && sample.centerAlpha >= 0 && sample.centerAlpha <= 12), 'Ruins damaged-scene zoom became opaque');
  ruinsRendererDiagnostics(value.beforeReload?.diagnostics, 'Ruins before reload');
  requireCondition(value.beforeReload?.queue?.queued === 0 && value.beforeReload.queue.running === false,
    'Ruins before reload exploration did not drain');
  requireCondition(value.storageMode === 'persistent-offline'
    && ['worldIdRetained', 'sceneEventsRetained', 'attackAreasRetained', 'anchorRetained'].every(key => value.reload?.[key] === true)
    && value.restore?.singleObjectOnly === true && value.restore.independentCraterRetained === true
    && value.restore.actions?.length === 2, 'Ruins persistence/single-object restoration proof missing');
  equal(value.restore.actions.map(action => action.featureId), [value.whole.featureId, value.partial.featureId],
    'Ruins restoration targets differ');
  for (const operation of value.restore.actions) requireCondition(finite(operation.commitMs) && operation.commitMs >= 0
    && finite(operation.feedbackMs) && operation.feedbackMs >= operation.commitMs
    && Number.isSafeInteger(operation.stateRevision) && operation.stateRevision > 0, 'Ruins restore timing/revision invalid');
  ruinsRendererDiagnostics(value.afterRestore?.diagnostics, 'Ruins after restore');
  requireCondition(Number.isSafeInteger(value.afterRestore.remainingRuins) && value.afterRestore.remainingRuins >= 0
    && value.afterRestore.remainingRuins <= 103, 'Ruins after restore object count invalid');
  const stress = value.stress;
  requireCondition(stress?.rounds === 12 && stress.samples?.length === 12, 'Ruins stress requires twelve complete rounds');
  const damage = [], restore = [];
  for (const [index, sample] of stress.samples.entries()) {
    requireCondition(sample.round === index && sample.damageOk === true && sample.restoreOk === true
      && finite(sample.damageCommitMs) && sample.damageCommitMs >= 0 && finite(sample.damageFeedbackMs)
      && sample.damageFeedbackMs >= sample.damageCommitMs && finite(sample.restoreCommitMs) && sample.restoreCommitMs >= 0
      && finite(sample.restoreFeedbackMs) && sample.restoreFeedbackMs >= sample.restoreCommitMs,
    `Ruins stress round ${index} actual operation/timing proof invalid`);
    ruinsFeedback(sample.damageFeedback, `Ruins stress damage ${index}`, eye);
    ruinsFeedback(sample.restoreFeedback, `Ruins stress restore ${index}`, eye);
    requireCondition(sample.damageFeedback.elapsedMs === sample.damageFeedbackMs
      && sample.restoreFeedback.elapsedMs === sample.restoreFeedbackMs,
    `Ruins stress round ${index} feedback raw samples disagree`);
    requireCondition(sample.restoreFeedback.revision > sample.damageFeedback.revision
      && (index === 0 || sample.damageFeedback.revision > stress.samples[index - 1].restoreFeedback.revision),
    `Ruins stress round ${index} operation revisions did not advance`);
    ruinsRendererDiagnostics(sample.diagnostics, `Ruins stress round ${index}`);
    ruinsGeometryCache(sample.geometryCache, `Ruins stress round ${index}`);
    damage.push(sample.damageFeedbackMs); restore.push(sample.restoreFeedbackMs);
  }
  for (const [name, samples] of [['damage', damage], ['restore', restore]]) {
    const p95 = [...samples].sort((a, b) => a - b)[11];
    requireCondition(stress[`${name}P95Ms`] === p95 && p95 <= 100, `Ruins stress ${name} feedback p95 gate failed`);
  }
  const frames = stress.frames;
  requireCondition(frames?.samplesMs?.length >= 24 && frames.samplesMs.every(sample => finite(sample) && sample > 0)
    && frames.count === frames.samplesMs.length && finite(frames.averageFPS) && finite(frames.p95Ms),
  'Ruins stress raw frame observations missing');
  const averageFPS = 1000 * frames.samplesMs.length / frames.samplesMs.reduce((sum, sample) => sum + sample, 0);
  const frameP95 = [...frames.samplesMs].sort((a, b) => a - b)[Math.ceil(frames.samplesMs.length * 0.95) - 1];
  requireCondition(Math.abs(averageFPS - frames.averageFPS) <= 1e-6 && Math.abs(frameP95 - frames.p95Ms) <= 1e-6
    && averageFPS >= 58 && frameP95 <= 20, 'Ruins stress frame summary/gate failed');
  requireCondition(stress.observerSupported === true && finite(stress.startedAt) && stress.startedAt >= 0
    && finite(stress.endedAt) && stress.endedAt > stress.startedAt
    && stress.durationMs === stress.endedAt - stress.startedAt && Array.isArray(stress.longTasks)
    && stress.longTasks.every(task => finite(task.startTime) && task.startTime >= 0
      && task.startTime <= stress.endedAt && finite(task.duration) && task.duration >= 0
      && task.startTime + task.duration >= stress.startedAt),
  'Ruins stress raw long-task observations missing');
  const maxLongTask = Math.max(0, ...stress.longTasks.map(task => task.duration));
  requireCondition(stress.maxLongTaskMs === maxLongTask && maxLongTask <= 100, 'Ruins stress long-task gate failed');
  ruinsRendererDiagnostics(stress.finalDiagnostics, 'Ruins final');
  ruinsGeometryCache(stress.finalGeometryCache, 'Ruins final');
  requireCondition(stress.finalQueue?.queued === 0 && stress.finalQueue.running === false, 'Ruins final exploration did not drain');
}

function ruinsLanHistory(events) {
  requireCondition(Array.isArray(events), 'Ruins LAN raw history missing');
  const undone = new Set(events.filter(event => event.type === 'undo').map(event => String(event.targetEventId)));
  const objects = new Set(), clips = new Map(), craters = new Map(), active = [];
  const point = value => ({ x: Number(value.x ?? value[0]), y: Number(value.y ?? value[1]) });
  for (const event of events) {
    requireCondition(event && typeof event.id === 'string' && ['damage', 'restore', 'reset', 'undo'].includes(event.type),
      'Ruins LAN raw history event invalid');
    if (event.type === 'undo' || undone.has(event.id)) continue;
    active.push(event.id);
    if (event.type === 'reset') { objects.clear(); clips.clear(); craters.clear(); continue; }
    if (event.type === 'restore') {
      for (const id of event.featureIds || []) { objects.delete(id); clips.delete(id); }
      continue;
    }
    for (const id of event.objectIds || []) objects.add(id);
    for (const hit of event.clipHits || []) {
      const values = clips.get(hit.featureId) || [];
      values.push({ eventId: event.id, featureId: hit.featureId, polygon: hit.polygon.map(point) });
      clips.set(hit.featureId, values);
    }
    if (event.craterPolygon) craters.set(event.id, { eventId: event.id, polygon: event.craterPolygon.map(point) });
  }
  const destroyedObjectIds = [...objects].sort(), clipHits = [...clips.values()].flat().sort((a, b) =>
    a.featureId.localeCompare(b.featureId) || a.eventId.localeCompare(b.eventId));
  return { destroyedObjectIds, clipHits, damagedFeatureIds: [...new Set([...destroyedObjectIds, ...clips.keys()])].sort(),
    craterRegions: [...craters.values()].sort((a, b) => a.eventId.localeCompare(b.eventId)),
    activeSceneEventIds: active, undoneEventIds: [...undone].sort() };
}

function ruinsLan(report, build, version) {
  requireBuild(report, build, version, 'Ruins LAN');
  requireCondition(report.identity === true && report.audienceProjection === true && report.visionSource === true
    && report.documentMovePath === true && report.durableMovementAndPath === true && report.backgroundFogDrained === true
    && report.restartRecovery === true && report.diagnosticProfiling === false, 'Ruins LAN baseline/profile proof missing');
  const value = report.ruinsLan;
  requireCondition(value?.passed === true && value.fixture?.source === 'actual-package'
    && value.fixture.mapId === 'northern-song-lanzhou-1104' && typeof value.fixture.sceneId === 'string'
    && value.fixture.sceneId.length > 0 && typeof value.featureId === 'string' && value.featureId.length > 0
    && finite(value.partialCoverage) && value.partialCoverage > 0 && value.partialCoverage < 0.95
    && value.fixture.area?.shape === 'circle' && finite(value.fixture.area.radius) && value.fixture.area.radius > 0,
  'Ruins LAN actual packaged partial-range fixture missing');
  requireBuild(value, build, version, 'Ruins LAN destruction');
  const canonicalHash = events => sha256(JSON.stringify((function stable(item) {
    return Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  })(events)));
  let history = value.originalSceneEvents;
  const original = ruinsLanHistory(history);
  requireCondition(!original.damagedFeatureIds.includes(value.featureId) && value.samples?.length === 3,
    'Ruins LAN fixture must begin undamaged and execute three transactions');
  const histories = [], revisions = [];
  for (const [index, kind] of ['partial', 'whole', 'restore'].entries()) {
    const sample = value.samples[index], event = sample?.playerChange?.changed;
    requireCondition(sample?.kind === kind && sample.operationId === `smoke-ruins-${kind}`
      && Number.isSafeInteger(sample.baseRevision) && sample.baseRevision >= 0
      && sample.revision === sample.baseRevision + 1 && (index === 0 || sample.baseRevision >= revisions[index - 1])
      && finite(sample.elapsedMs) && sample.elapsedMs >= 0 && sample.walConfirmed === true && sample.canonicalConfirmed === true,
    `Ruins LAN ${kind} ACK/raw revision proof invalid`);
    requireCondition(event && sample.playerChange.action === 'create'
      && sample.playerChange.document?.type === 'SceneEvent' && sample.playerChange.document.id === event.id
      && sample.playerChange.document.parent?.type === 'Scene'
      && sample.playerChange.document.parent.id === value.fixture.sceneId,
    `Ruins LAN ${kind} actual Player SceneEvent delta missing`);
    if (kind === 'partial') {
      requireCondition(event.type === 'damage' && event.id === value.fixture.partialEventId
        && event.objectIds?.length === 0 && event.clipHits?.length === 1
        && event.clipHits[0].featureId === value.featureId && event.clipHits[0].polygon?.length >= 16
        && event.clipHits[0].polygon.every(point => finite(point.x) && finite(point.y))
        && event.areaSnapshot?.shape === 'circle' && event.areaSnapshot.radius === value.fixture.area.radius,
      'Ruins LAN partial range geometry proof invalid');
      equal(event.areaSnapshot.origin, value.fixture.area.origin, 'Ruins LAN partial attack position differs');
    } else if (kind === 'whole') {
      requireCondition(event.type === 'damage' && event.id === 'lan-ruins-whole-event' && event.clipHits?.length === 0,
        'Ruins LAN whole damage proof invalid');
      equal(event.objectIds, [value.featureId], 'Ruins LAN whole destruction touched another object');
    } else {
      requireCondition(event.type === 'restore', 'Ruins LAN restore event missing');
      equal(event.featureIds, [value.featureId], 'Ruins LAN restore touched another object');
    }
    requireCondition(!history.some(previous => previous.id === event.id), 'Ruins LAN duplicated a destruction event');
    history = [...history, event]; histories.push(history); revisions.push(sample.revision);
    equal(sample.durableSceneEvents, history, `Ruins LAN ${kind} durable history differs`);
    equal(sample.canonicalSceneEvents, history, `Ruins LAN ${kind} canonical history differs`);
    requireCondition(sample.sceneEventsHash === canonicalHash(history)
      && sample.durableSceneEventsHash === canonicalHash(sample.durableSceneEvents), `Ruins LAN ${kind} raw history hash differs`);
    const wal = sample.walRecord;
    requireCondition(wal?.walVersion === 2 && wal.operationId === sample.operationId && wal.revision === sample.revision
      && wal.baseRevision === sample.baseRevision && digest(wal.checksum) && worldWalChecksum(wal) === wal.checksum,
    `Ruins LAN ${kind} actual WAL record/checksum invalid`);
    const content = wal.patch?.world?.scenes?.content;
    requireCondition(content?.length === 1 && content[0].sceneId === value.fixture.sceneId,
      `Ruins LAN ${kind} WAL Scene content missing`);
    equal(content[0].sceneEvents, history, `Ruins LAN ${kind} WAL history differs`);
  }
  requireCondition(value.permissions?.length === 2, 'Ruins LAN Player damage/restore denials missing');
  for (const [index, kind] of ['damage', 'restore'].entries()) {
    const proof = value.permissions[index], denial = proof?.denial;
    requireCondition(proof?.kind === kind && proof.operationId === `smoke-ruins-player-${kind}`
      && proof.code === 'scene_content_replace_gm_only' && Number.isSafeInteger(proof.beforeRevision)
      && proof.beforeRevision >= revisions[1] && proof.beforeRevision < revisions[2] && proof.revision === proof.beforeRevision
      && proof.noRollbackState === true && denial?.type === 'world.operation.denied'
      && denial.operationId === proof.operationId && denial.code === proof.code && !Object.hasOwn(denial, 'state'),
    `Ruins LAN Player ${kind} raw denial/revision proof invalid`);
    equal(proof.sceneEvents, histories[1], `Ruins LAN Player ${kind} changed damage history`);
    requireCondition(proof.sceneEventsHash === canonicalHash(proof.sceneEvents), 'Ruins LAN Player denial history hash differs');
  }
  const reconnect = value.reconnect;
  requireCondition(reconnect?.identityRetained === true && reconnect.identityStatus === 'active'
    && typeof reconnect.userId === 'string' && reconnect.userId.length > 0 && reconnect.userId === reconnect.expectedUserId
    && typeof reconnect.worldId === 'string' && reconnect.worldId.length > 0 && reconnect.worldId === reconnect.expectedWorldId
    && reconnect.sourceTokenId === 'smoke-pc-token' && reconnect.source?.tokenId === reconnect.sourceTokenId
    && reconnect.source.x === 2940 && reconnect.source.y === 2500
    && reconnect.wholeDestructionRetained === true && reconnect.hiddenTokenAbsent === true,
  'Ruins LAN actual Player identity/source reconnect proof invalid');
  equal(reconnect.sceneEvents, histories[1], 'Ruins LAN reconnect lost acknowledged destruction');
  requireCondition(reconnect.sceneEventsHash === canonicalHash(reconnect.sceneEvents), 'Ruins LAN reconnect history hash differs');
  for (const [key, index] of [['restart', 1], ['restoredRestart', 2]]) {
    const restart = value[key], expected = ruinsLanHistory(histories[index]);
    requireCondition(restart?.featureId === value.featureId && Number.isSafeInteger(restart.revision)
      && restart.revision >= revisions[index] && restart.sceneEventsRetained === true
      && restart.privateQueueAbsent === true && restart.queueDrained === true,
    `Ruins LAN ${key} actual package restart proof missing`);
    equal(restart.sceneEvents, histories[index], `Ruins LAN ${key} lost durable history`);
    equal(restart.effectiveDamage, expected, `Ruins LAN ${key} effective destruction differs`);
    requireCondition(restart.sceneEventsHash === canonicalHash(restart.sceneEvents)
      && restart.expectedSceneEventsHash === canonicalHash(histories[index]), `Ruins LAN ${key} raw history hash differs`);
    requireCondition(restart.wholeDestructionRetained === expected.destroyedObjectIds.includes(value.featureId)
      && restart.restorationRetained === !expected.damagedFeatureIds.includes(value.featureId), `Ruins LAN ${key} result differs`);
  }
  equal(ruinsLanHistory(history).destroyedObjectIds, original.destroyedObjectIds, 'Ruins LAN restoration altered another object');
  equal(ruinsLanHistory(history).clipHits, original.clipHits, 'Ruins LAN restoration altered another partial damage');
  equal(ruinsLanHistory(history).craterRegions, original.craterRegions, 'Ruins LAN restoration removed an independent crater');
  requireCondition(value.originalFeatureStates && typeof value.originalFeatureStates === 'object'
    && !Array.isArray(value.originalFeatureStates) && value.restoredFeatureStates && typeof value.restoredFeatureStates === 'object'
    && !Array.isArray(value.restoredFeatureStates), 'Ruins LAN raw Tag/door overrides missing');
  equal(value.restoredFeatureStates, value.originalFeatureStates, 'Ruins LAN restoration changed Tag/door overrides');
  requireCondition(value.restoration?.singleObjectOnly === true && value.restoration.tagsAndDoorStateRetained === true
    && value.restoration.independentCraterRetained === true, 'Ruins LAN restoration scope proof missing');
}

function facadeRaster(report) {
  const axes = { geometryIds: ['rect', 'concave', 'hole', 'fragments'], elevations: [0, 15],
    sizes: [[400, 300], [401, 301]], dprs: [1, 1.25, 1.5, 2], scales: [0.25, 1, 3.5],
    modes: ['all', 'normal', 'dark-and-normal'], centers: [[173.37, 131.21], [-20.13, 80.27]] };
  requireCondition(report?.passed === true && report.cases === 1152 && report.framesPerCase === 2
    && report.rawCases?.length === 1152, 'Facade raster requires 1152 raw cases and two consecutive frames');
  equal(report.axes, axes, 'Facade raster geometry/DPR/elevation/viewport coverage differs');
  requireCondition(report.diagnosticSubset !== true, 'Diagnostic facade raster subsets cannot promote a package');
  equal(report.boundaryOracle, { kind: 'final-visible-vector', circleSegments: 2048,
    edgeToleranceCss: 1, fractionalCopies: 'legacy-chain', partialAlphaEdges: 'reference-compositing-operands' },
  'Facade raster final-visible vector boundary proof missing');
  const expected = new Set();
  for (const geometryId of axes.geometryIds) for (const elevationMeters of axes.elevations) for (const [width, height] of axes.sizes)
    for (const dpr of axes.dprs) for (const scale of axes.scales) for (const mode of axes.modes) for (const center of axes.centers)
      expected.add(JSON.stringify([geometryId, elevationMeters, width, height, dpr, scale, mode, center]));
  let differingPixels = 0, maxChannelError = 0, maxEdgeErrorCss = 0, interiorLeakedPixels = 0, outsideEdgeHaloPixels = 0;
  for (const sample of report.rawCases) {
    const key = JSON.stringify([sample.geometryId, sample.elevationMeters, sample.width, sample.height, sample.dpr,
      sample.scale, sample.mode, sample.center]);
    requireCondition(expected.delete(key) && sample.frames?.length === 2, 'Facade raster case missing, duplicated or outside coverage');
    for (const [index, frame] of sample.frames.entries()) {
      requireCondition(frame.frame === index && Number.isSafeInteger(frame.differingPixels) && frame.differingPixels >= 0
        && frame.differingPixels <= Math.ceil(sample.width * sample.dpr) * Math.ceil(sample.height * sample.dpr)
        && finite(frame.maxChannelError) && frame.maxChannelError >= 0 && frame.maxChannelError <= 255
        && (frame.differingPixels === 0 ? frame.maxChannelError === 0 : frame.maxChannelError > 0)
        && finite(frame.maxEdgeErrorCss) && frame.maxEdgeErrorCss >= 0 && frame.maxEdgeErrorCss <= 1
        && frame.interiorLeakedPixels === 0 && frame.outsideEdgeHaloPixels === 0,
      'Facade raster frame edge/interior visibility gate failed');
      differingPixels += frame.differingPixels; maxChannelError = Math.max(maxChannelError, frame.maxChannelError);
      maxEdgeErrorCss = Math.max(maxEdgeErrorCss, frame.maxEdgeErrorCss);
      interiorLeakedPixels += frame.interiorLeakedPixels; outsideEdgeHaloPixels += frame.outsideEdgeHaloPixels;
    }
  }
  requireCondition(expected.size === 0, 'Facade raster case coverage incomplete');
  equal({ differingPixels: report.differingPixels, maxChannelError: report.maxChannelError, maxEdgeErrorCss: report.maxEdgeErrorCss,
    interiorLeakedPixels: report.interiorLeakedPixels, outsideEdgeHaloPixels: report.outsideEdgeHaloPixels },
  { differingPixels, maxChannelError, maxEdgeErrorCss, interiorLeakedPixels, outsideEdgeHaloPixels },
  'Facade raster raw pixels disagree with summary');
  const regression = report.regression;
  requireCondition(regression?.sweepReproduced === true && regression.records?.length === 4,
    'Facade raster original SweepEvent regression missing');
  equal(regression.records.map(record => record.dpr), axes.dprs, 'Facade raster SweepEvent DPR coverage differs');
  for (const record of regression.records) {
    requireCondition(record.completed === true && record.frames?.length === 2, 'Facade raster SweepEvent frames incomplete');
    for (const [index, frame] of record.frames.entries()) {
      requireCondition(frame.frame === index && Number.isSafeInteger(frame.checkedInteriorPixels)
        && Number.isSafeInteger(frame.visibleInteriorPixels) && frame.visibleInteriorPixels > 1000
        && Number.isSafeInteger(frame.hiddenInteriorPixels) && frame.hiddenInteriorPixels > 1000
        && frame.checkedInteriorPixels === frame.visibleInteriorPixels + frame.hiddenInteriorPixels
        && frame.interiorLeakedPixels === 0 && frame.missingVisibleInteriorPixels === 0,
      'Facade raster SweepEvent actual visible/hidden interior proof invalid');
    }
  }
}

function dependencyAudit(report, name) {
  requireCondition(report.metadata?.vulnerabilities?.total === 0, `${name} dependency audit gate failed`);
}

function browser(report, { requireFrameMean = false } = {}) {
  requireCondition(report.diagnosticProfileSession == null, 'Diagnostic browser profiles are not acceptance evidence');
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
      if (requireFrameMean) requireCondition(finite(metric('frame').mean) && metric('frame').mean > 0
        && Math.abs(session.diagnostics.averageFps - 1000 / metric('frame').mean) <= 1e-6,
      `${expectedName}/${session.name} Chrome FPS differs from the observed frame mean`);
      requireCondition(session.inputStimuli === phase.operations && finite(metric('input.frame')?.p95)
        && withinMillisecondsBudget(metric('input.frame').p95, 16.7)
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
async function vision(baseline, candidate, validation, sourceRoot, needsRuinsEvidence) {
  requireCondition(/^[a-f0-9]{40}$/.test(validation.baselineCommit || '') && baseline.sourceCommit === validation.baselineCommit
    && candidate.sourceCommit === validation.commit && candidate.version === validation.version, 'Vision source commit mismatch');
  requireCondition(baseline.occluders === 81 && candidate.occluders === baseline.occluders, 'Vision geometry differs');
  const files = candidate.sourceFileHashes;
  requireCondition(files && Object.keys(files).length > 0 && Object.keys(baseline.sourceFileHashes || {}).length > 0,
    'Vision source fingerprint missing');
  requireCondition(candidate.sourceHashEncoding === 'utf8-lf' && baseline.sourceHashEncoding === 'utf8-lf',
    'Vision source fingerprint encoding missing');
  if (needsRuinsEvidence) requireCondition(validation.baselineCommit === v254Commit && baseline.version === '2.5.4',
    'Vision ruins baseline must be the released v2.5.4 commit');
  const committedBaseline = await visionSourceAtCommit(sourceRoot, validation.baselineCommit);
  requireCondition(baseline.version === committedBaseline.version, 'Vision baseline version mismatch');
  equal(Object.keys(baseline.sourceFileHashes).sort(), Object.keys(committedBaseline.sourceFileHashes).sort(),
    'Vision baseline source fingerprint is incomplete');
  equal(baseline.sourceFileHashes, committedBaseline.sourceFileHashes, 'Vision baseline source fingerprint mismatch');
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
  const needsRuinsEvidence = major > 2 || (major === 2 && (minor > 5 || (minor === 5 && patch >= 5)));
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
    requireBuild(report, build, version, name); verify(report, { requireFrameMean: needsRuinsEvidence });
  }
  const smoke = await readEvidence(validation.evidence?.chromeSmoke, 'Chrome smoke');
  // Older v2.5.4 release evidence predates this package binding. New ruins
  // releases must prove that their complete feature smoke used this exact ZIP.
  if (needsRuinsEvidence || smoke.build || smoke.version) requireBuild(smoke, build, version, 'Chrome smoke');
  chromeSmoke(smoke);
  const evidence = validation.evidence?.visionBenchmark;
  const candidateVision = needsRuinsEvidence ? await readEvidence(evidence?.candidate, 'vision candidate') : null;
  if (needsRuinsEvidence) {
    requireCondition(smoke.diagnosticProfiling === false, 'Chrome diagnostic profiling cannot be formal performance evidence');
    ruinsSmoke(smoke.ruins);
    const facade = await readEvidence(validation.evidence?.facadeRaster, 'facade raster');
    requireRasterSource(facade, candidateVision, validation, 'Facade raster');
    facadeRaster(facade);
    ruinsLan(await readEvidence(validation.evidence?.ruinsLan, 'Ruins LAN'), build, version);
  }
  const raster = await readEvidence(validation.evidence?.maskRaster, 'mask raster');
  if (needsRuinsEvidence) requireRasterSource(raster, candidateVision, validation, 'Mask raster');
  maskRaster(raster);
  const auditEvidence = validation.evidence?.dependencyAudit;
  dependencyAudit(await readEvidence(auditEvidence?.all, 'all dependency audit'), 'All');
  dependencyAudit(await readEvidence(auditEvidence?.production, 'production dependency audit'), 'Production');
  await vision(await readEvidence(evidence?.baseline, 'vision baseline'), candidateVision || await readEvidence(evidence?.candidate, 'vision candidate'),
    validation, sourceRoot, needsRuinsEvidence);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, commit] = process.argv.slice(2);
  await verifyLocalValidation({ directory, version, commit });
  console.log('Local validation source, checks, raw performance evidence and ZIP fingerprint verified');
}
