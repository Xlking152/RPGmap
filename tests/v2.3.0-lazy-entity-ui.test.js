import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const entityIndex = readFileSync(new URL('../src/entities/index.js', import.meta.url), 'utf8');
const mapRuntime = readFileSync(new URL('../src/runtime/map-runtime.js', import.meta.url), 'utf8');
const appShell = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
const lazyTools = readFileSync(new URL('../src/ui/lazy-runtime-tools.js', import.meta.url), 'utf8');

test('heavy Entity UI loads only when the Actor library or a sheet is first opened', () => {
  assert.doesNotMatch(entityIndex, /^import .*\.\/ui\.js/m);
  assert.doesNotMatch(entityIndex, /export .*token-controller|export .*xlsx|export .*EntityStore/);
  assert.match(entityIndex, /import\('\.\.\/ui\/lazy-runtime-tools\.js'\)/);
  assert.match(lazyTools, /createEntityUiTool/);
  assert.match(entityIndex, /openActor: \(\.\.\.args\) => invoke\('openActor'/);
  assert.match(entityIndex, /openToken: \(\.\.\.args\) => invoke\('openToken'/);
  assert.match(entityIndex, /data-ui-panel="actors"/);
  assert.match(mapRuntime, /createEntitySystem/);
  assert.match(appShell, /setActivePanel\?\.\('current'\)/);
});

test('lazy Entity listeners are released before or after the full UI loads', () => {
  assert.match(entityIndex, /removeEventListener\('click', handleActorTabClick, true\)/);
  assert.match(entityIndex, /removeEventListener\('dblclick', handleTokenDoubleClick, true\)/);
  assert.match(entityIndex, /api\.on\?\.\('app:destroy'/);
});
