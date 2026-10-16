import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/utils';
import { runInNewContext } from 'node:vm';
import config from '../vite.config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const ast = source => parseSync('application.js', source, { sourceType: 'module' }).program;
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
};

test('production Leaflet adapter covers every application namespace API and preserves required hooks', async () => {
  const adapterFile = path.join(root, 'src/adapters/leaflet-browser-base.js');
  const source = await readFile(adapterFile, 'utf8');
  const adapter = ast(source);
  const exports = adapter.body.find(node => node.type === 'ExportDefaultDeclaration').declaration;
  assert.equal(exports.type, 'ObjectExpression');
  const api = new Set(exports.properties.map(property => property.key.name));
  const references = new Set();
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith('.js') && file !== adapterFile) {
        walk(ast(await readFile(file, 'utf8')), node => {
          if (node.type === 'MemberExpression' && node.object?.type === 'MemberExpression'
            && node.object.object?.name === 'L' && node.object.property?.name === 'CRS') {
            assert.equal(node.computed, false, `Dynamic CRS requires explicit adapter coverage: ${file}`);
            assert.equal(node.property.name, 'Simple', `Missing CRS ${node.property.name}: ${file}`);
          }
          if (node.type !== 'MemberExpression' || !['L', 'leaflet'].includes(node.object?.name)) return;
          assert.equal(node.computed, false, `Dynamic Leaflet API requires explicit coverage: ${file}`);
          references.add(node.property.name);
          assert.ok(api.has(node.property.name), `Missing Leaflet ${node.property.name} used by ${file}`);
        });
      }
    }
  }
  await inspect(path.join(root, 'src'));
  assert.deepEqual([...api].sort(), [...references].sort(), 'adapter must not collect unused namespace APIs');
  const imports = adapter.body.filter(node => node.type === 'ImportDeclaration').map(node => node.source.value);
  for (const required of ['leaflet/src/map/index.js', 'leaflet/src/layer/marker/Marker.js',
    'leaflet/src/layer/Tooltip.js', 'leaflet/src/control/Control.Zoom.js']) {
    assert.ok(imports.includes(required), `Required interaction hook missing: ${required}`);
  }
  const namespace = exports.properties.find(property => property.key.name === 'CRS').value;
  assert.deepEqual(namespace.properties.map(property => property.key.name), ['Simple']);
  const production = config({ command: 'build' }), development = config({ command: 'serve' });
  const exactAlias = production.resolve.alias.find(alias => alias.find instanceof RegExp && alias.find.test('leaflet'));
  const developmentAlias = development.resolve.alias.find(alias => alias.find instanceof RegExp && alias.find.test('leaflet'));
  assert.equal(exactAlias.replacement, path.join(root, 'src/adapters/leaflet-hosted-browser.js').replaceAll('\\', '/'));
  assert.equal(developmentAlias.replacement, path.join(root, 'src/adapters/leaflet-browser.js').replaceAll('\\', '/'));
  assert.equal(exactAlias.find.test('leaflet/dist/leaflet.css'), false, 'CSS import must retain upstream style source');
  const standalone = await readFile(developmentAlias.replacement, 'utf8');
  const hosted = await readFile(exactAlias.replacement, 'utf8');
  assert(standalone.includes('leaflet/src/layer/vector/Renderer.getRenderer.js'), 'standalone retains upstream Canvas/SVG selection');
  assert(hosted.includes('./leaflet-svg-renderer.js'));
  assert(production.build.rollupOptions.treeshake.moduleSideEffects(exactAlias.replacement));
  assert(production.build.rollupOptions.treeshake.moduleSideEffects(path.join(root, 'src/adapters/leaflet-svg-renderer.js')));
});

test('hosted SVG path renderer respects explicit layer/map renderers and caches named pane renderers', async () => {
  let methods;
  const svg = options => ({ kind: 'svg', options });
  const source = (await readFile(path.join(root, 'src/adapters/leaflet-svg-renderer.js'), 'utf8')).replace(/^import[^\r\n]+\r?\n/gm, '');
  runInNewContext(source, { Map: { include(value) { methods = value; } }, svg });
  const owned = new Set();
  const map = { ...methods, options: { preferCanvas: false }, _paneRenderers: {},
    hasLayer: renderer => owned.has(renderer), addLayer: renderer => owned.add(renderer) };
  const explicit = {};
  assert.equal(map.getRenderer({ options: { renderer: explicit, pane: 'custom' } }), explicit);
  assert(owned.has(explicit));
  assert.equal(map._paneRenderers.custom, undefined, 'an explicit layer renderer wins before pane creation');
  const custom = map.getRenderer({ options: { pane: 'custom' } });
  assert.equal(custom.kind, 'svg'); assert.equal(custom.options.pane, 'custom');
  assert.equal(map.getRenderer({ options: { pane: 'custom' } }), custom);
  const mapRenderer = {}; map.options.renderer = mapRenderer;
  assert.equal(map.getRenderer({ options: { pane: 'overlayPane' } }), mapRenderer);
  delete map.options.renderer;
  const fallback = map.getRenderer({ options: {} });
  assert.equal(fallback.kind, 'svg'); assert.equal(map.getRenderer({ options: {} }), fallback);
  map.options.preferCanvas = true;
  assert.throws(() => map._createRenderer(), /require the SVG renderer/);
});
