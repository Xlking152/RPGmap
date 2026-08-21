const qs = new URLSearchParams(location.search);
const queryToken = qs.get('token') || '';
if (queryToken) localStorage.setItem('rpgmap:launcher-token', queryToken);
const token = queryToken || localStorage.getItem('rpgmap:launcher-token') || '';
let state = null;
let secretVisible = false;
let polling = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'X-RPGMAP-Launcher-Token': token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data;
}

function copyText(text) {
  if (!text) return toast('当前没有可复制的信息', true);
  navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => toast('复制失败', true));
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value || '—';
}

function actorOptions(selected = '', ownership = null, ownerOnly = false) {
  const actors = state?.admin?.access?.actors || [];
  const filtered = ownerOnly ? actors.filter(actor => ownership?.[actor.id] === 'owner') : actors;
  return `<option value="">未分配</option>${filtered.map(actor => `<option value="${escapeHtml(actor.id)}" ${String(actor.id) === String(selected || '') ? 'selected' : ''}>${escapeHtml(actor.name)}</option>`).join('')}`;
}

function renderPending() {
  const root = $('#pending-users');
  const pending = state?.admin?.access?.pending || [];
  if (!state?.running) {
    root.className = 'stack empty';
    root.textContent = '服务器启动后显示';
    return;
  }
  if (!pending.length) {
    root.className = 'stack empty';
    root.textContent = '当前没有待批准玩家';
    return;
  }
  root.className = 'stack';
  root.innerHTML = pending.map(item => `<form class="pending-card" data-pending-id="${escapeHtml(item.id)}">
    <div class="user-head"><span class="online-dot on"></span><strong>${escapeHtml(item.name)}</strong><span class="muted">首次申请</span></div>
    <div class="user-grid"><input name="name" maxlength="40" value="${escapeHtml(item.name)}"><select name="defaultActorId">${actorOptions()}</select></div>
    <div class="user-actions"><button class="primary" type="submit">批准并绑定</button></div>
  </form>`).join('');
}

function renderUsers() {
  const root = $('#users');
  const users = state?.admin?.access?.users || [];
  const actors = state?.admin?.access?.actors || [];
  if (!state?.running) {
    root.className = 'stack empty';
    root.textContent = '服务器启动后显示';
    return;
  }
  if (!users.length) {
    root.className = 'stack empty';
    root.textContent = '还没有正式 Player User';
    return;
  }
  root.className = 'stack';
  root.innerHTML = users.map(user => `<form class="user-card" data-user-id="${escapeHtml(user.id)}">
    <div class="user-head"><span class="online-dot ${user.online ? 'on' : ''}"></span><strong>${escapeHtml(user.name)}</strong><span class="muted">${user.online ? '在线' : '离线'}${user.disabled ? ' · 已禁用' : ''}</span></div>
    <div class="user-grid"><input name="name" maxlength="40" value="${escapeHtml(user.name)}"><select name="defaultActorId">${actorOptions(user.defaultActorId)}</select></div>
    <div class="ownership-grid">${actors.length ? actors.map(actor => {
      const level = user.ownership?.[actor.id] || 'none';
      return `<span>${escapeHtml(actor.name)}</span><select data-actor-id="${escapeHtml(actor.id)}"><option value="none" ${level === 'none' ? 'selected' : ''}>NONE</option><option value="observer" ${level === 'observer' ? 'selected' : ''}>OBSERVER</option><option value="owner" ${level === 'owner' ? 'selected' : ''}>OWNER</option></select>`;
    }).join('') : '<span class="muted">World 中暂无 Actor</span>'}</div>
    <div class="user-actions"><button type="button" data-reset-key="${escapeHtml(user.id)}">重发 Player Key</button><button type="button" class="danger" data-delete-user="${escapeHtml(user.id)}">删除 User</button><button class="primary" type="submit">保存权限</button></div>
  </form>`).join('');
}

function renderCreateForm() {
  $('#create-default').innerHTML = `<option value="">默认角色：未分配</option>${(state?.admin?.access?.actors || []).map(actor => `<option value="${escapeHtml(actor.id)}">${escapeHtml(actor.name)}</option>`).join('')}`;
}

function render() {
  if (!state) return;
  setText('version', `V${state.version}`);
  setText('build', state.build);
  setText('local-url', state.server?.localUrl);
  setText('lan-url', state.server?.lanUrls?.[0]);
  setText('public-url', state.server?.publicUrl);
  setText('join-code', state.server?.joinCode || '—— ——');
  $('#invite-text').value = state.inviteText || '';
  $('#gm-secret').dataset.secret = state.server?.gmSecret || '';
  $('#gm-secret').textContent = secretVisible && state.server?.gmSecret ? state.server.gmSecret : '••••••••••••••••';
  setText('world-path', state.storage?.world);
  setText('maps-path', state.storage?.maps);

  const pill = $('#status-pill');
  pill.classList.toggle('online', state.running);
  pill.classList.toggle('starting', state.starting);
  pill.querySelector('b').textContent = state.starting ? '启动中…' : state.running ? '已运行' : '未启动';
  const mode = state.starting ? 'STARTING' : state.mode === 'internet' ? 'INTERNET' : state.mode === 'local' ? 'LOCAL / LAN' : 'STOPPED';
  $('#mode-badge').textContent = mode;

  renderPending();
  renderUsers();
  renderCreateForm();
  if (state.lastError) toast(state.lastError, true);
}

