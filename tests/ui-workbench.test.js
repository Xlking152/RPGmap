import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { workbenchConnectionLabel, workbenchWorldLabel } from '../src/ui/workbench.js';

test('workbench connection summary reflects identity without claiming an offline session is connected', () => {
  assert.equal(workbenchConnectionLabel(), '本地模式');
  assert.equal(workbenchConnectionLabel({ joining: true }), '正在连接');
  assert.equal(workbenchConnectionLabel({ serverUrl: 'ws://localhost:30000' }), '连接已断开');
  assert.equal(workbenchConnectionLabel({ connected: true, session: { role: 'gm' } }), '主持人 · 已连接');
  assert.equal(workbenchConnectionLabel({ connected: true, session: { role: 'player' } }), '玩家 · 已连接');
});

test('workspace heading uses the campaign name instead of repeating the Scene selector', () => {
  assert.equal(workbenchWorldLabel({ name: 'Campaign' }, { name: 'Map' }), 'Campaign');
  assert.equal(workbenchWorldLabel(null, { name: 'Map' }), 'Map');
  assert.equal(workbenchWorldLabel(null, { title: 'Map title' }), 'Map title');
  assert.equal(workbenchWorldLabel(), 'RPGmap');
});

test('runtime presentation imports the shared design system without altering the hosted adapter', () => {
  const source = readFileSync(new URL('../src/runtime/map-runtime-base.js', import.meta.url), 'utf8');
  for (const file of ['design-tokens.css', 'workbench.css', 'panels.css', 'presentation.css']) assert(source.includes(file));
  const hosted = readFileSync(new URL('../src/runtime/hosted-map-runtime.js', import.meta.url), 'utf8');
  assert(hosted.includes('startMapRuntimeBase'));
  assert(hosted.includes('hostedRuntimeAdapters'));
});

test('low-frequency world commands stay permission guarded inside a dismissible menu', () => {
  const shell = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
  assert(shell.includes("menu.dataset.worldCommands = 'true'"));
  for (const control of ['exportButton', 'importButton', 'resetButton', 'clearButton']) assert(shell.includes(`${control}.hidden = player`));
  assert(shell.includes('restoreCurrentSceneEnvironment'));
  assert(shell.includes('clearCurrentScene'));
  const chrome = readFileSync(new URL('../src/ui/workbench.js', import.meta.url), 'utf8');
  assert(chrome.includes("event.key !== 'Escape'"));
  assert(chrome.includes('observer.disconnect()'));
  assert(chrome.includes("removeEventListener('pointerdown', closeMenus)"));
});

test('responsive workspace has fixed tool dimensions and separates desktop and mobile inspector tracks', () => {
  const css = readFileSync(new URL('../src/ui/workbench.css', import.meta.url), 'utf8');
  assert(css.includes('grid-template-columns: 56px minmax(0, 1fr) 376px'));
  assert(css.includes('grid-template-rows: 54px minmax(100px, 1fr) minmax(0, 36dvh)'));
  assert(css.includes('is-inspector-collapsed'));
  assert(css.includes('white-space: nowrap; text-overflow: ellipsis'));
});

test('routine network feedback keeps revision diagnostics in a tooltip instead of map copy', () => {
  const source = readFileSync(new URL('../src/multiplayer/controller.js', import.meta.url), 'utf8');
  assert(source.includes("function setMapStatus(message, detail = '')"));
  assert(source.includes('node.textContent = message; node.title = detail;'));
  assert(source.includes("setMapStatus('联机已同步', `revision ${revision}"));
  assert(source.includes("setMapStatus('联机同步失败：' + error.message)"));
});
