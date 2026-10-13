import './desktop-setup.css';

const displayName = item => item?.name || item?.title || item?.manifest?.name || item?.id || '未命名';
const referenceLabel = reference => reference ? `${reference.id}@${reference.version}` : '未指定';
const ref = item => ({ id: item.id, version: item.version });
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

export async function startDesktopSetup({ container = document.getElementById('app'), fetchImpl = globalThis.fetch, desktop = globalThis.rpgmapDesktop } = {}) {
  if (!container) throw new Error('缺少管理首页容器。');
  document.title = 'RPGmap · 管理首页';
  let catalog = null;
  let busy = false;
  const status = element('p', { className: 'setup-status', role: 'status', 'aria-live': 'polite', text: '正在读取地图、规则与 World…' });
  const content = element('div', { className: 'setup-content' });

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

  function notify(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
  }

  async function action(work, message = '操作已完成。') {
    if (busy) return;
    busy = true;
    container.dataset.busy = 'true';
    notify('正在处理，请稍候…');
    try {
      const result = await work();
      if (result?.canceled) { notify('已取消。'); return; }
      await refresh();
      notify(typeof message === 'function' ? message(result) : message);
    } catch (error) {
      notify(error.message || '操作失败。', true);
    } finally {
      busy = false;
      container.dataset.busy = 'false';
    }
  }

  function button(text, work, { primary = false, danger = false, disabled = false } = {}) {
    const node = element('button', { type: 'button', className: `setup-button${primary ? ' is-primary' : ''}${danger ? ' is-danger' : ''}`, text, onclick: () => action(work) });
    node.disabled = disabled;
    return node;
  }

  async function importFile(kind) {
    if (desktop) return kind === 'world' ? desktop.importWorld() : desktop.importPackage(kind);
    const spec = {
      map: { accept: '.rpgmap', endpoint: 'maps' },
      ruleset: { accept: '.rpgrules', endpoint: 'rulesets' },
      world: { accept: '.json', endpoint: 'worlds/import' },
    }[kind];
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
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': kind === 'world' ? 'application/json' : 'application/octet-stream' },
            body: bytes,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(managementError(result, response.status));
          resolve(result);
        } catch (error) { reject(error); }
      }, { once: true });
      input.click();
    });
  }

  function section(title, hint, toolbar = []) {
    const body = element('div', { className: 'setup-section-body' });
    const node = element('section', { className: 'setup-section' }, [
      element('div', { className: 'setup-section-heading' }, [
        element('div', {}, [element('h2', { text: title }), element('p', { text: hint })]),
        element('div', { className: 'setup-actions' }, toolbar),
      ]), body,
    ]);
    return { node, body };
  }

  function optionSelect(items, { placeholder = '请选择', required = true } = {}) {
    const select = element('select', { required });
    select.append(element('option', { value: '', text: placeholder }));
    items.forEach((item, index) => select.append(element('option', { value: index, text: `${displayName(item)} · ${item.version}` })));
    return select;
  }

  async function launch(worldId) {
    if (desktop) return desktop.launchWorld(worldId);
    const result = await request('worlds/activate', { method: 'POST', body: { worldId } });
    const updated = await request('catalog');
    const target = result.connection?.hostUrl || result.connection?.localUrl || updated.connection?.hostUrl || updated.connection?.localUrl || '/';
    const url = new URL(target, location.origin);
    if (url.origin !== location.origin) throw new Error('服务器返回了不同来源的游戏地址。');
    location.assign(url.href);
    return result;
  }

  function render() {
    content.replaceChildren();
    const maps = catalog.maps || [];
    const rulesets = catalog.rulesets || [];
    const worlds = catalog.worlds || [];

    const worldSection = section('World', '一场游戏共享规则和角色，每张地图作为一个独立场景。', [
      button('导入旧版存档', () => importFile('world')),
      ...(desktop ? [button('导入旧版数据目录', () => desktop.importLegacyDirectory())] : []),
    ]);
    const name = element('input', { type: 'text', placeholder: '新游戏名称', maxlength: '80', required: true, 'aria-label': 'World 名称' });
    const ruleSelect = optionSelect(rulesets, { placeholder: '选择规则' });
    ruleSelect.setAttribute('aria-label', 'World 规则');
    const mapSelect = optionSelect(maps, { placeholder: '选择起始地图' });
    mapSelect.setAttribute('aria-label', '起始地图');
    const create = element('button', { type: 'submit', className: 'setup-button is-primary', text: '创建 World' });
    create.disabled = maps.length === 0 || rulesets.length === 0;
    const form = element('form', { className: 'setup-create-world', onsubmit: event => {
      event.preventDefault();
      action(async () => {
        const selectedRule = rulesets[Number(ruleSelect.value)];
        const selectedMap = maps[Number(mapSelect.value)];
        if (!selectedRule || !selectedMap || !name.value.trim()) throw new Error('请填写名称，并选择规则与地图。');
        return request('worlds', { method: 'POST', body: { name: name.value.trim(), ruleset: ref(selectedRule), mapPackage: ref(selectedMap) } });
      }, 'World 已创建，可以开始游戏。');
    } }, [name, ruleSelect, mapSelect, create]);
    worldSection.body.append(form);
    if (!worlds.length) worldSection.body.append(element('p', { className: 'setup-empty', text: maps.length ? '还没有 World。选择已安装地图创建第一场游戏。' : '请先导入地图包，再创建第一场游戏。' }));
    for (const world of worlds) {
      const id = world.id || world.worldId;
      const backups = world.backups || (catalog.backups || []).filter(item => item.worldId === id);
      const controls = [
        button(catalog.activeWorldId === id ? '进入游戏' : '启动', () => launch(id), { primary: true, disabled: Boolean(world.unavailable || world.missingDependencies?.length) }),
        button('建立恢复点', () => request('worlds/backup', { method: 'POST', body: { worldId: id } })),
      ];
      if (backups.length) {
        const backupSelect = optionSelect(backups.map(item => ({ ...item, name: item.name || item.createdAt || item.id || item.backupId, version: '' })), { placeholder: '选择恢复点', required: false });
        controls.push(backupSelect, button('恢复', async () => {
          if (backupSelect.value === '') throw new Error('请先选择恢复点。');
          const selected = backups[Number(backupSelect.value)];
          if (!confirm(`将用恢复点替换“${displayName(world)}”的当前状态。操作前会保存当前状态。继续恢复？`)) return { canceled: true };
          return request('worlds/restore', { method: 'POST', body: { worldId: id, backupId: selected.id || selected.backupId } });
        }, { danger: true }));
      }
      const details = `${referenceLabel(world.ruleset)} · ${world.sceneCount ?? world.scenes?.length ?? 1} 个场景`;
      const row = element('article', { className: 'setup-row' }, [
        element('div', { className: 'setup-row-copy' }, [element('h3', { text: displayName(world) }), element('p', { text: details })]),
        element('div', { className: 'setup-actions' }, controls),
      ]);
      if (world.missingDependencies?.length) row.append(element('p', { className: 'setup-warning', text: `缺少内容：${world.missingDependencies.map(referenceLabel).join('、')}` }));
      worldSection.body.append(row);
    }
    content.append(worldSection.node);

    const mapSection = section('地图', '导入 .rpgmap；多个版本可以并存，卸载会检查存档及恢复点引用。', [button('导入地图 / 随附兰州地图', () => importFile('map'), { primary: true })]);
    if (!maps.length) mapSection.body.append(element('p', { className: 'setup-empty', text: '地图列表为空。安装器与地图分别提供，请选择交付目录中的地图包。' }));
    for (const item of maps) {
      const preview = item.previewUrl ? element('img', { className: 'setup-map-preview', src: item.previewUrl, alt: '', loading: 'lazy' }) : null;
      const info = element('div', { className: 'setup-row-copy' }, [
        element('h3', { text: displayName(item) }),
        element('p', { text: referenceLabel(item) }),
      ]);
      mapSection.body.append(element('article', { className: 'setup-row' }, [
        ...(preview ? [preview] : []), info,
        button('卸载', async () => {
          if (!confirm(`卸载地图“${displayName(item)} ${item.version}”？引用中的内容不能卸载。`)) return { canceled: true };
          return request(`maps?id=${encodeURIComponent(item.id)}&version=${encodeURIComponent(item.version)}`, { method: 'DELETE' });
        }, { danger: true }),
      ]));
    }
    content.append(mapSection.node);

    const ruleSection = section('规则', 'World 固定规则版本。仅导入受信任的 RPGmap 契约包。', [button('导入规则', () => importFile('ruleset'))]);
    for (const item of rulesets) {
      const controls = item.builtIn ? [] : [button('卸载', async () => {
        if (!confirm(`卸载规则“${displayName(item)} ${item.version}”？被 World 或恢复点引用的规则不能卸载。`)) return { canceled: true };
        return request(`rulesets?id=${encodeURIComponent(item.id)}&version=${encodeURIComponent(item.version)}`, { method: 'DELETE' });
      }, { danger: true })];
      ruleSection.body.append(element('article', { className: 'setup-row' }, [
        element('div', { className: 'setup-row-copy' }, [
          element('h3', { text: displayName(item) }),
          element('p', { text: `${referenceLabel(item)}${item.builtIn ? ' · 随程序预置' : ''}` }),
        ]), ...controls,
      ]));
    }
    if (!rulesets.length) ruleSection.body.append(element('p', { className: 'setup-empty', text: '没有可用规则，请导入规则包。' }));
    content.append(ruleSection.node);

    const connection = catalog.connection || {};
    const urls = connection.playerUrls || connection.networkUrls || connection.lanUrls || [];
    const settings = section('运行与数据', '程序文件与 World、内容包、上传和备份分别存放。');
    settings.body.append(element('p', { text: `服务端口：${connection.port || new URL(location.href).port || '默认'} · 程序版本：${catalog.appVersion || catalog.version || connection.version || 'v3.0.0'}` }));
    if (catalog.dataDirectory || connection.dataDirectory) settings.body.append(element('p', { className: 'setup-data-path', text: `数据目录：${catalog.dataDirectory || connection.dataDirectory}` }));
    if (urls.length) settings.body.append(element('div', { className: 'setup-connection' }, [
      element('h3', { text: '玩家加入地址' }),
      ...urls.map(url => element('code', { text: typeof url === 'string' ? url : url.url })),
      ...(connection.joinCode ? [element('p', { text: `加入码：${connection.joinCode}` })] : []),
    ]));
    const settingsButtons = [button('刷新列表', refresh)];
    if (desktop) settingsButtons.push(button('打开用户数据目录', () => desktop.openDataDirectory()), button('在浏览器打开游戏', () => desktop.openGameInBrowser(), { disabled: !catalog.activeWorldId }), button('运行新版安装器', () => desktop.installUpdate()), button('保存并退出', () => desktop.exit()));
    settings.body.append(element('div', { className: 'setup-actions' }, settingsButtons));
    const portInput = element('input', { type: 'number', min: '1024', max: '65535', value: connection.port || location.port || 30000, 'aria-label': '服务端口' });
    const portForm = element('form', { className: 'setup-actions', onsubmit: event => {
      event.preventDefault();
      const port = Number(portInput.value);
      action(async () => {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须是 1024–65535 的整数。');
        if (!confirm('修改端口会正常停服并重启服务，已连接的玩家需要使用新地址加入。继续？')) return { canceled: true };
        if (desktop) return desktop.setPort(port);
        const result = await request('settings', { method: 'POST', body: { port } });
        if (result.restartRequired) notify('端口已保存。请重新启动服务器，并使用新的加入地址。');
        return result;
      }, '端口已保存。');
    } }, [element('label', { text: '服务端口：' }), portInput, element('button', { type: 'submit', className: 'setup-button', text: '保存端口并重启' })]);
    portForm.style.marginTop = '16px';
    settings.body.append(portForm);
    settings.body.append(element('p', { className: 'setup-help', text: '更新程序：退出 RPGmap 后运行新版本安装器覆盖安装。用户数据及已安装内容包会保留。' }));
    content.append(settings.node);
  }

  async function refresh() {
    catalog = await request('catalog');
    render();
    return catalog;
  }

  container.className = 'rpgmap-setup';
  container.replaceChildren(element('main', { className: 'setup-page' }, [
    element('header', { className: 'setup-page-heading' }, [
      element('div', {}, [element('p', { className: 'setup-eyebrow', text: 'RPGmap' }), element('h1', { text: '管理首页' }), element('p', { text: '选择游戏，准备地图和规则，然后开始。' })]),
      element('span', { className: 'setup-version', text: '3.0' }),
    ]), status, content,
  ]));
  try {
    await refresh();
    notify('已就绪。');
  } catch (error) {
    notify(`${error.message} 请从桌面启动器进入管理首页，或使用 GM 身份。`, true);
  }
  return { refresh };
}
