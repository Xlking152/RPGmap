import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appShell = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
const entityIndex = readFileSync(new URL('../src/entities/index.js', import.meta.url), 'utf8');
const sheetWindow = readFileSync(new URL('../src/entities/sheet-window-behavior.js', import.meta.url), 'utf8');

test('connected Player shell hides GM World controls and exposes one direct owned-Actor entry', () => {
  assert.match(appShell, /dataset\.sessionShell = player \? 'player' : 'gm'/);
  assert.match(appShell, /data-gm-shell-only/);
  assert.match(appShell, /我的角色卡/);
  assert.match(appShell, /getActorAccessLevel\?\.\(preferred\) === 'owner'/);
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

test('Actor sheets become non-modal draggable and resizable desktop windows', () => {
  assert.match(sheetWindow, /pointer-events:none\s*!important/);
  assert.match(sheetWindow, /pointer-events:auto/);
  assert.match(sheetWindow, /resize:both/);
  assert.match(sheetWindow, /setAttribute\('aria-modal', 'false'\)/);
  assert.match(sheetWindow, /documentNode\.addEventListener\('pointerdown', pointerDown, true\)/);
  assert.match(sheetWindow, /const geometry = new Map\(\)/);
});

test('window behavior registers before the heavy Entity UI is lazily loaded', () => {
  const windowRegister = entityIndex.indexOf('createSheetWindowBehavior().register(api)');
  const lazyImport = entityIndex.indexOf("import('../ui/lazy-runtime-tools.js')");
  assert.ok(windowRegister >= 0);
  assert.ok(lazyImport > windowRegister);
});
