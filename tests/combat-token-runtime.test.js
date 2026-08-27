import test from 'node:test';
import assert from 'node:assert/strict';
import { combatantView } from '../src/combat/tracker.js';

test('combatant view uses Token Runtime / Synthetic Actor data', () => {
  const combatant = { id: 'c-1', tokenId: 'npc-1', actorId: 'actor-template' };
  const appState = {
    characters: [{ id: 'npc-1', name: '旧投影名称', avatarDataUrl: 'legacy.png' }],
  };
  const view = combatantView(combatant, appState, tokenId => ({
    token: { id: tokenId, actorId: 'actor-template', actorLink: false },
    actor: { id: 'actor-template', name: '士兵 A' },
    synthetic: true,
    name: '士兵 A',
    avatar: 'synthetic.png',
  }));
  assert.equal(view.name, '士兵 A');
  assert.equal(view.avatar, 'synthetic.png');
  assert.equal(view.synthetic, true);
  assert.equal(view.token.id, 'npc-1');
});

test('combatant view never falls back to Character documents', () => {
  const combatant = { id: 'c-1', tokenId: 'legacy-token', actorId: null };
  const appState = {
    characters: [{ id: 'legacy-token', name: '旧角色', avatarDataUrl: 'legacy.png' }],
  };
  const view = combatantView(combatant, appState);
  assert.equal(view.name, 'Token legacy-token');
  assert.equal(view.avatar, null);
  assert.equal(view.synthetic, false);
  assert.equal(view.token, null);
});