async function refresh() {
  try {
    state = await api('/api/status');
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

async function refreshLogs() {
  try {
    const data = await api('/api/logs');
    const node = $('#logs');
    node.textContent = (data.lines || []).join('\n') || '暂无日志';
    node.scrollTop = node.scrollHeight;
  } catch (error) {
    toast(error.message, true);
  }
}

function ownershipFromForm(form) {
  const result = {};
  for (const select of form.querySelectorAll('[data-actor-id]')) {
    if (select.value !== 'none') result[select.dataset.actorId] = select.value;
  }
  const defaultActorId = String(new FormData(form).get('defaultActorId') || '');
  if (defaultActorId) result[defaultActorId] = 'owner';
  return result;
}

function showPlayerKey(label, playerKey) {
  const box = $('#key-result');
  box.hidden = false;
  box.innerHTML = `<b>${escapeHtml(label)}</b><br>Player Key 只应私下发送给对应玩家。<code>${escapeHtml(playerKey)}</code><button class="mini" data-copy-key="${escapeHtml(playerKey)}">复制 Player Key</button>`;
}

async function post(path, body = {}) {
  const result = await api(path, { method: 'POST', body });
  await refresh();
  return result;
}

addEventListener('click', async event => {
  const action = event.target.closest?.('[data-action]')?.dataset.action;
  const copy = event.target.closest?.('[data-copy]')?.dataset.copy;
  if (copy) return copyText(document.getElementById(copy)?.textContent?.trim());
  const copyKey = event.target.closest?.('[data-copy-key]')?.dataset.copyKey;
  if (copyKey) return copyText(copyKey);

  const resetId = event.target.closest?.('[data-reset-key]')?.dataset.resetKey;
  if (resetId) {
    try {
      const result = await post('/api/admin/reset-key', { userId: resetId });
      showPlayerKey(`已为 ${result.user?.name || 'Player'} 重新签发`, result.playerKey);
    } catch (error) { toast(error.message, true); }
    return;
  }
  const deleteId = event.target.closest?.('[data-delete-user]')?.dataset.deleteUser;
  if (deleteId) {
    if (!confirm('删除这个 Player User？已保存的 Player 身份将失效。')) return;
    try { await post('/api/admin/delete-user', { userId: deleteId }); toast('User 已删除'); } catch (error) { toast(error.message, true); }
    return;
  }
  if (!action) return;

  try {
    if (action === 'start-local') {
      toast('正在启动本机 / 局域网模式…');
      state = await api('/api/start', { method: 'POST', body: { mode: 'local' } });
      render();
    } else if (action === 'start-internet') {
      toast('正在建立互联网联机，首次使用可能需要下载 cloudflared…');
      state = await api('/api/start', { method: 'POST', body: { mode: 'internet' } });
      render();
    } else if (action === 'stop') {
      state = await api('/api/stop', { method: 'POST', body: {} });
      render();
      toast('服务器已停止');
    } else if (action === 'open-game') {
      await api('/api/open-game', { method: 'POST', body: {} });
    } else if (action === 'copy-invite') {
      copyText(state?.inviteText || '');
    } else if (action === 'toggle-secret') {
      secretVisible = !secretVisible;
      render();
    } else if (action === 'copy-secret') {
      copyText(state?.server?.gmSecret || '');
    } else if (action === 'refresh-admin') {
      await post('/api/admin/refresh', {});
      toast('User / Ownership 已刷新');
    } else if (action === 'refresh-logs') {
      await refreshLogs();
    } else if (action === 'shutdown') {
      if (!confirm('关闭 Launcher？正在运行的 RPGmap Server 和 Tunnel 也会一并停止。')) return;
      await api('/api/shutdown', { method: 'POST', body: {} });
      document.body.innerHTML = '<main class="shell"><article class="card"><h2>RPGmap Launcher 已关闭</h2><p>可以关闭此页面。</p></article></main>';
    }
  } catch (error) {
    toast(error.message, true);
    await refresh();
  }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  event.preventDefault();
  try {
    if (form.id === 'create-user') {
      const data = new FormData(form);
      const defaultActorId = String(data.get('defaultActorId') || '');
      const result = await post('/api/admin/create-user', {
        name: String(data.get('name') || ''),
        defaultActorId,
        ownership: defaultActorId ? { [defaultActorId]: 'owner' } : {},
      });
      showPlayerKey(`已创建 ${result.user?.name || 'Player'}`, result.playerKey);
      form.reset();
      return;
    }

    if (form.matches('[data-pending-id]')) {
      const data = new FormData(form);
      const defaultActorId = String(data.get('defaultActorId') || '');
      await post('/api/admin/approve', {
        sessionId: form.dataset.pendingId,
        name: String(data.get('name') || ''),
        defaultActorId,
        ownership: defaultActorId ? { [defaultActorId]: 'owner' } : {},
      });
      toast('Player 已批准并绑定');
      return;
    }

    if (form.matches('[data-user-id]')) {
      const data = new FormData(form);
      await post('/api/admin/update-user', {
        userId: form.dataset.userId,
        name: String(data.get('name') || ''),
        defaultActorId: String(data.get('defaultActorId') || ''),
        ownership: ownershipFromForm(form),
      });
      toast('User 权限已保存');
    }
  } catch (error) {
    toast(error.message, true);
  }
});

if (!token) {
  document.body.innerHTML = '<main class="shell"><article class="card"><h2>Launcher 授权信息缺失</h2><p>请通过“启动 RPGmap.bat”重新打开 Launcher。</p></article></main>';
} else {
  refresh();
  refreshLogs();
  polling = setInterval(() => { refresh(); refreshLogs(); }, 2000);
}
