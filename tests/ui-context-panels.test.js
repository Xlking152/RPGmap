import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuickStatusHud } from '../src/status/quick-hud.js';
import { renderStatusDefinitionEditor } from '../src/status/definition-editor.js';
import { createUiIcon, renderUiIcon } from '../src/ui/icons.js';

test('shared icons use bounded dimensions and safe fallback markup', () => {
  assert.match(renderUiIcon('x'), /class="ui-icon" width="18" height="18"/);
  assert.equal(renderUiIcon('__proto__'), renderUiIcon('circle'));
  assert.equal(renderUiIcon('<img src=x onerror=alert(1)>'), renderUiIcon('circle'));
  assert.match(renderUiIcon('user', { size: 1000 }), /width="96"/);
  assert.match(renderUiIcon('user', { size: '" onload="x' }), /width="18"/);
  assert.match(renderUiIcon('shield'), /aria-hidden="true" focusable="false"/);
});

test('shared DOM icons are created in the SVG namespace without global document', () => {
  const documentNode = { createElementNS(namespace, tag) {
    return { namespace, tag, attributes: {}, children: [],
      setAttribute(name, value) { this.attributes[name] = value; },
      append(child) { this.children.push(child); } };
  } };
  const icon = createUiIcon(documentNode, 'x', { size: 20 });
  assert.equal(icon.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(icon.tag, 'svg');
  assert.equal(icon.attributes.width, '20');
  assert.ok(icon.children.length > 0);
  assert.ok(icon.children.every(child => child.namespace === icon.namespace));
});

function createHudFixture({ tokens, statuses = {}, tokenStatuses = {}, controlled = true, applyBatch = async () => {}, world = null } = {}) {
  const handlers = new Map();
  let hud = null;
  const documentNode = {
    defaultView: { innerWidth: 390, innerHeight: 844 },
    body: { append(node) { hud = node; } },
    querySelector() { return hud; },
    addEventListener(type, handler) { handlers.set(type, handler); },
    removeEventListener(type) { handlers.delete(type); },
    createElement() {
      return {
        dataset: {}, style: {}, attributes: {}, innerHTML: '',
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        getBoundingClientRect() { return { width: 356, height: 550 }; },
        remove() { if (hud === this) hud = null; },
      };
    },
  };
  const messages = [];
  const api = {
    tokens: { get: id => tokens.find(token => token.id === id), list: () => tokens },
    selection: { getSelectedTokenIds: () => tokens.map(token => token.id) },
    permissions: { can: () => controlled },
    world,
    status: {
      getDefinitions: () => [{ id: 'blessed', name: 'Blessed', icon: 'sparkles', category: 'buff', scopes: ['actor'] }],
      resolve: ({ tokenId }) => ({ actorStatuses: statuses[tokenId] || [], tokenStatuses: tokenStatuses[tokenId] || [] }),
      applyBatch,
    },
    showToast: value => messages.push(value),
  };
  const controller = createQuickStatusHud({ api, documentNode });
  const clickStatus = () => handlers.get('click')({
    preventDefault() {},
    target: { closest: selector => selector === '[data-status-quick-hud]' ? hud
      : selector === '[data-quick-status]' ? { dataset: { quickStatus: 'blessed' } } : null },
  });
  return { controller, handlers, messages, clickStatus, getHud: () => hud };
}

const independentTokens = [
  { id: 'one', actorId: 'actor', actorLink: false },
  { id: 'two', actorId: 'actor', actorLink: false },
];

test('quick HUD reports mixed selection instead of presenting the primary state as shared', () => {
  const fixture = createHudFixture({ tokens: independentTokens,
    statuses: { one: [{ definitionId: 'blessed', enabled: true }] } });
  fixture.controller.open('one', { clientX: 380, clientY: 830 });
  const hud = fixture.getHud();
  assert.equal(hud.attributes.role, 'dialog');
  assert.match(hud.innerHTML, /data-state="mixed" aria-pressed="mixed"/);
  assert.match(hud.innerHTML, /1 \/ 2 已生效/);
  assert.match(hud.innerHTML, /主棋子当前状态/);
  assert.match(hud.innerHTML, /class="status-lucide"/);
  assert.match(hud.innerHTML, /<details class="status-quick-group" data-status-neutral>/);
  assert.equal(hud.style.left, '26px');
  assert.equal(hud.style.top, '286px');
});

test('quick HUD preserves separate instance writes and placement after confirmation', async () => {
  const operations = [];
  const fixture = createHudFixture({ tokens: independentTokens,
    statuses: { one: [{ definitionId: 'blessed', enabled: true }] },
    applyBatch: async values => { operations.push(...values); } });
  fixture.controller.open('one', { clientX: 12, clientY: 20 });
  await fixture.clickStatus();
  assert.deepEqual(operations, [
    { type: 'status.setStacks', scope: 'syntheticActor', targetId: 'one', definitionId: 'blessed', stacks: 1, enabled: false },
    { type: 'status.apply', scope: 'syntheticActor', targetId: 'two', definitionId: 'blessed', stacks: 1 },
  ]);
  assert.equal(fixture.getHud().style.left, '12px');
  assert.equal(fixture.getHud().style.top, '20px');
});

test('quick HUD keeps one shared Actor write for linked Tokens', async () => {
  const operations = [];
  const fixture = createHudFixture({ tokens: independentTokens.map(token => ({ ...token, actorLink: true })),
    applyBatch: async values => operations.push(...values) });
  fixture.controller.open('one');
  await fixture.clickStatus();
  assert.deepEqual(operations, [{ type: 'status.apply', scope: 'actor', targetId: 'actor', definitionId: 'blessed', stacks: 1 }]);
});

test('quick HUD displays Token-local enabled state and submits mixed scopes through one canonical batch', async () => {
  const submitted = [];
  const fixture = createHudFixture({ tokens: [independentTokens[0]],
    statuses: { one: [{ definitionId: 'blessed', enabled: true }] },
    tokenStatuses: { one: [{ definitionId: 'blessed', enabled: true }] },
    applyBatch: () => assert.fail('mixed scopes must not use the legacy Synthetic-only bridge'),
    world: { performOperations: async (...args) => submitted.push(args) } });
  fixture.controller.open('one');
  assert.match(fixture.getHud().innerHTML, /data-state="enabled" aria-pressed="true"/);
  await fixture.clickStatus();
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0][0].map(operation => [operation.type, operation.payload.scope, operation.payload.enabled]), [
    ['status.setStacks', 'syntheticActor', false], ['status.setStacks', 'token', false],
  ]);
  assert.equal(submitted[0][1].kind, 'status');
});

