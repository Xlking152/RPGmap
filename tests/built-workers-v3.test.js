import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'vite';
import { exportRuntimeState, prepareRuntimeStateValidationInput } from '../src/engine/runtime-state.js';
import { computeFogExplorationAsync } from '../src/vision/fog.js';
import { computeFogExplorationDeltaAsync } from '../src/vision/exploration-delta.js';
import { computeVisibilityRows } from '../src/vision/visibility.js';
import { normalizeVisionOccluder } from '../src/spatial/kernel.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';
import { stripUnusedLeafletRasterCss } from '../vite.config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const bridge = `const {parentPort,workerData}=require('node:worker_threads');
  globalThis.self={postMessage:data=>parentPort.postMessage(data)};
  (async()=>{const context=await import(workerData.recipeSource);
    const recipe=context.currentWorldValidationRecipe();
    await import(workerData.url);
    parentPort.on('message',data=>Promise.resolve(self.onmessage({data})).catch(error=>{throw error}));
    parentPort.postMessage({ready:true,recipe,unchanged:context.currentWorldValidationRecipe()===recipe});})();`;

function receive(worker, message = undefined) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Compiled Worker response timed out')), 10000);
    const onMessage = value => finish(null, value), onError = error => finish(error);
    function finish(error, value) {
      clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError);
      if (error) reject(error); else resolve(value);
    }
    worker.once('message', onMessage); worker.once('error', onError);
    if (message !== undefined) worker.postMessage(message);
  });
}

test('production Workers share pure modules, execute without DOM, and retain export/vision behavior', async t => {
  const output = await mkdtemp(path.join(tmpdir(), 'rpgmap-worker-bundle-'));
  assert.equal(path.dirname(output), path.resolve(tmpdir()));
  assert.ok(path.basename(output).startsWith('rpgmap-worker-bundle-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await build({ root, configFile: path.join(root, 'vite.config.js'), logLevel: 'silent', build: { outDir: output } });
  const manifest = JSON.parse(await readFile(path.join(output, '.vite/manifest.json'), 'utf8'));
  const common = Object.entries(manifest).find(([, entry]) => entry.name === 'worker-runtime-core');
  assert.ok(common, 'both realms must refer to one emitted pure runtime file');
  const staticRecords = key => {
    const records = new Map();
    function visit(next) {
      if (records.has(next)) return;
      const record = manifest[next]; assert.ok(record, `Missing dependency ${next}`);
      records.set(next, record); for (const imported of record.imports || []) visit(imported);
    }
    visit(key); return records;
  };
  for (const key of ['src/app/world-validation-worker.js', 'src/vision/worker.js']) {
    const records = staticRecords(key);
    assert.ok(records.has(common[0]), 'each Worker must use the same pure runtime');
    for (const [dependency, record] of records) {
      assert.notEqual(dependency, 'index.html');
      assert.notEqual(record.name, 'map-runtime-core');
      assert.notEqual(record.name, 'desktop-setup');
      assert.equal((record.css || []).length, 0);
    }
  }
  for (const [, record] of staticRecords('index.html')) {
    assert.notEqual(record.name, 'worker-runtime-core', 'initial page must not load computation');
    assert.notEqual(record.name, 'map-runtime-core', 'initial page must not load game UI');
  }

  const css = (await Promise.all(Object.values(manifest).filter(entry => entry.file.endsWith('.css'))
    .map(entry => readFile(path.join(output, entry.file), 'utf8')))).join('\n');
  for (const selector of ['.leaflet-tooltip', '.leaflet-control-zoom', '.leaflet-marker-icon', '.setup-page']) {
    assert.ok(css.includes(selector), `Active UI style ${selector} was removed`);
  }
  assert.ok(!css.includes('.leaflet-popup-content'), 'unused Leaflet popup CSS must not ship');

  async function start(key) {
    const worker = new Worker(bridge, { eval: true, workerData: { url: pathToFileURL(path.join(output, manifest[key].file)).href,
      recipeSource: new URL('../src/app/world-validation-context.js', import.meta.url).href } });
    t.after(() => worker.terminate());
    const ready = await receive(worker); assert.equal(ready.ready, true);
    assert.equal(ready.unchanged, true, 'compiled modules must not change platform authority tables');
    assert.ok(ready.recipe);
    // Node's test runner installs a different Error.prepareStackTrace table.
    // Use the unmodified realm's source recipe to compare compiled behavior.
    return { worker, recipe: ready.recipe };
  }
  const { worker: validation, recipe } = await start('src/app/world-validation-worker.js');
  const options = { mapPackage: copyMap, ruleset: copyRuleset };
  for (const schemaVersion of [2, 3, 4]) {
    const state = worldCopyInput().state;
    state.preferences.worldV2.schemaVersion = schemaVersion;
    const request = { protocol: 1, kind: 'runtime-world-export', id: schemaVersion, generation: 2,
      prepared: prepareRuntimeStateValidationInput(state, options), mapPackage: copyMap, recipe };
    const response = await receive(validation, request);
    assert.equal(response.infrastructureError, undefined);
    assert.equal(response.error, undefined);
    assert.equal(response.json, JSON.stringify(exportRuntimeState(state, options)));
    assert.equal(response.id, schemaVersion); assert.equal(response.generation, 2);
  }
  const request = { protocol: 1, kind: 'runtime-world-export', id: 10, generation: 3,
    prepared: prepareRuntimeStateValidationInput(worldCopyInput().state, options), mapPackage: copyMap, recipe: 'foreign' };
  assert.ok((await receive(validation, request)).infrastructureError);
  request.recipe = recipe; request.prepared.source.extension.bigint = 1n;
  const invalid = await receive(validation, request);
  assert.equal(invalid.error.name, 'TypeError'); assert.match(invalid.error.message, /BigInt/);
  assert.equal(invalid.infrastructureError, undefined);

  const { worker: vision } = await start('src/vision/worker.js');
  const map = { width: 100, height: 80, metersPerUnit: 1 };
  const occluders = [normalizeVisionOccluder({ id: 'wall', polygon: [[25, 0], [27, 0], [27, 80], [25, 80]], blockingHeightMeters: 4 })];
  const input = { map, occluders, lights: [], partyId: 'party', lineOfSightEnabled: true,
    payload: { x: 10, y: 35, radiusMeters: 35, elevationMeters: 1 } };
  const first = await receive(vision, { id: 1, input });
  assert.equal(first.error, undefined);
  assert.deepEqual(first.result, await computeFogExplorationAsync(input));
  const source = { x: 10, y: 35, elevationMeters: 1, rangeMeters: 35, preciseRangeMeters: 35, vagueRangeMeters: 40 };
  const visible = await receive(vision, { id: 2, input: { kind: 'visibility', source, ignoresOcclusion: false, continuous: true } });
  assert.equal(visible.error, undefined);
  assert.deepEqual(visible.result, computeVisibilityRows({ map, occluders, lights: [], source, ignoresOcclusion: false, continuous: true }));
  const deltaInput = { ...input, explorationDelta: true, exploredRows: first.result.exploredByParty.party.rows,
    payload: { ...input.payload, radiusMeters: 40 } };
  const delta = await receive(vision, { id: 3, input: deltaInput });
  assert.equal(delta.error, undefined);
  assert.deepEqual(delta.result, await computeFogExplorationDeltaAsync(deltaInput));
});

test('optional Leaflet styles are retained automatically when their controls are used', async t => {
  const source = await mkdtemp(path.join(tmpdir(), 'rpgmap-css-guard-'));
  assert.equal(path.dirname(source), path.resolve(tmpdir()));
  assert.ok(path.basename(source).startsWith('rpgmap-css-guard-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const cssPath = path.join(root, 'node_modules/leaflet/dist/leaflet.css');
  const css = await readFile(cssPath, 'utf8');
  const plugin = stripUnusedLeafletRasterCss({ sourceDirectory: source });
  const transformed = () => plugin.transform.handler(css, cssPath).code;
  await writeFile(path.join(source, 'app.js'), 'L.map(element, {attributionControl: false}); L.tooltip();');
  plugin.buildStart();
  const without = transformed();
  for (const selector of ['.leaflet-tooltip', '.leaflet-control-zoom', '.leaflet-marker-icon']) {
    assert.ok(without.includes(selector), `Active selector ${selector} must survive`);
  }
  for (const selector of ['.leaflet-popup-content', '.leaflet-control-layers', '.leaflet-control-scale', '.leaflet-control-attribution', '.leaflet-default-icon-path']) {
    assert.equal(without.includes(selector), false);
  }
  await writeFile(path.join(source, 'app.js'), `L.map(element, {attributionControl: true});
    L.popup().openOn(map); L.control.layers().addTo(map); L.control.scale().addTo(map); L.marker([1,2]).addTo(map);`);
  plugin.buildStart();
  const withControls = transformed();
  for (const selector of ['.leaflet-popup-content', '.leaflet-control-layers', '.leaflet-control-scale', '.leaflet-control-attribution', '.leaflet-default-icon-path']) {
    assert.ok(withControls.includes(selector), `Newly used ${selector} must keep its styles`);
  }
  assert.notEqual(withControls, without, 'control changes must change CSS before content hashing');
  const customPng = 'p{background-image:url(data:image/png;base64,aGVsbG8=)}';
  assert.equal(plugin.generateBundle, undefined, 'application PNG backgrounds must not be deleted after CSS hashing');
  assert.equal(plugin.transform.handler(customPng, path.join(source, 'application.css')), undefined);
});
