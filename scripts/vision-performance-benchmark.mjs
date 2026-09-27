import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(process.argv.find(v => v.startsWith('--repo='))?.slice(7) || '.');
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
  return { medianMs: times[2], maxMs: times.at(-1),
    hash: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
const report = { root, occluders: occluders.length,
  prepare: measure(() => deriveVisionOccluders(map, scene, derived)),
  transferClone: measure(() => structuredClone(occluders)), visibility: {} };
for (const range of [120, 500, 1000, 10000]) {
  report.visibility[range] = measure(() => computeVisibilityRows({ map, occluders, lights: [],
    source: { x: 2940, y: 2500, elevationMeters: 0, preciseRangeMeters: range, vagueRangeMeters: range,
      lineOfSightEnabled: true, lighting: 'normal' } }));
}
const lights = [
  { id: 'lantern-west', x: 2890, y: 2480, elevationMeters: 3, rangeMeters: 150, intensity: 1.4, occlusion: 'scene' },
  { id: 'lantern-east', x: 3000, y: 2510, elevationMeters: 2, rangeMeters: 180, intensity: 1.1, occlusion: 'scene' },
  { id: 'lantern-south', x: 2945, y: 2570, elevationMeters: 4, rangeMeters: 130, intensity: 1.8, occlusion: 'scene' },
];
report.multiLight500 = measure(() => computeVisibilityRows({ map, occluders, lights,
  source: { x: 2940, y: 2500, elevationMeters: 0, preciseRangeMeters: 500, vagueRangeMeters: 500,
    lineOfSightEnabled: true, lighting: 'dark' } }));
report.sweep = measure(() => exploreFogVisibleSweep({}, 'party',
  { x: 2940, y: 2500, elevationMeters: 0 }, { x: 3365, y: 2500, elevationMeters: 0 }, 1000, map, { occluders }));
console.log(JSON.stringify(report, null, 2));
