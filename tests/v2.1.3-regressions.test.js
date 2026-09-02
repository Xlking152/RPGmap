import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appShell = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
const chatController = readFileSync(new URL('../src/chat/controller.js', import.meta.url), 'utf8');
const areaSystem = readFileSync(new URL('../src/scene/areas.js', import.meta.url), 'utf8');
const mapInspector = readFileSync(new URL('../src/interaction/map-inspector.js', import.meta.url), 'utf8');

test('Select mode owns direct Feature inspection without a duplicate Inspect toolbar button', () => {
  assert.match(appShell, /button\(documentNode, '选择'/);
  assert.doesNotMatch(appShell, /button\(documentNode, '检查地物'/);
  assert.doesNotMatch(appShell, /inspect\.dataset\.mainTool\s*=\s*'inspect'/);
  assert.match(mapInspector, /\['pan', 'inspect'\]\.includes\(tool\)/);
  assert.match(mapInspector, /api\.selectFeature\(feature\.id, \{ switchTab: true \}\)/);
});

test('chat composer acknowledges successful sends and clears only after the transport accepted them', () => {
  assert.match(chatController, /const result = appendAfterWorld\?\.\(\{ text, event, data \}\)/);
  assert.match(chatController, /if \(sent === false\) return;/);
  assert.match(chatController, /await Promise\.resolve\(sent\)/);
  assert.match(chatController, /input\.value = '';/);
  assert.match(chatController, /input\.focus\(\);/);
  assert.match(chatController, /消息发送失败/);
});

test('Token-bound attack areas keep the live anchor but preview and damage use a resolved free snapshot', () => {
  assert.match(areaSystem, /anchor: \{ type: 'free', markerId: null \}/);
  assert.match(areaSystem, /origin: resolvedOrigin\(area\)/);
  assert.match(areaSystem, /createDamagePreview\(resolved, api\.mapPackage\.features \|\| \[\], categories\)/);
  assert.match(areaSystem, /commitDamageEvent\(api\.getState\(\), resolved, current\)/);
  assert.match(areaSystem, /resolvedOrigin\(\{ \.\.\.area, anchor \}\)/);
  assert.match(areaSystem, /anchor = type === 'token' \? \{ type: 'token', tokenId: value \}/);
});
