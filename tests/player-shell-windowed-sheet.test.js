import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appShell = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
const entityIndex = readFileSync(new URL('../src/entities/index.js', import.meta.url), 'utf8');

test('connected Player shell hides GM World controls and exposes one direct owned-Actor entry', () => {
  assert.match(appShell, /capabilities\?\.connected === true && capabilities\.role !== 'gm'/);
  assert.match(appShell, /我的角色卡/);
  assert.match(appShell, /session\?\.defaultActorId/);
  assert.match(appShell, /library\.hidden = player/);
  assert.match(appShell, /exportButton\.hidden = player/);
  assert.match(appShell, /importButton\.hidden = player/);
});

test('Player current card removes technical IDs and mutation buttons for uncontrolled Tokens', () => {
  assert.match(appShell, /const metaRows = player/);
  assert.match(appShell, /棋子 ID/);
  assert.match(appShell, /角色 ID/);
  assert.match(appShell, /const canControl = !player \|\| api\.multiplayer\?\.canControlToken\?\.\(token\.id\) === true/);
  assert.match(appShell, /if \(canControl\) actions\.append\(button\(documentNode, '高度'/);
});

test('plain C opens only the primary selected Token sheet', () => {
  assert.match(entityIndex, /event\.code !== 'KeyC'/);
  assert.match(entityIndex, /event\.shiftKey \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey/);
  assert.match(entityIndex, /api\.selection\?\.getPrimaryTokenId\?\.\(\)/);
  assert.match(entityIndex, /invoke\('openToken', tokenId\)/);
  assert.doesNotMatch(entityIndex, /getSelectedTokenIds\?\.\(\).*forEach/s);
});

test('Actor sheets become map-friendly draggable and resizable desktop windows', () => {
  assert.match(appShell, /\.entity-sheet-backdrop\{[^}]*pointer-events:none/);
  assert.match(appShell, /\.entity-sheet\{[^}]*resize:both;pointer-events:auto/);
  assert.match(entityIndex, /documentNode\.addEventListener\('pointerdown', pointerDown,/);
  assert.match(entityIndex, /drag = \{ sheet, x:/);
});

test('window behavior is installed before the heavy Entity UI is lazily loaded', () => {
  const windowRegister = entityIndex.indexOf("documentNode.addEventListener('pointerdown', pointerDown");
  const lazyImport = entityIndex.indexOf("import('../ui/lazy-runtime-tools.js')");
  assert.ok(windowRegister >= 0);
  assert.ok(lazyImport > windowRegister);
});
