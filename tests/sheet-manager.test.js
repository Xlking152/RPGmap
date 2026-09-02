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

test('lazy Entity UI installs the multi-window coordinator after the canonical UI owns open APIs', () => {
  const entityIndex = readFileSync(new URL('../src/entities/index.js', import.meta.url), 'utf8');
  const lazyTools = readFileSync(new URL('../src/ui/lazy-runtime-tools.js', import.meta.url), 'utf8');
  const coordinator = readFileSync(new URL('../src/entities/sheet-window-coordinator.js', import.meta.url), 'utf8');
  const uiRegister = entityIndex.indexOf('createEntityUiTool(options).register(api)');
  const managerRegister = entityIndex.indexOf('createActorSheetWindowCoordinator({ api, documentNode, windowNode })');
  assert.ok(uiRegister >= 0 && managerRegister > uiRegister);
  assert.match(lazyTools, /createActorSheetWindowCoordinator/);
  assert.match(coordinator, /api\.entities = Object\.freeze\(\{[\s\S]*openActor,[\s\S]*openToken\s*\}\);/);
  assert.match(coordinator, /data-sheet-manager-static/);
  assert.match(coordinator, /sheetSceneId/);
  assert.match(coordinator, /storageKey: `rpgmap\.ui\.actor-sheets\.v1\.\$\{worldId\}`/);
});