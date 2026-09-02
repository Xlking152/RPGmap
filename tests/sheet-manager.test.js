import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  actorSheetWindowKey,
  createActorSheetManager,
  tokenSheetWindowKey,
} from '../src/entities/sheet-manager.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('SheetManager gives Actor templates and Scene Token instances independent window identities', () => {
  assert.equal(actorSheetWindowKey('ragna'), 'actor:ragna');
  assert.equal(tokenSheetWindowKey('scene-a', 'ragna-1'), 'scene:scene-a:token:ragna-1');
  const manager = createActorSheetManager();
  manager.open({ actorId: 'ragna' });
  manager.open({ actorId: 'ragna', tokenId: 'ragna-1', sceneId: 'scene-a' });
  manager.open({ actorId: 'ragna', tokenId: 'ragna-2', sceneId: 'scene-a' });
  assert.equal(manager.size(), 3);
  assert.deepEqual(manager.list().map(item => item.key), [
    'actor:ragna',
    'scene:scene-a:token:ragna-1',
    'scene:scene-a:token:ragna-2',
  ]);
});

test('same Token id in different Scenes remains two different windows', () => {
  const manager = createActorSheetManager();
  manager.open({ actorId: 'boss', tokenId: 'boss-1', sceneId: 'scene-a' });
  manager.open({ actorId: 'boss', tokenId: 'boss-1', sceneId: 'scene-b' });
  assert.deepEqual(manager.list().map(item => item.key), [
    'scene:scene-a:token:boss-1',
    'scene:scene-b:token:boss-1',
  ]);
});

test('tabs and geometry stay isolated between simultaneously open live windows', () => {
  const manager = createActorSheetManager();
  const actor = manager.open({ actorId: 'boss', tab: 'overview' }).record;
  const firstToken = manager.open({ actorId: 'boss', tokenId: 'boss-1', sceneId: 'scene-a', tab: 'combat' }).record;
  const secondToken = manager.open({ actorId: 'boss', tokenId: 'boss-2', sceneId: 'scene-a', tab: 'status' }).record;

  manager.update(firstToken.key, { tab: 'token', left: 180, top: 120, width: 640, height: 520 });
  manager.capture(secondToken.key, { left: 420, top: 160, width: 700, height: 580 });

  assert.equal(manager.get(actor.key).tab, 'overview');
  assert.equal(manager.get(firstToken.key).tab, 'token');
  assert.equal(manager.get(firstToken.key).left, 180);
  assert.equal(manager.get(firstToken.key).width, 640);
  assert.equal(manager.get(secondToken.key).tab, 'status');
  assert.equal(manager.get(secondToken.key).left, 420);
  assert.equal(manager.get(secondToken.key).width, 700);
});

test('opening an existing sheet focuses it instead of creating a duplicate', () => {
  const manager = createActorSheetManager();
  const first = manager.open({ actorId: 'boss', tokenId: 'boss-1', sceneId: 'scene-a', tab: 'overview' });
  const previousZ = first.record.zIndex;
  const second = manager.open({ actorId: 'boss', tokenId: 'boss-1', sceneId: 'scene-a' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(manager.size(), 1);
  assert.equal(second.record.key, first.record.key);
  assert.ok(second.record.zIndex > previousZ);
  assert.equal(second.record.tab, 'overview');
});

test('SheetManager persists only local tab and geometry preferences', () => {
  const storage = memoryStorage();
  const first = createActorSheetManager({ storage, storageKey: 'test-sheet-prefs' });
  const opened = first.open({ actorId: 'pc-1', tab: 'status' }).record;
  first.capture(opened.key, { left: 133, top: 87, width: 712, height: 640 });
  first.close(opened.key);

  const second = createActorSheetManager({ storage, storageKey: 'test-sheet-prefs' });
  const restored = second.open({ actorId: 'pc-1' }).record;
  assert.equal(restored.tab, 'status');
  assert.equal(restored.left, 133);
  assert.equal(restored.top, 87);
  assert.equal(restored.width, 712);
  assert.equal(restored.height, 640);
});

test('closing the focused window leaves the highest remaining sheet as fallback', () => {
  const manager = createActorSheetManager();
  const actor = manager.open({ actorId: 'a' }).record;
  const token = manager.open({ actorId: 'b', tokenId: 'b-1', sceneId: 'scene-a' }).record;
  manager.activate(actor.key);
  manager.close(actor.key);
  assert.equal(manager.list().at(-1)?.key, token.key);
});

test('lazy Entity UI uses live per-window contexts without archived DOM promotion', () => {
  const entityIndex = readFileSync(new URL('../src/entities/index.js', import.meta.url), 'utf8');
  const lazyTools = readFileSync(new URL('../src/ui/lazy-runtime-tools.js', import.meta.url), 'utf8');
  const liveUi = readFileSync(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8');

  assert.match(lazyTools, /createEntityUiTool.*ui-live\.js/);
  assert.doesNotMatch(lazyTools, /createActorSheetWindowCoordinator/);
  assert.doesNotMatch(entityIndex, /createActorSheetWindowCoordinator/);
  assert.match(entityIndex, /captureSheetGeometry/);
  assert.match(liveUi, /createActorSheetManager/);
  assert.match(liveUi, /data-sheet-window-key/);
  assert.match(liveUi, /function resolveSheetRecord\(record\)/);
  assert.match(liveUi, /function renderSheetRecord\(record\)/);
  assert.match(liveUi, /function renderAllSheets\(\)/);
  assert.match(liveUi, /performCanonicalRuntimeOperation\(operation, \{[\s\S]*record = null/);
  assert.doesNotMatch(liveUi, /let openActorId|let openTokenId|let openTab/);
  assert.doesNotMatch(liveUi, /cloneNode\(|data-sheet-manager-static|archiveLive|promote\(/);
});
