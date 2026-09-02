import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatController = readFileSync(new URL('../src/chat/controller.js', import.meta.url), 'utf8');
const multiplayerController = readFileSync(new URL('../src/multiplayer/controller.js', import.meta.url), 'utf8');

test('chat log stays mounted while the composer toggles independently', () => {
  assert.match(chatController, /let composerMode = null/);
  assert.match(chatController, /function renderLog\(\)/);
  assert.match(chatController, /function renderComposer\(\)/);
  assert.match(chatController, /composerMode = composerMode === mode \? null : mode/);
  assert.match(chatController, /composerHost\.replaceChildren\(\)/);
  assert.doesNotMatch(chatController, /function render\(\)/);
});

test('chat composer collapses on Escape and incoming messages only update the unread badge', () => {
  assert.match(chatController, /event\.key !== 'Escape'/);
  assert.match(chatController, /unreadCount \+= detail\.appendedIds\.length/);
  assert.match(chatController, /unreadBadge\.hidden = unreadCount <= 0/);
  assert.match(chatController, /if \(panel\.classList\.contains\('active'\)\) \{[\s\S]*renderLog\(\)/);
});

test('ordinary LAN chat resolves only after its authoritative operation ACK', () => {
  assert.match(multiplayerController, /function appendChat[\s\S]*return performOperations\(/);
  assert.match(chatController, /await Promise\.resolve\(sent\)/);
  assert.match(chatController, /catch \(error\)[\s\S]*消息发送失败/);
});

test('damage and healing composers explain and disable empty selections', () => {
  assert.match(chatController, /请先选择至少一个可控制的 Token/);
  assert.match(chatController, /selectedCount \? '' : 'disabled'/);
  assert.match(chatController, /if \(composerMode === 'damage' \|\| composerMode === 'healing'\) renderComposer\(\)/);
});