test('quick HUD refuses a batch containing an uncontrolled Token', async () => {
  let submissions = 0;
  const fixture = createHudFixture({ tokens: independentTokens, controlled: false,
    applyBatch: async () => { submissions++; } });
  fixture.controller.open('one');
  await fixture.clickStatus();
  assert.equal(submissions, 0);
  assert.equal(fixture.messages.length, 1);
});

test('quick HUD blocks duplicate pending clicks and does not reopen after Escape', async () => {
  let confirm;
  let submissions = 0;
  const confirmation = new Promise(resolve => { confirm = resolve; });
  const fixture = createHudFixture({ tokens: independentTokens,
    applyBatch: () => { submissions++; return confirmation; } });
  fixture.controller.open('one');
  const first = fixture.clickStatus();
  assert.equal(fixture.getHud().attributes['aria-busy'], 'true');
  await fixture.clickStatus();
  assert.equal(submissions, 1);
  let prevented = false;
  fixture.handlers.get('keydown')({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(fixture.getHud(), null);
  confirm();
  await first;
  assert.equal(fixture.getHud(), null);
  fixture.controller.destroy();
  assert.equal(fixture.handlers.size, 0);
});

test('definition editor preserves canonical field names and declared capability values', () => {
  const html = renderStatusDefinitionEditor({ id: 'watch', name: 'Watch', category: 'buff', icon: 'eye',
    scopes: ['actor'], defaultDuration: { unit: 'rounds', value: 2 },
    capabilities: { canMove: false, canInteract: true, visionPrecision: 'vague', collisionBypassGroups: ['structure'] },
    changes: [{ target: 'resources.hp.max', mode: 'add', value: 2 }] });
  for (const name of ['id', 'name', 'category', 'icon', 'color', 'maxStacks', 'defaultDurationUnit',
    'defaultDurationValue', 'description', 'canMove', 'canInteract', 'canActInCombat',
    'visionPrecision', 'collisionBypassStructure', 'changes']) {
    assert.equal((html.match(new RegExp(`name="${name}"`, 'g')) || []).length, 1, name);
  }
  assert.match(html, /name="id"[^>]+readonly/);
  assert.match(html, /name="canMove"><option[^>]+>[^<]+<\/option><option[^>]+>[^<]+<\/option><option value="false" selected>/);
  assert.match(html, /name="defaultDurationUnit"[\s\S]*value="rounds" selected/);
  assert.match(html, /resources\.hp\.max \| add \| 2/);
  assert.match(html, /<details class="status-definition-advanced" open>/);
  assert.match(html, /aria-labelledby="status-definition-title"/);
});

test('definition editor escapes user content and keeps new required identity visible', () => {
  const html = renderStatusDefinitionEditor({ name: '<img src=x onerror=alert(1)>', description: '</textarea><script>x</script>' });
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;img/);
  assert.match(html, /name="id"[^>]+required/);
  assert.ok(html.indexOf('name="id"') < html.indexOf('<details'));
});
