import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesEntitySearch, renderEntitySheetSection, decodeEntityData } from '../src/entities/sheet-renderer.js';
import { renderSheetBadges } from '../src/entities/sheet/parts.js';
import { createEntityTokenController } from '../src/entities/token-controller.js';
import { createDefaultActor } from '../src/actor/model.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

test('entity search matches names and forms without changing the source', () => {
  const name = '银 Silver · 普通形态';
  assert.equal(matchesEntitySearch(name, ' silver '), true);
  assert.equal(matchesEntitySearch(name, '普通'), true);
  assert.equal(matchesEntitySearch(name, '守卫'), false);
  assert.equal(matchesEntitySearch(name, ''), true);
  assert.equal(matchesEntitySearch(null, '银'), false);
});

test('resource presentation labels real values and preserves ruleset operations', () => {
  const decrement = { type: 'resource.adjust', resourceId: 'spirit', value: -1 };
  const current = { type: 'resource.set', resourceId: 'spirit' };
  const maximum = { type: 'resource.max', resourceId: 'spirit' };
  const section = { id: 'runtime', type: 'resources', title: '资源', items: [{
    id: 'spirit', label: '精神', current: 8, max: 10,
    decrementOperation: decrement, currentOperation: current, maxOperation: maximum,
  }] };
  const before = structuredClone(section);
  const html = renderEntitySheetSection(section);
  assert.match(html, /aria-label="精神当前值"/);
  assert.match(html, /aria-label="精神最大值"/);
  assert.match(html, /aria-label="减少精神"/);
  assert.match(html, /width:80%/);
  const operations = [...html.matchAll(/data-actor-operation="([^"]+)"/g)].map(match => decodeEntityData(match[1]));
  assert.deepEqual(operations, [decrement, current, maximum]);
  assert.deepEqual(section, before);
});

test('sheet badges distinguish template, linked and independent contexts', () => {
  const actor = { id: 'a', type: 'pc' };
  const context = { level: 'owner', mode: 'play', canToggleMode: true };
  assert.match(renderSheetBadges({ actor, context }), /模板资料/);
  assert.match(renderSheetBadges({ actor, token: { actorLink: true }, context }), /共享角色/);
  assert.match(renderSheetBadges({ actor, token: { actorLink: false }, context }), /独立实例/);
  const limited = renderSheetBadges({ actor, context: { limited: true, level: 'limited' } });
  assert.match(limited, /公开资料/);
  assert.doesNotMatch(limited, /data-sheet-mode-toggle/);
});

test('wide ruleset tables remain in a keyboard-accessible scrolling region', () => {
  const html = renderEntitySheetSection({ id: 'skills', type: 'table', title: '技能', columns: ['名称', '效果'], rows: [['<script>', '公开']] });
  assert.match(html, /class="entity-table-scroll" role="region" aria-label="技能" tabindex="0"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('token configuration uses audience-safe actor presentation and retains instance controls', () => {
  const actor = createDefaultActor({ id: 'guard', name: '守卫', type: 'npc', ruleset: infiniteHorrorRuleset });
  const token = { id: 'guard-instance', actorId: actor.id, name: '守卫 1', actorLink: false, x: 4, y: 5, vision: {}, effects: [] };
  const before = structuredClone({ actor, token });
  const api = {
    ruleset: infiniteHorrorRuleset,
    tokens: { list: () => [token], get: () => token, create() {}, move() {}, update() {}, resolveActor: () => ({ actor }) },
    world: { get: () => ({}), commit() {}, getActiveScene: () => ({ name: '西市', settings: {} }) },
  };
  const controller = createEntityTokenController({ api, capabilities: () => ({ canManageStructure: true }) });
  const html = controller.renderActorTokenSection(actor);
  assert.match(html, /aria-label="棋子设置"/);
  assert.match(html, /<option value="unlinked" selected>独立实例/);
  assert.match(html, /data-token-link data-token-id="guard-instance" disabled/);
  assert.match(html, /data-token-name data-token-id="guard-instance"/);
  assert.match(html, /所在场景/);
  assert.deepEqual({ actor, token }, before);
});
