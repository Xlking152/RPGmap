import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canManageStatuses,
  createStatusUiController,
  parseStatusDefinitionChanges,
  renderActorStatusSheet,
  renderTokenStatusBadges,
  sortStatuses,
} from '../src/status/ui.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

test('map badges keep critical conditions first and collapse after four badges', () => {
  const statuses = [
    { definitionId: 'blessed', label: '祝福' },
    { definitionId: 'status-incapacitated', label: '失能' },
    { definitionId: 'derived-unconscious', label: '昏迷' },
    { definitionId: 'poisoned', label: '中毒' },
    { definitionId: 'derived-dead', label: '死亡' },
  ];
  const sorted = sortStatuses(statuses);
  assert.deepEqual(sorted.slice(0, 3).map(status => status.label), ['死亡', '昏迷', '失能']);
  const html = renderTokenStatusBadges(statuses);
  assert.match(html, /title="死亡"/);
  assert.match(html, /title="昏迷"/);
  assert.match(html, /title="失能"/);
  assert.match(html, />\+1<\/span>/);
});

test('disabled statuses remain visible in the GM sheet but stay off map badges', () => {
  const statuses = [
    { definitionId: 'status-rooted', label: '定身', enabled: false },
    { definitionId: 'status-spirit', label: '灵体', enabled: true },
  ];
  assert.deepEqual(sortStatuses(statuses).map(status => status.label), ['灵体']);
  assert.deepEqual(sortStatuses(statuses, { includeDisabled: true }).map(status => status.label), ['定身', '灵体']);
  assert.doesNotMatch(renderTokenStatusBadges(statuses), /定身/);
});

test('status writes stay pending until the confirmation Promise settles', async () => {
  const confirmation = deferred();
  const calls = [];
  let renders = 0;
  const api = {
    multiplayer: { getCapabilities: () => ({ connected: true, canManageStatuses: true }) },
    status: { setStacks(payload) { calls.push(payload); return confirmation.promise; } },
  };
  const controller = createStatusUiController({ api, documentNode: {}, render: () => { renders += 1; } });
  const actionNode = { dataset: { statusAction: 'increment', statusScope: 'actor', statusTarget: 'actor-a', statusDefinition: 'poisoned', statusStacks: '1' } };
  const event = { preventDefault() {}, target: { closest: selector => selector === '[data-status-action]' ? actionNode : null } };
  assert.equal(controller.handleClick(event), true);
  assert.equal(controller.pendingKeys.has('actor:actor-a:poisoned'), true);
  assert.equal(renders, 1);
  await Promise.resolve();
  assert.deepEqual(calls, [{ scope: 'actor', targetId: 'actor-a', definitionId: 'poisoned', stacks: 2 }]);
  confirmation.resolve({ confirmed: true });
  await confirmation.promise;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(controller.pendingKeys.has('actor:actor-a:poisoned'), false);
  assert.equal(renders, 2);
});

test('OWNER and OBSERVER capabilities cannot mutate status data', () => {
  let calls = 0; let message = '';
  const api = {
    multiplayer: { getCapabilities: () => ({ connected: true, canManageStatuses: false, canEditActor: () => true }) },
    status: { remove() { calls += 1; } },
  };
  assert.equal(canManageStatuses(api), false);
  const controller = createStatusUiController({ api, documentNode: {}, setStatus: value => { message = value; } });
  const actionNode = { dataset: { statusAction: 'remove', statusScope: 'actor', statusTarget: 'actor-a', statusDefinition: 'rooted' } };
  controller.handleClick({ preventDefault() {}, target: { closest: selector => selector === '[data-status-action]' ? actionNode : null } });
  assert.equal(calls, 0);
  assert.match(message, /只有 GM/);
});

