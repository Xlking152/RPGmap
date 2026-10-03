import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(process.argv.find(v => v.startsWith('--repo='))?.slice(7) || '.');
const execFileAsync = promisify(execFile);
const sourceCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
const tracked = (await execFileAsync('git', ['ls-files', '-z', '--', 'src', 'deployment/local-server',
  'reference/maps/lanzhou/runtime.json'], { cwd: root })).stdout.split('\0').filter(file => /\.(js|mjs)$/.test(file)
    || file === 'reference/maps/lanzhou/runtime.json').sort();
const sourceFileHashes = Object.fromEntries(await Promise.all(tracked.map(async file => [file,
  createHash('sha256').update((await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
const load = file => import(pathToFileURL(path.join(root, file)).href);
const { deriveVisionOccluders } = await load('src/spatial/kernel.js');
const { deriveSceneState } = await load('src/engine/state.js');
const { computeVisibilityRows } = await load('src/vision/visibility.js');
const { exploreFogVisibleSweep } = await load('src/vision/fog.js');
const map = JSON.parse(await readFile(path.join(root, 'reference/maps/lanzhou/runtime.json'), 'utf8'));
const scene = { featureStates: {}, sceneEvents: [], tokens: [] };
const derived = deriveSceneState([]);
const occluders = deriveVisionOccluders(map, scene, derived);
function measure(callback) {
  callback();
  const times = []; let result;
  for (let i = 0; i < 5; i++) {
    const start = performance.now(); result = callback(); times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[2], p95Ms: times.at(-1), samplesMs: times, maxMs: times.at(-1),
    hash: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
const report = { root, version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  sourceCommit, sourceHashEncoding: 'utf8-lf', sourceFileHashes, occluders: occluders.length,
  prepare: measure(() => deriveVisionOccluders(map, scene, derived)),
  transferClone: measure(() => structuredClone(occluders)), visibility: {} };
for (const range of [120, 500, 1000, 10000]) {
  report.visibility[range] = measure(() => computeVisibilityRows({ map, occluders, lights: [],
    source: { x: 2940, y: 2500, elevationMeters: 0, preciseRangeMeters: range, vagueRangeMeters: range,
      lineOfSightEnabled: true, lighting: 'normal' } }));
}
if (Object.hasOwn(scene, 'occlusionShapes') || (await import('node:fs')).existsSync(path.join(root, 'src/vision/continuous.js'))) {
  report.continuous = {};
  for (const range of [120, 500, 1000, 10000]) {
    report.continuous[range] = measure(() => computeVisibilityRows({ map, occluders, lights: [], continuous: true,
      source: { tokenId: 'benchmark-source', x: 2940, y: 2500, elevationMeters: 0,
        preciseRangeMeters: range, vagueRangeMeters: range, lineOfSightEnabled: true, lighting: 'normal' } }));
  }
}
const lights = [
  { id: 'lantern-west', x: 2890, y: 2480, elevationMeters: 3, rangeMeters: 150, intensity: 1.4, occlusion: 'scene' },
  { id: 'lantern-east', x: 3000, y: 2510, elevationMeters: 2, rangeMeters: 180, intensity: 1.1, occlusion: 'scene' },
  { id: 'lantern-south', x: 2945, y: 2570, elevationMeters: 4, rangeMeters: 130, intensity: 1.8, occlusion: 'scene' },
];
report.multiLight500 = measure(() => computeVisibilityRows({ map, occluders, lights,
  source: { x: 2940, y: 2500, elevationMeters: 0, preciseRangeMeters: 500, vagueRangeMeters: 500,
    lineOfSightEnabled: true, lighting: 'dark' } }));
if (report.continuous) report.continuous.multiLight1000 = measure(() => computeVisibilityRows({ map, occluders, lights, continuous: true,
  source: { tokenId: 'benchmark-source', x: 2940, y: 2500, elevationMeters: 0,
    preciseRangeMeters: 1000, vagueRangeMeters: 1000, lineOfSightEnabled: true, lighting: 'dark' } }));
report.sweep = measure(() => exploreFogVisibleSweep({}, 'party',
  { x: 2940, y: 2500, elevationMeters: 0 }, { x: 3365, y: 2500, elevationMeters: 0 }, 1000, map, { occluders }));
for (const [file, hash] of Object.entries(sourceFileHashes)) {
  if (createHash('sha256').update((await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n')).digest('hex') !== hash) {
    throw new Error(`Vision benchmark source changed during measurement: ${file}`);
  }
}
if ((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() !== sourceCommit) {
  throw new Error('Vision benchmark source commit changed during measurement');
}
console.log(JSON.stringify(report, null, 2));
