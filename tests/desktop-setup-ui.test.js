import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/app/desktop-setup.js', import.meta.url), 'utf8');
const script = `${source.replace(/^import .*;\r?\n/gm, '').replace('export async function startDesktopSetup', 'async function startDesktopSetup')}\nmodule.exports = { startDesktopSetup };`;

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.listeners = new Map(); this.value = ''; this.hidden = false; this.disabled = false;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (['value', 'type', 'id'].includes(name)) this[name] = value;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(...children) { children.forEach(node => { node.parent = this; this.children.push(node); }); }
  prepend(...children) { children.forEach(node => { node.parent = this; }); this.children.unshift(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.disabled ? undefined : this.listeners.get('click')?.({}); }
  event(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
}

const descendants = node => [node, ...node.children.flatMap(descendants)];
const hasClass = (node, name) => node.className?.split(' ').includes(name);
const findClass = (node, name) => descendants(node).find(item => hasClass(item, name));
const findText = (node, tag, text) => descendants(node).find(item => item.tag === tag && item.textContent === text);
const fieldByLabel = (node, label) => descendants(node).find(item => item.attributes['aria-label'] === label);

function fixture() {
  return {
    appVersion: '3.0.0', activeWorldId: 'world-a',
    maps: [{ id: 'lanzhou', version: '1.1.0', name: '北宋兰州城', previewUrl: '/api/packages/maps/lanzhou/1.1.0/files/preview.webp' }],
    rulesets: [{ id: 'infinite-horror', version: '1.1.0', name: '无限规则', builtIn: true }],
    worlds: [
      { id: 'world-a', name: '兰州纪事', ruleset: { id: 'infinite-horror', version: '1.1.0' }, sceneCount: 2, updatedAt: '2026-10-16T10:00:00Z', backups: [{ id: 'backup-a', reason: 'manual', createdAt: '2026-10-16T09:00:00Z' }] },
      { id: 'world-b', name: '西北行旅', ruleset: { id: 'infinite-horror', version: '1.1.0' }, sceneCount: 1, backups: [{ id: 'backup-b', reason: 'manual', createdAt: '2026-10-15T09:00:00Z' }] },
    ],
    connection: { port: 30000, playerUrls: ['http://192.168.1.2:30000'], joinCode: 'ABCD' },
  };
}

async function setup({ catalog = fixture(), storage = new Map(), desktop, post, confirm = () => true } = {}) {
  const container = new Element('div'), requests = [];
  const context = {
    document: { createElement: tag => new Element(tag), title: '' },
    location: { origin: 'http://127.0.0.1:30000', port: '30000', assign() {} },
    URL, module: { exports: {} }, confirm,
    globalThis: { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } },
  };
  vm.runInNewContext(script, context);
  const api = await context.module.exports.startDesktopSetup({ container, desktop, fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    if (options.method === 'GET') return { ok: true, json: async () => structuredClone(catalog) };
    return post ? post(url, options) : { ok: true, json: async () => ({}) };
  } });
  const panel = name => descendants(container).find(node => node.dataset.view === name);
  const navigate = name => {
    const navigation = findClass(container, 'setup-navigation');
    return navigation.children.find(node => node.children.some(child => child.textContent === name)).click();
  };
  return { container, api, requests, panel, navigate, storage };
}

test('management navigation persists its selected view and separates five work areas', async () => {
  const storage = new Map();
  const first = await setup({ storage });
  assert.equal(first.panel('worlds').hidden, false);
  assert.equal(descendants(first.container).filter(node => node.dataset.view).length, 5);
  await first.navigate('地图');
  assert.equal(first.panel('worlds').hidden, true);
  assert.equal(first.panel('maps').hidden, false);
  await first.api.refresh();
  assert.equal(first.panel('maps').hidden, false);
  assert.equal(storage.get('rpgmap:management:view'), 'maps');
  const second = await setup({ storage });
  assert.equal(second.panel('maps').hidden, false);
  assert.equal(second.panel('settings').hidden, true);
});

test('world search filters keyed rows without replacing the input and selection opens real details', async () => {
  const ui = await setup();
  const input = fieldByLabel(ui.container, '搜索世界名称或规则');
  const rows = descendants(ui.panel('worlds')).filter(node => hasClass(node, 'setup-world-row'));
  input.value = '西北'; await input.event('input');
  assert.deepEqual(rows.map(row => row.hidden), [true, false]);
  assert.equal(fieldByLabel(ui.container, '搜索世界名称或规则'), input);
  await fieldByLabel(ui.panel('worlds'), '查看 西北行旅').click();
  assert.equal(findClass(ui.panel('worlds'), 'setup-detail-title').children[0].textContent, '西北行旅');
  assert.equal(rows[1].dataset.selected, 'true');
  input.value = '不存在'; await input.event('input');
  assert.equal(findText(ui.panel('worlds'), 'h3', '没有匹配的世界').parent.hidden, false);
});

test('management previews come from catalog references and never assume an installed map belongs to a world', async () => {
  const catalog = fixture();
  const ui = await setup({ catalog });
  assert.equal(descendants(ui.panel('worlds')).some(node => node.tag === 'img'), false);
  assert.equal(findClass(ui.panel('maps'), 'setup-map-preview').attributes.src, catalog.maps[0].previewUrl);
  catalog.worlds[0].mapPackage = { id: 'lanzhou', version: '1.1.0' };
  await ui.api.refresh();
  assert.equal(findClass(ui.panel('worlds'), 'setup-detail-preview').attributes.src, catalog.maps[0].previewUrl);
});