test('actor status sheet exposes GM batch controls and a read-only player view', () => {
  const definitions = [{ id: 'rooted', name: '定身', scopes: ['actor', 'token'], maxStacks: 1, builtIn: true }];
  const api = {
    status: {
      getDefinitions: () => definitions,
      resolve: context => ({
        actorStatuses: context.actorId ? [{ definitionId: 'rooted', label: '定身', scope: 'actor', targetId: context.actorId }] : [],
        tokenStatuses: context.tokenId ? [{ definitionId: 'rooted', label: '定身', scope: 'token', targetId: context.tokenId }] : [],
        derivedStatuses: [],
      }),
    },
  };
  const actor = { id: 'actor-a' };
  const tokens = [{ id: 'token-a', actorId: 'actor-a' }, { id: 'token-b', actorId: 'actor-a' }];
  const gm = renderActorStatusSheet({ api, actor, tokens, allTokens: tokens, selectedTokenIds: ['token-a', 'token-b'], canManage: true });
  assert.match(gm, /data-status-action="palette-submit"/);
  assert.match(gm, /data-status-use-map-selection checked/);
  assert.match(gm, /2 个 Token（批量）/);
  assert.match(gm, /data-status-use-actor-map-selection/);
  assert.match(gm, /1 个 Actor/);
  assert.match(gm, /data-status-action="remove"/);
  const readonly = renderActorStatusSheet({ api, actor, tokens, canManage: false });
  assert.match(readonly, /当前会话只读/);
  assert.doesNotMatch(readonly, /data-status-action="palette-submit"/);
  assert.match(readonly, /仅 GM 可修改/);
});

test('custom definition change editor accepts only the white-listed line format', () => {
  assert.deepEqual(parseStatusDefinitionChanges('resources.hp.max | add | 2\nresources.hp.current | min | 5'), [
    { target: 'resources.hp.max', mode: 'add', value: 2 },
    { target: 'resources.hp.current', mode: 'min', value: 5 },
  ]);
  assert.throws(() => parseStatusDefinitionChanges('resources.hp.max | script | 2'), /数值变化第 1 行无效/);
});

test('status UI is wired into Actor cards, Token inspector and app startup', () => {
  const entityUi = readFileSync(new URL('../src/entities/ui.js', import.meta.url), 'utf8');
  const appShell = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const mapRuntime = readFileSync(new URL('../src/runtime/map-runtime.js', import.meta.url), 'utf8');
  const statusUi = readFileSync(new URL('../src/status/ui.js', import.meta.url), 'utf8');
  const lazyTools = readFileSync(new URL('../src/ui/lazy-runtime-tools.js', import.meta.url), 'utf8');
  const quickHud = readFileSync(new URL('../src/status/quick-hud.js', import.meta.url), 'utf8');
  const tokenLayer = readFileSync(new URL('../src/render/token-layer.js', import.meta.url), 'utf8');
  assert.match(entityUi, /\['status','状态'\]/);
  assert.match(entityUi, /class="status-title-band"/);
  assert.match(entityUi, /class="entity-card-status"/);
  assert.match(entityUi, /status:change/);
  assert.match(appShell, /class="ui-status-summary"/);
  assert.match(appShell, /status:change/);
  assert.match(appShell, /tokenId/);
  assert.match(statusUi, /import\('\.\.\/ui\/lazy-runtime-tools\.js'\)/);
  assert.match(lazyTools, /createQuickStatusHud/);
  assert.match(quickHud, /api\.status\.applyBatch\(operations\)/);
  assert.match(quickHud, /\['buff', 'debuff', 'neutral'\]/);
  assert.match(tokenLayer, /renderTokenStatusBadges\(snapshot\.statuses, \{ limit: 4 \}\)/);
  assert.match(tokenLayer, /const statusViews = new Map\(\)/);
  assert.doesNotMatch(tokenLayer.match(/function renderStatuses[\s\S]*?function renderSummary/)?.[0] || '', /clearLayers\(\)/);
  assert.match(main, /runtime\/map-runtime\.js/);
  assert.match(mapRuntime, /createEntitySystem[\s\S]*createStatusSystem\(\)[\s\S]*createStatusUiSystem\(\)[\s\S]*createAppShellUi\(\)/);
});
