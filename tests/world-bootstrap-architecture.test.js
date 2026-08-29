import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => readFileSync(path.join(ROOT, file), 'utf8');

test('application startup selects World before loading its MapPackage Runtime', () => {
  const main = source('src/main.js');
  const mapRuntime = source('src/runtime/map-runtime.js');
  assert.match(main, /chooseWorldBeforeMap/);
  assert.match(main, /readWorldBootstrap/);
  assert.match(main, /worldBootstrap\.mapPackage/);
  assert.match(main, /await import\('\.\/runtime\/map-runtime\.js'\)/);
  assert.match(mapRuntime, /mapPackageRegistry\.load/);
  assert.ok(main.indexOf('chooseWorldBeforeMap') < main.indexOf("import('./runtime/map-runtime.js')"));
  assert.doesNotMatch(main, /createDefaultMapPackage\s*\(/);
  assert.doesNotMatch(main, /rulesetRegistry\.require\(['"]infinite-horror['"]\)/);
});

test('cross-Map multiplayer synchronization reloads instead of importing into the wrong Runtime', () => {
  const multiplayer = source('src/multiplayer/controller.js');
  assert.match(multiplayer, /requestedScene\?\.mapPackage\?\.id/);
  assert.match(multiplayer, /requestedMapId !== loadedMapId/);
  assert.match(multiplayer, /location\?\.reload/);
});

test('LAN bootstrap publishes Active Scene MapPackage metadata', () => {
  const server = source('deployment/local-server/server.mjs');
  assert.match(server, /function worldBootstrapInfo/);
  assert.match(server, /activeSceneId:/);
  assert.match(server, /mapPackage:/);
});
