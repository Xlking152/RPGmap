import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMessage, createEmptyChatState, normalizeChatState } from '../src/chat/model.js';

test('chat log preserves healing events for recovery history', () => {
  const state = createEmptyChatState();
  appendMessage(state, { type: 'healing', text: '恢复 2L', data: { amount: 2, type: 'L' } });
  assert.equal(state.messages[0].type, 'healing');
  const restored = normalizeChatState(state);
  assert.equal(restored.messages[0].type, 'healing');
  assert.equal(restored.messages[0].data.amount, 2);
});
