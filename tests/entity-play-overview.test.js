import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEntityPlayOverview, decodeEntityData } from '../src/entities/sheet-renderer.js';
import { applySheetHealthAction, renderActorHealthPanel } from '../src/health/sheet-extension.js';
import { createActorSheetManager } from '../src/entities/sheet-manager.js';

test('play overview shows supplied resources and statuses without inventing action pools or rolls', () => {
  const input = {
    sections: [{ id: 'resources', type: 'resources', items: [{ id: 'will', label: '意志', current: 8, max: 10,
      currentOperation: { type: 'set-resource', id: 'will' }, decrementOperation: { type: 'step-resource', id: 'will', amount: -1 } }] }],
    statuses: [{ id: 'effect-a', label: '流血', enabled: true, duration: { remaining: 2, unit: 'turns' } }, { id: 'effect-b', label: '隐身', enabled: false }],
    checks: [{ type: 'table', title: '技能鉴定', rows: [['感知', '观察', 6, '4 + 2']] }],
  };
  const before = structuredClone(input);
  const html = renderEntityPlayOverview(input);
  assert.match(html, /8 <small>\/ 10/);
  assert.match(html, /width:80%/);
  assert.match(html, /流血/);
  assert.match(html, /剩余 2 回合/);
  assert.doesNotMatch(html, /隐身|行动|data-roll|最大值/);
  assert.match(html, /data-sheet-overview-target="checks"/);
  assert.doesNotMatch(html, /data-sheet-tab=/);
  const operations = [...html.matchAll(/data-actor-operation="([^"]+)"/g)].map(match => decodeEntityData(match[1]));
  assert.deepEqual(operations, [input.sections[0].items[0].decrementOperation, input.sections[0].items[0].currentOperation]);
  assert.deepEqual(input, before);
});

test('minimal ruleset overview keeps its own text visible and escapes display data', () => {
  const html = renderEntityPlayOverview({ sections: [{ type: 'text', blocks: ['<counter> 4'] }], statuses: [] });
  assert.match(html, /&lt;counter&gt; 4/);
  assert.doesNotMatch(html, /entity-play-details|data-sheet-health/);
});

function healthApi({ controlled = true, restricted = false } = {}) {
  const calls = [];
  const actor = { id: 'actor-a', type: 'npc', audienceRestricted: restricted };
  return { calls, api: {
    tokens: { get: id => id === 'token-a' ? { id, actorId: actor.id } : null, resolveActor: () => ({ actor }) },
    multiplayer: { getStatus: () => ({ connected: true }), canControlToken: () => controlled },
    health: {
      applyDamageToTokenIds: async (...args) => { calls.push(['damage', ...args]); return ['damage-result']; },
      applyHealingToTokenIds: async (...args) => { calls.push(['healing', ...args]); return ['healing-result']; },
    },
  } };
}

test('play sheet damage and recovery always target the open Token instance', async () => {
  const { api, calls } = healthApi();
  const subject = { actorId: 'actor-a', tokenId: 'token-a' };
  assert.deepEqual(await applySheetHealthAction(api, subject, 'damage', { amount: '6', type: 'L' }), ['damage-result']);
  await applySheetHealthAction(api, subject, 'healing', { amount: 2, type: 'B' });
  assert.deepEqual(calls, [ ['damage', ['token-a'], { amount: 6, type: 'L' }], ['healing', ['token-a'], { amount: 2, type: 'B' }] ]);
});

test('play sheet rejects template-only, wrong Actor, unauthorized and invalid health edits', async () => {
  const { api, calls } = healthApi();
  const valid = { actorId: 'actor-a', tokenId: 'token-a' };
  for (const subject of [{ actorId: 'actor-a' }, { actorId: 'other', tokenId: 'token-a' }]) {
    await assert.rejects(applySheetHealthAction(api, subject, 'damage', { amount: 1, type: 'L' }));
  }
  for (const amount of [0, -1, 1.5, Infinity, 'bad']) await assert.rejects(applySheetHealthAction(api, valid, 'damage', { amount }));
  for (const options of [{ controlled: false }, { restricted: true }]) await assert.rejects(applySheetHealthAction(healthApi(options).api, valid, 'damage', { amount: 1 }));
  assert.deepEqual(calls, []);
  assert.equal(renderActorHealthPanel({}, { id: 'enemy', audienceRestricted: true }), '');
});

test('right side default geometry never overrides saved custom window positions', () => {
  const values = new Map([['prefs', JSON.stringify({ version: 1, windows: { 'actor:custom': { left: 125, top: 90, width: 620, height: 500 } } })]]);
  const manager = createActorSheetManager({ storageKey: 'prefs', storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, initialGeometry: () => ({ left: 900, top: 56, width: 700, height: 860 }) });
  assert.equal(manager.open({ actorId: 'fresh' }).record.left, 900);
  const saved = manager.open({ actorId: 'custom' }).record;
  assert.deepEqual([saved.left, saved.top, saved.width, saved.height], [125, 90, 620, 500]);
});
