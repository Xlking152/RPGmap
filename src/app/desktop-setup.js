import './desktop-setup.css';
import { createElement, Boxes, BookOpen, Check, Copy, Download, ExternalLink, FolderOpen, Globe, History, Map as MapIcon, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, Trash2, Upload, X } from 'lucide';

const displayName = item => item?.name || item?.title || item?.manifest?.name || item?.id || '未命名';
const referenceLabel = item => item ? `${item.id}@${item.version}` : '未指定';
const reference = item => ({ id: item.id, version: item.version });
const worldId = world => world.id || world.worldId;
const views = [['worlds', '世界', () => Globe], ['maps', '地图', () => MapIcon], ['rulesets', '规则', () => BookOpen], ['backups', '恢复点', () => History], ['settings', '设置', () => Settings]];
const managementError = (result, status) => {
  const message = result.message || result.error || `请求失败：${status}`;
  const references = result.references || (Array.isArray(result.details) ? result.details : result.details?.references);
  if (!Array.isArray(references) || !references.length) return String(message);
  return `${message} · 引用位置：${references.map(item => [item.worldId, item.sceneId || item.name, item.backupId ? `恢复点 ${item.backupId}` : null].filter(Boolean).join(' / ')).join('；')}`;
};

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined) node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}

function icon(getIcon) {
  if (typeof createElement !== 'function' || !document.createElementNS) return element('span', { 'aria-hidden': true });
  return createElement(getIcon(), { width: 18, height: 18, 'stroke-width': 1.7, 'aria-hidden': 'true', focusable: 'false' });
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

const field = (label, control) => element('label', { className: 'setup-field' }, [element('span', { text: label }), control]);
const facts = items => element('dl', { className: 'setup-facts' }, items.flatMap(([label, value]) => [element('dt', { text: label }), element('dd', { text: String(value ?? '—') })]));

export async function startDesktopSetup({ container = document.getElementById('app'), fetchImpl = globalThis.fetch, desktop = globalThis.rpgmapDesktop } = {}) {
  if (!container) throw new Error('缺少管理首页容器。');
  document.title = 'RPGmap · 世界管理';
  let catalog = null, busy = false, selectedWorldId = null, backupWorldId = null, openDialog = null;
  let activeView = 'worlds';
  try { activeView = globalThis.localStorage?.getItem('rpgmap:management:view') || activeView; } catch { /* Storage can be disabled. */ }
  if (!views.some(([id]) => id === activeView)) activeView = 'worlds';
  const status = element('p', { className: 'setup-status', role: 'status', 'aria-live': 'polite', text: '正在读取世界与内容包…' });
  const content = element('main', { className: 'setup-content', id: 'setup-main' });
  const nav = element('nav', { className: 'setup-navigation', 'aria-label': '管理导航' });
  const version = element('span', { className: 'setup-version' });
  const activeLabel = element('span', { className: 'setup-active-world' });
  const panels = new Map(), navButtons = new Map();

  async function request(endpoint, { method = 'GET', body, type } = {}) {
    const response = await fetchImpl(`/api/manage/${endpoint}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body !== undefined ? { 'Content-Type': type || 'application/json' } : undefined,
      body: body === undefined ? undefined : type === 'application/octet-stream' ? body : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(managementError(result, response.status));
    return result;
  }

  function notify(message, error = false) { status.textContent = message; status.dataset.error = String(error); }

  async function action(work, message = '操作已完成。') {
    if (busy) return false;
    busy = true; container.dataset.busy = 'true'; container.setAttribute('aria-busy', 'true'); notify('正在处理…');
    try {
      const result = await work();
      if (result?.canceled) { notify('已取消。'); return false; }
      await refresh();
      notify(typeof message === 'function' ? message(result) : message);
      return true;
    } catch (error) { notify(error.message || '操作失败。', true); return false; }
    finally { busy = false; container.dataset.busy = 'false'; container.setAttribute('aria-busy', 'false'); }
  }

  function button(text, work, { primary = false, danger = false, disabled = false, symbol, local = false, title } = {}) {
    const node = element('button', {
      type: 'button', className: `setup-button${primary ? ' is-primary' : ''}${danger ? ' is-danger' : ''}`, text,
      ...(title ? { title, 'aria-label': title } : {}), onclick: local ? work : () => action(work),
    });
    if (symbol) node.prepend?.(icon(symbol));
    node.disabled = disabled;
    return node;
  }

  function switchView(id) {
    if (!views.some(([key]) => key === id)) return;
    activeView = id;
    try { globalThis.localStorage?.setItem('rpgmap:management:view', id); } catch { /* Navigation works without storage. */ }
    for (const [key, panel] of panels) panel.hidden = key !== id;
    for (const [key, node] of navButtons) node.setAttribute('aria-current', key === id ? 'page' : 'false');
  }

  function page(id, title, count, actions = []) {
    const body = element('div', { className: 'setup-view-body' });
    const node = element('section', { className: `setup-view setup-view-${id}`, 'aria-labelledby': `setup-title-${id}`, dataset: { view: id } }, [
      element('div', { className: 'setup-view-heading' }, [
        element('div', { className: 'setup-title-group' }, [element('h1', { id: `setup-title-${id}`, text: title }), ...(count === undefined ? [] : [element('span', { className: 'setup-count', text: count })])]),
        element('div', { className: 'setup-actions' }, actions),
      ]), body,
    ]);
    panels.set(id, node); content.append(node); return body;
  }

  function empty(title, detail, symbol = () => Boxes) {
    return element('div', { className: 'setup-empty' }, [icon(symbol), element('h3', { text: title }), ...(detail ? [element('p', { text: detail })] : [])]);
  }

  function search(label, onChange) {
    const input = element('input', { type: 'search', placeholder: label, 'aria-label': label, oninput: () => onChange(input.value.trim().toLocaleLowerCase()) });
    return element('label', { className: 'setup-search' }, [icon(() => Search), input]);
  }

  function optionSelect(items, { placeholder = '请选择', required = true } = {}) {
    const select = element('select', { ...(required ? { required: true } : {}) });
    select.append(element('option', { value: '', text: placeholder }));
    items.forEach((item, index) => select.append(element('option', { value: index, text: `${displayName(item)}${item.version ? ` · ${item.version}` : ''}` })));
    return select;
  }

  async function importFile(kind) {
    if (desktop) return kind === 'world' ? desktop.importWorld() : desktop.importPackage(kind);
    const spec = { map: { accept: '.rpgmap', endpoint: 'maps' }, ruleset: { accept: '.rpgrules', endpoint: 'rulesets' }, world: { accept: '.json', endpoint: 'worlds/import' } }[kind];
    return new Promise((resolve, reject) => {
      const input = element('input', { type: 'file', accept: spec.accept });
      input.addEventListener('cancel', () => resolve({ canceled: true }), { once: true });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) { resolve({ canceled: true }); return; }
        try {
          const bytes = await file.arrayBuffer();
          if (kind !== 'world') {
            const preview = await request(`${spec.endpoint}/inspect`, { method: 'POST', type: 'application/octet-stream', body: bytes });
            if (!confirm(`${preview.title}\nID：${preview.id}\n版本：${preview.version}\n兼容契约：${JSON.stringify(preview.compatibility)}\n文件数：${preview.filesCount}\n${kind === 'ruleset' ? '仅导入信任作者提供的 RPGmap 规则契约包。安装后会执行规则代码，不提供第三方代码沙箱。\n' : ''}确认导入？`)) { resolve({ canceled: true }); return; }
          }
          const response = await fetchImpl(`/api/manage/${spec.endpoint}`, {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': kind === 'world' ? 'application/json' : 'application/octet-stream' }, body: bytes,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(managementError(result, response.status));
          resolve(result);
        } catch (error) { reject(error); }
      }, { once: true });
      input.click();
    });
  }

  async function launch(id) {
    if (desktop) return desktop.launchWorld(id);
    const result = await request('worlds/activate', { method: 'POST', body: { worldId: id } });
    const updated = await request('catalog');
    const target = result.connection?.hostUrl || result.connection?.localUrl || updated.connection?.hostUrl || updated.connection?.localUrl || '/';
    const url = new URL(target, location.origin);
    if (url.origin !== location.origin) throw new Error('服务器返回了不同来源的游戏地址。');
    location.assign(url.href); return result;
  }

  function createWorldDialog() {
    if (openDialog) return;
    const maps = catalog.maps || [], rulesets = catalog.rulesets || [], priorFocus = document.activeElement;
    const name = element('input', { type: 'text', maxlength: 80, required: true, placeholder: '世界名称', 'aria-label': 'World 名称', autocomplete: 'off' });
    const ruleSelect = optionSelect(rulesets, { placeholder: '选择规则' }), mapSelect = optionSelect(maps, { placeholder: '选择起始地图' });
    ruleSelect.setAttribute('aria-label', 'World 规则'); mapSelect.setAttribute('aria-label', '起始地图');
    if (rulesets.length === 1) ruleSelect.value = '0';
    if (maps.length === 1) mapSelect.value = '0';
    const close = () => { dialog.close?.(); dialog.remove?.(); openDialog = null; priorFocus?.focus?.(); };
    const create = element('button', { type: 'submit', className: 'setup-button is-primary', text: '创建世界' });
    create.disabled = !maps.length || !rulesets.length;
    const errorMessage = element('p', { className: 'setup-warning', role: 'alert' });
    errorMessage.hidden = true;
    const form = element('form', { className: 'setup-create-world', onsubmit: async event => {
      event.preventDefault();
      errorMessage.hidden = true;
      const succeeded = await action(async () => {
        const selectedRule = ruleSelect.value !== '' && rulesets[Number(ruleSelect.value)];
        const selectedMap = mapSelect.value !== '' && maps[Number(mapSelect.value)];
        if (!selectedRule || !selectedMap || !name.value.trim()) throw new Error('请填写名称，并选择规则与地图。');
        const created = await request('worlds', { method: 'POST', body: { name: name.value.trim(), ruleset: reference(selectedRule), mapPackage: reference(selectedMap) } });
        selectedWorldId = created.id || created.worldId || selectedWorldId;
        return created;
      }, '世界已创建，可以开始游戏。');
      if (succeeded) close();
      else { errorMessage.textContent = status.textContent; errorMessage.hidden = false; }
    } }, [field('世界名称', name), field('规则包', ruleSelect), field('起始地图', mapSelect),
      ...(!maps.length || !rulesets.length ? [element('p', { className: 'setup-warning', text: !maps.length ? '尚未安装地图包。' : '尚未安装规则包。' })] : []),
      errorMessage,
      element('div', { className: 'setup-dialog-actions' }, [button('取消', close, { local: true }), create]),
    ]);
    const dialog = element('dialog', { className: 'setup-dialog', 'aria-labelledby': 'setup-create-title', oncancel: close }, [
      element('header', { className: 'setup-dialog-heading' }, [element('h2', { id: 'setup-create-title', text: '新建世界' }), button('', close, { local: true, symbol: () => X, title: '关闭新建世界' })]), form,
    ]);
    openDialog = dialog; container.append(dialog);
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    name.focus?.();
  }

  function backupsFor(world) { return world.backups || (catalog.backups || []).filter(item => item.worldId === worldId(world)); }
  function previewFor(world) {
    if (world.previewUrl) return world.previewUrl;
    const mapRef = world.mapPackage || world.scenes?.find(scene => scene.id === world.activeSceneId)?.mapPackage || world.scenes?.[0]?.mapPackage;
    return mapRef && (catalog.maps || []).find(item => item.id === mapRef.id && item.version === mapRef.version)?.previewUrl;
  }
  function worldState(world) {
    if (world.unavailable || world.missingDependencies?.length) return ['缺少依赖', 'warning'];
    return catalog.activeWorldId === worldId(world) ? ['运行中', 'active'] : ['未运行', 'idle'];
  }
  const stateBadge = (text, state = 'idle') => element('span', { className: 'setup-state', dataset: { state }, text });

  function renderWorlds() {
    const worlds = catalog.worlds || [];
    if (!worlds.some(world => worldId(world) === selectedWorldId)) selectedWorldId = catalog.activeWorldId || (worlds[0] && worldId(worlds[0]));
    const body = page('worlds', '我的世界', worlds.length, [button('导入存档', () => importFile('world'), { symbol: () => Upload }), button('新建世界', createWorldDialog, { primary: true, symbol: () => Plus, local: true })]);
    const list = element('div', { className: 'setup-world-list' }), detail = element('aside', { className: 'setup-detail', 'aria-label': '世界详情' }), rows = [];
    const noResults = empty('没有匹配的世界', null, () => Search); noResults.hidden = true;
    function select(world) {
      selectedWorldId = worldId(world);
      for (const row of rows) { row.node.dataset.selected = String(row.id === selectedWorldId); row.select.setAttribute('aria-pressed', String(row.id === selectedWorldId)); }
      const state = worldState(world), imageUrl = previewFor(world), backups = backupsFor(world);
      const rule = (catalog.rulesets || []).find(item => item.id === world.ruleset?.id && item.version === world.ruleset?.version);
      detail.replaceChildren(
        element('div', { className: 'setup-detail-title' }, [element('h2', { text: displayName(world) }), stateBadge(...state)]),
        imageUrl ? element('img', { className: 'setup-detail-preview', src: imageUrl, alt: displayName(world), loading: 'lazy' }) : element('div', { className: 'setup-world-emblem' }, [icon(() => Globe)]),
        facts([['规则', rule ? displayName(rule) : referenceLabel(world.ruleset)], ['规则版本', world.ruleset?.version], ['场景', world.sceneCount ?? world.scenes?.length ?? 0], ['更新于', formatDate(world.updatedAt)], ['恢复点', backups.length]]),
        button(state[1] === 'active' ? '进入游戏' : '启动世界', () => launch(worldId(world)), { primary: true, symbol: () => Play, disabled: state[1] === 'warning' }),
        button('建立恢复点', () => request('worlds/backup', { method: 'POST', body: { worldId: worldId(world) } }), { symbol: () => History }),
        ...(backups.length ? [button('查看恢复点', () => { backupWorldId = worldId(world); render(); switchView('backups'); }, { local: true, symbol: () => History })] : []),
        ...(world.missingDependencies?.length ? [element('p', { className: 'setup-warning', text: `缺少内容：${world.missingDependencies.map(referenceLabel).join('、')}` })] : []),
        element('details', { className: 'setup-technical' }, [element('summary', { text: '技术信息' }), facts([['World ID', worldId(world)], ['规则引用', referenceLabel(world.ruleset)]])]),
      );
      if (catalog.activeWorldId === worldId(world)) appendConnection(detail, true);
    }
    for (const world of worlds) {
      const state = worldState(world), imageUrl = previewFor(world);
      const selectButton = element('button', { type: 'button', className: 'setup-world-select', 'aria-label': `查看 ${displayName(world)}`, onclick: () => select(world) }, [
        imageUrl ? element('img', { className: 'setup-world-thumb', src: imageUrl, alt: '', loading: 'lazy' }) : element('span', { className: 'setup-world-thumb is-placeholder' }, [icon(() => Globe)]),
        element('div', { className: 'setup-row-copy' }, [element('h3', { text: displayName(world) }), element('p', { text: `${referenceLabel(world.ruleset)} · ${world.sceneCount ?? world.scenes?.length ?? 0} 个场景` }), element('small', { text: `更新于 ${formatDate(world.updatedAt)}` })]),
      ]);
      const node = element('article', { className: 'setup-world-row' }, [selectButton, stateBadge(...state), button(state[1] === 'active' ? '进入游戏' : '启动', () => launch(worldId(world)), { primary: state[1] === 'active', disabled: state[1] === 'warning', symbol: () => Play })]);
      rows.push({ node, id: worldId(world), select: selectButton, text: `${displayName(world)} ${referenceLabel(world.ruleset)}`.toLocaleLowerCase() }); list.append(node);
    }
    const query = search('搜索世界名称或规则', value => {
      let found = 0;
      for (const row of rows) { row.node.hidden = !row.text.includes(value); if (!row.node.hidden) found++; }
      noResults.hidden = found !== 0 || worlds.length === 0;
    });
    const main = element('div', { className: 'setup-list-column' }, [query, list, noResults]);
    if (!worlds.length) main.append(empty('还没有世界', (catalog.maps || []).length ? '尚未创建游戏存档。' : '尚未安装地图包。', () => Globe));
    body.append(element('div', { className: 'setup-master-detail' }, [main, detail]));
    if (worlds.length) select(worlds.find(world => worldId(world) === selectedWorldId) || worlds[0]); else detail.hidden = true;
  }

  function renderMaps() {
    const maps = catalog.maps || [];
    const body = page('maps', '地图库', maps.length, [button('导入地图', () => importFile('map'), { primary: true, symbol: () => Upload })]);
    const grid = element('div', { className: 'setup-map-grid' }), rows = [];
    for (const item of maps) {
      const media = item.previewUrl ? element('img', { className: 'setup-map-preview', src: item.previewUrl, alt: displayName(item), loading: 'lazy' }) : element('div', { className: 'setup-map-placeholder' }, [icon(() => MapIcon), element('span', { text: '暂无预览' })]);
      const row = element('article', { className: 'setup-map-card' }, [media, element('div', { className: 'setup-map-copy' }, [
        element('h3', { text: displayName(item) }), element('div', { className: 'setup-map-meta' }, [element('span', { text: item.version }), stateBadge('已安装', 'active')]),
        element('div', { className: 'setup-map-footer' }, [element('code', { text: item.id }), button('卸载', async () => {
          if (!confirm(`卸载地图“${displayName(item)} ${item.version}”？引用中的内容不能卸载。`)) return { canceled: true };
          return request(`maps?id=${encodeURIComponent(item.id)}&version=${encodeURIComponent(item.version)}`, { method: 'DELETE' });
        }, { danger: true, symbol: () => Trash2 })]),
      ])]);
      rows.push({ node: row, text: `${displayName(item)} ${referenceLabel(item)}`.toLocaleLowerCase() }); grid.append(row);
    }
    const noResults = empty('没有匹配的地图'); noResults.hidden = true;
    body.append(search('搜索地图名称或版本', value => {
      let found = 0; rows.forEach(row => { row.node.hidden = !row.text.includes(value); if (!row.node.hidden) found++; }); noResults.hidden = found !== 0 || !maps.length;
    }), grid, noResults);
    if (!maps.length) body.append(empty('尚未安装地图', '.rpgmap', () => MapIcon));
  }

  function renderRules() {
    const rulesets = catalog.rulesets || [];
    const body = page('rulesets', '规则包', rulesets.length, [button('导入规则', () => importFile('ruleset'), { primary: true, symbol: () => Upload })]);
    const list = element('div', { className: 'setup-package-list' }), rows = [];
    for (const item of rulesets) {
      const worlds = (catalog.worlds || []).filter(world => world.ruleset?.id === item.id && world.ruleset?.version === item.version);
      const row = element('article', { className: 'setup-package-row' }, [
        element('span', { className: 'setup-package-icon' }, [icon(() => BookOpen)]),
        element('div', { className: 'setup-row-copy' }, [element('h3', { text: displayName(item) }), element('p', { text: referenceLabel(item) }), ...(worlds.length ? [element('small', { text: worlds.map(displayName).join('、') })] : [])]),
        element('span', { className: 'setup-package-usage', text: `${worlds.length} 个世界使用` }), stateBadge(item.builtIn ? '随程序预置' : '本地安装', item.builtIn ? 'active' : 'idle'),
        ...(item.builtIn ? [] : [button('卸载', async () => {
          if (!confirm(`卸载规则“${displayName(item)} ${item.version}”？被 World 或恢复点引用的规则不能卸载。`)) return { canceled: true };
          return request(`rulesets?id=${encodeURIComponent(item.id)}&version=${encodeURIComponent(item.version)}`, { method: 'DELETE' });
        }, { danger: true, symbol: () => Trash2 })]),
      ]);
      rows.push({ node: row, text: `${displayName(item)} ${referenceLabel(item)}`.toLocaleLowerCase() }); list.append(row);
    }
    const noResults = empty('没有匹配的规则包'); noResults.hidden = true;
    body.append(search('搜索规则包名称或版本', value => {
      let found = 0; rows.forEach(row => { row.node.hidden = !row.text.includes(value); if (!row.node.hidden) found++; }); noResults.hidden = found !== 0 || !rulesets.length;
    }), list, noResults, element('div', { className: 'setup-security-notice' }, [icon(() => ShieldCheck), element('p', { text: '规则包包含可执行代码，仅安装可信来源。' })]));
    if (!rulesets.length) body.append(empty('尚未安装规则包', '.rpgrules', () => BookOpen));
  }

  function renderBackups() {
    const worlds = catalog.worlds || [];
    if (!worlds.some(world => worldId(world) === backupWorldId)) backupWorldId = selectedWorldId || (worlds[0] && worldId(worlds[0]));
    const body = page('backups', '恢复点', undefined, [button('建立恢复点', () => request('worlds/backup', { method: 'POST', body: { worldId: backupWorldId } }), { primary: true, disabled: !worlds.length, symbol: () => Plus })]);
    const worldSelect = element('select', { 'aria-label': '恢复点所属世界', onchange: () => { backupWorldId = worldSelect.value; render(); } });
    worlds.forEach(world => worldSelect.append(element('option', { value: worldId(world), text: displayName(world) })));
    worldSelect.value = backupWorldId || '';
    body.append(element('div', { className: 'setup-filter-bar' }, [field('世界', worldSelect)]));
    const selectedWorld = worlds.find(world => worldId(world) === backupWorldId);
    const backups = selectedWorld ? [...backupsFor(selectedWorld)].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) : [];
    if (!backups.length) { body.append(empty('暂无恢复点', selectedWorld ? displayName(selectedWorld) : '尚未创建世界', () => History)); return; }
    const detail = element('aside', { className: 'setup-detail', 'aria-label': '恢复点详情' }), list = element('div', { className: 'setup-backup-list' }), rows = [];
    const reasons = { manual: '手动恢复点', import: '导入前备份', restore: '恢复前备份', auto: '自动恢复点' };
    const title = item => item.name || reasons[item.reason] || item.reason || '世界恢复点';
    function select(item) {
      const id = item.id || item.backupId;
      rows.forEach(row => row.node.setAttribute('aria-pressed', String(row.id === id)));
      detail.replaceChildren(element('h2', { text: title(item) }), facts([['世界', displayName(selectedWorld)], ['创建于', formatDate(item.createdAt)], ['恢复点 ID', id]]),
        element('p', { className: 'setup-restore-notice', text: '恢复将替换当前世界状态，操作前会保存当前状态。' }),
        button('恢复此记录', async () => {
          if (!confirm(`将用恢复点替换“${displayName(selectedWorld)}”的当前状态。操作前会保存当前状态。继续恢复？`)) return { canceled: true };
          return request('worlds/restore', { method: 'POST', body: { worldId: worldId(selectedWorld), backupId: id } });
        }, { primary: true, symbol: () => History }));
    }
    backups.forEach(item => {
      const node = element('button', { type: 'button', className: 'setup-backup-row', onclick: () => select(item) }, [icon(() => History), element('span', { text: title(item) }), element('time', { text: formatDate(item.createdAt) })]);
      rows.push({ node, id: item.id || item.backupId }); list.append(node);
    });
    body.append(element('div', { className: 'setup-master-detail' }, [list, detail])); select(backups[0]);
  }

  function appendConnection(parent, compact = false) {
    const connection = catalog.connection || {}, urls = connection.playerUrls || connection.networkUrls || connection.lanUrls || [];
    if (!urls.length && !connection.joinCode) return;
    const section = element('section', { className: `setup-connection${compact ? ' is-compact' : ''}` }, [element('h3', { text: '玩家加入' })]);
    const copy = async value => {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('当前环境不支持复制，请选择地址手动复制。');
      await globalThis.navigator.clipboard.writeText(value);
    };
    for (const item of urls) {
      const url = typeof item === 'string' ? item : item.url;
      if (url) section.append(element('div', { className: 'setup-copy-row' }, [element('code', { text: url }), button('', () => copy(url), { symbol: () => Copy, title: '复制玩家加入地址' })]));
    }
    if (connection.joinCode) section.append(element('div', { className: 'setup-copy-row' }, [element('span', { text: `加入码：${connection.joinCode}` }), button('', () => copy(connection.joinCode), { symbol: () => Copy, title: '复制加入码' })]));
    parent.append(section);
  }

  function renderSettings() {
    const connection = catalog.connection || {};
    const body = page('settings', '运行设置', undefined, [button('刷新列表', refresh, { symbol: () => RefreshCw })]);
    function group(title, children) { body.append(element('section', { className: 'setup-settings-group' }, [element('h2', { text: title }), element('div', { className: 'setup-settings-body' }, children)])); }
    const network = element('div'); appendConnection(network);
    const portInput = element('input', { type: 'number', min: 1024, max: 65535, value: connection.port || location.port || 30000, 'aria-label': '服务端口' });
    const portForm = element('form', { className: 'setup-port-form', onsubmit: event => {
      event.preventDefault();
      const port = Number(portInput.value);
      return action(async () => {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须是 1024–65535 的整数。');
        if (!confirm('修改端口会正常停服并重启服务，已连接的玩家需要使用新地址加入。继续？')) return { canceled: true };
        if (desktop) return desktop.setPort(port);
        return request('settings', { method: 'POST', body: { port } });
      }, result => result?.restartRequired ? '端口已保存。请重新启动服务器，并使用新的加入地址。' : '端口已保存。');
    } }, [field('服务端口', portInput), element('button', { type: 'submit', className: 'setup-button', text: '保存端口并重启' })]);
    group('网络与连接', [network, portForm]);
    const dataPath = catalog.dataDirectory || connection.dataDirectory;
    group('用户数据', [...(dataPath ? [facts([['数据目录', dataPath]])] : []), element('div', { className: 'setup-actions' }, [
      button('导入旧版存档', () => importFile('world'), { symbol: () => Upload }),
      ...(desktop ? [button('打开用户数据目录', () => desktop.openDataDirectory(), { symbol: () => FolderOpen }), button('导入旧版数据目录', () => desktop.importLegacyDirectory(), { symbol: () => Upload })] : []),
    ])]);
    group('程序', [facts([['版本', catalog.appVersion || catalog.version || connection.version || '3.0.0']]), ...(desktop ? [element('div', { className: 'setup-actions' }, [
      button('在浏览器打开游戏', () => desktop.openGameInBrowser(), { disabled: !catalog.activeWorldId, symbol: () => ExternalLink }),
      button('运行新版安装器', () => desktop.installUpdate(), { symbol: () => Download }), button('保存并退出', () => desktop.exit(), { symbol: () => Check }),
    ])] : [])]);
  }

  function render() {
    content.replaceChildren(); panels.clear();
    renderWorlds(); renderMaps(); renderRules(); renderBackups(); renderSettings();
    version.textContent = `v${catalog.appVersion || catalog.version || catalog.connection?.version || '3.0.0'}`.replace(/^vv/, 'v');
    const activeWorld = (catalog.worlds || []).find(world => worldId(world) === catalog.activeWorldId);
    activeLabel.textContent = activeWorld ? displayName(activeWorld) : '世界管理'; switchView(activeView);
  }
  async function refresh() { catalog = await request('catalog'); render(); return catalog; }

  for (const [id, label, symbol] of views) {
    const node = element('button', { type: 'button', className: 'setup-nav-item', onclick: () => switchView(id) }, [icon(symbol), element('span', { text: label })]);
    navButtons.set(id, node); nav.append(node);
  }
  container.className = 'rpgmap-setup';
  container.replaceChildren(
    element('header', { className: 'setup-header' }, [element('div', { className: 'setup-brand' }, [icon(() => Boxes), element('strong', { text: 'RPGmap' })]), activeLabel, element('span', { className: 'setup-host-label', text: desktop ? '桌面管理' : '主持人管理' })]),
    element('div', { className: 'setup-workspace setup-page' }, [element('aside', { className: 'setup-sidebar' }, [nav]), content]),
    element('footer', { className: 'setup-footer' }, [status, version]),
  );
  try { await refresh(); notify('服务已连接'); }
  catch (error) { notify(`${error.message} 请从桌面启动器进入管理首页，或使用 GM 身份。`, true); }
  return { refresh };
}
