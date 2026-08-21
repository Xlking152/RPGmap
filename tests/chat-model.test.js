import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMessage, createEmptyChatState, normalizeChatState } from '../src/chat/model.js';

test('chat log stores typed game events', () => {
  const state = createEmptyChatState();
  appendMessage(state, { type: 'combat', text: '第 1 轮' });
  appendMessage(state, { type: 'damage', text: '受到 4L', data: { amount: 4 } });
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0].type, 'combat');
  assert.equal(state.messages[1].data.amount, 4);
});

test('chat state normalizes unknown message type to system', () => {
  const state = normalizeChatState({ messages: [{ id: 'x', type: 'unknown', text: 'x', createdAt: new Date().toISOString() }] });
  assert.equal(state.messages[0].type, 'system');
});