test('create world dialog validates blank selections and submits selected package references', async () => {
  const ui = await setup();
  await findText(ui.container, 'button', '新建世界').click();
  const dialog = findClass(ui.container, 'setup-dialog');
  assert.equal(dialog.open, true);
  assert.equal(fieldByLabel(dialog, 'World 名称').focused, true);
  const form = findClass(dialog, 'setup-create-world');
  fieldByLabel(dialog, 'World 名称').value = '  新旅程  ';
  fieldByLabel(dialog, 'World 规则').value = '';
  await form.event('submit');
  assert.equal(ui.requests.some(request => request.method === 'POST'), false);
  assert.equal(dialog.open, true, 'failed creation retains the editable dialog');
  fieldByLabel(dialog, 'World 规则').value = '0';
  await form.event('submit');
  const submitted = ui.requests.find(request => request.url === '/api/manage/worlds');
  assert.deepEqual(submitted.body, { name: '新旅程', ruleset: { id: 'infinite-horror', version: '1.1.0' }, mapPackage: { id: 'lanzhou', version: '1.1.0' } });
  assert.equal(dialog.open, false);
  assert.equal(findClass(ui.container, 'setup-dialog'), undefined);
});

test('missing packages disable create and unavailable world launch without hiding dependency errors', async () => {
  const catalog = fixture(); catalog.maps = [];
  catalog.worlds[0].missingDependencies = [{ id: 'lanzhou', version: '1.1.0' }];
  const ui = await setup({ catalog });
  const detail = findClass(ui.panel('worlds'), 'setup-detail');
  assert.equal(findText(detail, 'button', '启动世界').disabled, true);
  assert.match(findClass(detail, 'setup-warning').textContent, /lanzhou@1\.1\.0/);
  await findText(ui.container, 'button', '新建世界').click();
  assert.equal(findText(findClass(ui.container, 'setup-dialog'), 'button', '创建世界').disabled, true);
});

test('backup restore uses the selected world and record, and cancellation performs no write', async () => {
  let accepted = false;
  const ui = await setup({ confirm: () => accepted });
  await ui.navigate('恢复点');
  const selector = fieldByLabel(ui.panel('backups'), '恢复点所属世界');
  selector.value = 'world-b'; await selector.event('change');
  await findText(ui.panel('backups'), 'button', '恢复此记录').click();
  assert.equal(ui.requests.some(request => request.url.endsWith('/restore')), false);
  accepted = true;
  await findText(ui.panel('backups'), 'button', '恢复此记录').click();
  assert.deepEqual(ui.requests.find(request => request.url.endsWith('/restore')).body, { worldId: 'world-b', backupId: 'backup-b' });
  assert.equal(ui.panel('backups').hidden, false);
});

test('settings preserve desktop integration and port validation, while browser hides desktop-only commands', async () => {
  const calls = [];
  const desktop = Object.fromEntries(['importWorld', 'importLegacyDirectory', 'openDataDirectory', 'openGameInBrowser', 'installUpdate', 'exit', 'setPort', 'launchWorld'].map(name => [name, async value => calls.push([name, value])]));
  const ui = await setup({ desktop });
  await ui.navigate('设置');
  for (const title of ['打开用户数据目录', '导入旧版数据目录', '在浏览器打开游戏', '运行新版安装器', '保存并退出']) await findText(ui.panel('settings'), 'button', title).click();
  assert.deepEqual(calls.map(call => call[0]), ['openDataDirectory', 'importLegacyDirectory', 'openGameInBrowser', 'installUpdate', 'exit']);
  let port = fieldByLabel(ui.panel('settings'), '服务端口'); port.value = '80';
  await findClass(ui.panel('settings'), 'setup-port-form').event('submit');
  assert.equal(calls.some(call => call[0] === 'setPort'), false);
  port = fieldByLabel(ui.panel('settings'), '服务端口'); port.value = '31000';
  await findClass(ui.panel('settings'), 'setup-port-form').event('submit');
  assert.deepEqual(calls.at(-1), ['setPort', 31000]);
  const browser = await setup();
  assert.equal(findText(browser.container, 'button', '保存并退出'), undefined);
  assert.ok(findText(browser.panel('settings'), 'button', '导入旧版存档'));
});

test('management requests render server text safely and preserve the last valid catalog on mutation failure', async () => {
  const catalog = fixture(); catalog.worlds[0].name = '<img src=x onerror=alert(1)>';
  const ui = await setup({ catalog, post: async () => ({ ok: false, status: 409, json: async () => ({ message: '备份失败', references: [{ worldId: 'world-a' }] }) }) });
  assert.ok(findText(ui.panel('worlds'), 'h3', '<img src=x onerror=alert(1)>'));
  await findText(findClass(ui.panel('worlds'), 'setup-detail'), 'button', '建立恢复点').click();
  const status = descendants(ui.container).find(node => node.attributes.role === 'status');
  assert.match(status.textContent, /备份失败.*world-a/);
  assert.equal(status.dataset.error, 'true');
  assert.equal(descendants(ui.panel('worlds')).filter(node => hasClass(node, 'setup-world-row')).length, 2);
});
