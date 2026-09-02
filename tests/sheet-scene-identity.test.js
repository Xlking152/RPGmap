import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createActorSheetManager, tokenSheetWindowKey } from '../src/entities/sheet-manager.js';

test('Token sheet keys include Scene identity when a Scene is known', () => {
  assert.equal(tokenSheetWindowKey('scene-a', 'token-1'), 'scene:scene-a:token:token-1');
  assert.equal(tokenSheetWindowKey('scene-b', 'token-1'), 'scene:scene-b:token:token-1');
  assert.notEqual(tokenSheetWindowKey('scene-a', 'token-1'), tokenSheetWindowKey('scene-b', 'token-1'));
});

test('the same Token id from two Scenes can own two independent sheet records', () => {
  const manager = createActorSheetManager();
  const first = manager.open({ actorId: 'monster-a', tokenId: 'shared-token', sceneId: 'scene-a', tab: 'combat' });
  const second = manager.open({ actorId: 'monster-b', tokenId: 'shared-token', sceneId: 'scene-b', tab: 'combat' });

  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(manager.size(), 2);
  assert.equal(first.record.sceneId, 'scene-a');
  assert.equal(second.record.sceneId, 'scene-b');
  assert.notEqual(first.record.key, second.record.key);
});

test('Token sheet coordinator carries the active Scene into managed Token records', () => {
  const source = readFileSync(new URL('../src/entities/sheet-window-coordinator.js', import.meta.url), 'utf8');
  assert.match(source, /currentSceneId/);
  assert.match(source, /sceneId:\s*normalizedSceneId/);
  assert.match(source, /sheet\.dataset\.sheetSceneId/);
  assert.match(source, /tokenSheetWindowKey\(sceneId, tokenId\)/);
});
