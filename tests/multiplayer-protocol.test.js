import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost, multiplayerSocketUrl, normalizeRequestedRole, sanitizeMultiplayerName } from '../src/multiplayer/protocol.js';

test('multiplayer socket URL follows current HTTP/HTTPS host', () => {
  assert.equal(multiplayerSocketUrl({ protocol: 'http:', host: '192.168.1.8:30000' }), 'ws://192.168.1.8:30000/ws');
  assert.equal(multiplayerSocketUrl({ protocol: 'https:', host: 'rpg.example.com' }), 'wss://rpg.example.com/ws');
});

test('local host detection and role normalization', () => {
  assert.equal(isLocalHost({ hostname: '127.0.0.1' }), true);
  assert.equal(isLocalHost({ hostname: '192.168.1.8' }), false);
  assert.equal(normalizeRequestedRole('gm'), 'gm');
  assert.equal(normalizeRequestedRole('admin'), 'player');
});

test('multiplayer name is bounded and sanitized', () => {
  assert.equal(sanitizeMultiplayerName('  Alice\n '), 'Alice');
  assert.equal(sanitizeMultiplayerName(''), 'Player');
  assert.equal(sanitizeMultiplayerName('x'.repeat(100)).length, 40);
});
