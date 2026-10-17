import assert from 'node:assert/strict';
import test from 'node:test';
import { describeObjectInspector } from '../src/ui/object-inspector.js';

test('object inspector consumes health presentation and confirmed vision without mutating runtime data', () => {
  const token = Object.freeze({ id: 'one', elevationMeters: 2, movement: { mode: 'fly' } });
  const api = { health: { resolveToken: () => ({ current: 18, max: 24 }) },
    vision: { getSource: () => 'one', getVisibleRegion: () => ({ preciseRangeMeters: 40, vagueRangeMeters: 60 }) } };
  const result = describeObjectInspector(api, token, { partyId: 'party-default' });
  assert.equal(result.health.label, '18/24');
  assert.equal(result.health.segments[0].percent, 75);
  assert.deepEqual(result.properties, [['移动', '飞行'], ['高度', '2 m'], ['视野', '40 / 60 m'], ['队伍', '玩家队伍']]);
});

test('public actor summaries never resolve private health, movement or vision', () => {
  const api = new Proxy({}, { get() { throw new Error('Private runtime accessed'); } });
  const result = describeObjectInspector(api, { id: 'npc' }, { audienceRestricted: true });
  assert.deepEqual(result, { restricted: true, health: null, properties: [] });
});

test('minimal ruleset stays usable without health and does not reuse another token vision', () => {
  const api = { vision: { getSource: () => 'other', getVisibleRegion() { throw new Error('Wrong source'); } } };
  const result = describeObjectInspector(api, { id: 'one' }, {});
  assert.equal(result.health, null);
  assert.equal(result.properties[2][1], '未选为来源');
});

test('health segments preserve ruleset semantics, clamp layout and sanitize colors', () => {
  const api = { health: { resolveToken: () => ({ max: 20 }) }, ruleset: { health: { presentation: { describe: () => ({
    compactSummary: false, summary: '伤势 3 / 20', segments: [
      { value: 100, color: 'red;position:fixed' }, { value: 3, color: '#ae493e', label: '伤势' },
    ],
  }) } } } };
  const result = describeObjectInspector(api, { id: 'one', vision: { enabled: false } }, {});
  assert.equal(result.health.label, '伤势 3 / 20');
  assert.deepEqual(result.health.segments.map(item => item.percent), [100, 15]);
  assert.equal(result.health.segments[0].color, '#36966c');
  assert.equal(result.properties[2][1], '未启用');
});
