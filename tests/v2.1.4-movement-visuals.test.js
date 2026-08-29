import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const movementIndex = await readFile(new URL('../src/movement/index.js', import.meta.url), 'utf8');
const ghostRenderer = await readFile(new URL('../src/movement/ghost-renderer-v2.js', import.meta.url), 'utf8');
const tokenRenderer = await readFile(new URL('../src/render/token-layer.js', import.meta.url), 'utf8');

test('V2 movement system restores endpoint Token ghost without legacy Character runtime', () => {
  assert.match(movementIndex, /createMovementGhostRendererV2\(\)\.register\(api\)/);
  assert.match(ghostRenderer, /createTokenGhostDescriptor/);
  assert.match(ghostRenderer, /isMovementEndpointLayer/);
  assert.match(ghostRenderer, /api\.tokens\.resolveActor/);
  assert.match(ghostRenderer, /api\.selection/);
  assert.doesNotMatch(ghostRenderer, /state\.characters|characterId|character:select|selectCharacter/);
});

test('committed Token movement is a queued render animation, not intermediate World mutation', () => {
  assert.match(tokenRenderer, /const animations = new Map\(\)/);
  assert.match(tokenRenderer, /active\.queue\.push\(target\)/);
  assert.match(tokenRenderer, /beginSegment\(motion, next\)/);
  assert.match(tokenRenderer, /view\.setLatLng\(worldToLatLng\(point/);
  assert.match(tokenRenderer, /tokenMoveDuration/);
  assert.doesNotMatch(tokenRenderer, /moveSceneToken|api\.world\.commit|api\.commitState/);
});
