import { isLocalHost, multiplayerSocketUrl, normalizeRequestedRole, sanitizeMultiplayerName } from './protocol.js';
import { actorIdForCharacter, canControlActor, validateLocalPlayerChange } from './permissions.js';

const STYLE_ID = 'rpgmap-multiplayer-style';
const STORAGE_PREFIX = 'rpgmap:multiplayer:';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .multiplayer-toolbar { position:relative; }
    .multiplayer-toolbar[data-state="online"] { border-color:#3d9b63 !important; }
    .multiplayer-toolbar[data-state="pending"] { border-color:#d99729 !important; }
    .multiplayer-toolbar[data-state="connecting"] { border-color:#d99729 !important; }
    .multiplayer-toolbar[data-state="offline"] { border-color:#b9c1bf !important; }
    .multiplayer-dot { width:7px; height:7px; border-radius:50%; display:inline-block; background:#a9b1af; margin-right:4px; }
    .multiplayer-toolbar[data-state="online"] .multiplayer-dot { background:#3d9b63; }
    .multiplayer-toolbar[data-state="pending"] .multiplayer-dot,.multiplayer-toolbar[data-state="connecting"] .multiplayer-dot { background:#d99729; }
    .multiplayer-backdrop { position:fixed; inset:0; z-index:5200; background:rgba(18,23,24,.52); display:grid; place-items:center; padding:18px; }
    .multiplayer-backdrop[hidden] { display:none !important; }
    .multiplayer-dialog { width:min(760px,96vw); max-height:92vh; overflow:auto; background:#f8faf7; border-radius:14px; border:1px solid rgba(40,70,70,.28); box-shadow:0 22px 70px rgba(0,0,0,.32); padding:18px; display:grid; gap:13px; }
    .multiplayer-dialog.login { width:min(460px,94vw); }
    .multiplayer-dialog h2,.multiplayer-dialog h3 { margin:0; }
    .multiplayer-dialog h2 { font-size:18px; }
    .multiplayer-dialog h3 { font-size:14px; color:#34484a; }
    .multiplayer-dialog p { margin:0; color:#647174; font-size:12px; line-height:1.55; }
    .multiplayer-fields { display:grid; gap:9px; }
    .multiplayer-grid-2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
    .multiplayer-field { display:grid; gap:5px; font-size:12px; color:#59676a; }
    .multiplayer-field input,.multiplayer-field select { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid #cbd5d2; border-radius:8px; background:white; font:inherit; }
    .multiplayer-actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
    .multiplayer-actions button,.multiplayer-mini-button { border:1px solid #b9c5c1; border-radius:8px; padding:8px 12px; background:#fff; cursor:pointer; font-weight:800; }
    .multiplayer-actions .primary,.multiplayer-mini-button.primary { border-color:#176d76; background:#176d76; color:white; }
    .multiplayer-mini-button { padding:5px 8px; font-size:11px; }
    .multiplayer-mini-button.danger { color:#a32d27; border-color:#d8aaa6; }
    .multiplayer-status-card { padding:9px 10px; border-radius:8px; background:#eef3ef; color:#526164; font-size:12px; line-height:1.5; }
    .multiplayer-status-card.warn { background:#fff1d8; color:#7b5721; }
    .multiplayer-status-card.key { background:#eaf3ff; border:1px solid #b7cee8; color:#264b70; }
    .multiplayer-key-value { display:block; margin-top:6px; font:800 16px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.8px; user-select:all; }
    .multiplayer-presence { display:flex; gap:5px; flex-wrap:wrap; }
    .multiplayer-chip { padding:3px 7px; border-radius:999px; background:#e3ebe6; color:#4f615d; font-size:10px; font-weight:800; }
    .multiplayer-chip.gm { background:#f1e7d8; color:#875b27; }
    .multiplayer-chip.offline { opacity:.55; }
    .multiplayer-section { border:1px solid rgba(60,80,80,.17); border-radius:10px; padding:11px; background:#fff; display:grid; gap:9px; }
    .multiplayer-user-card { border:1px solid #dce4e0; border-radius:9px; padding:9px; display:grid; gap:8px; background:#fbfcfb; }
    .multiplayer-user-head { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
    .multiplayer-user-head strong { flex:1; min-width:120px; }
    .multiplayer-online { width:8px; height:8px; border-radius:50%; background:#aab2b0; display:inline-block; }
    .multiplayer-online.on { background:#3d9b63; }
    .multiplayer-ownership { display:grid; grid-template-columns:minmax(120px,1fr) 150px; gap:5px 9px; align-items:center; font-size:11px; }
    .multiplayer-ownership select { width:100%; padding:5px 6px; border:1px solid #ccd7d2; border-radius:6px; background:#fff; }
    .multiplayer-muted { color:#7a8585; font-size:11px; }
    @media(max-width:650px){ .multiplayer-grid-2{grid-template-columns:1fr}.multiplayer-ownership{grid-template-columns:1fr 120px} }
  `;
  documentNode.head.append(style);
}

function parseMessage(event) {
  try { return JSON.parse(String(event.data)); } catch { return null; }
}

export function createMultiplayerController() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const toolbar = shell.querySelector?.('.toolbar-right');
      if (!toolbar) return;
      installStyles(documentNode);

      let socket = null;
      let connected = false;
      let joining = false;
      let applyingRemote = false;
      let revision = 0;
      let session = null;
      let permissions = { worldWrite: false, worldReset: false, manageAccess: false, combatManage: false, actorOwnerIds: [], actorObserverIds: [], defaultActorId: null };
      let clients = [];
      let access = { users: [], pending: [], actors: [], canManage: false, selfUserId: null };
      let inFlight = false;
      let pendingPush = false;
      let intentionalClose = false;
      let lastServerState = null;
      let submittedPlayerKey = '';
      let latestPlayerKey = '';
      let latestNotice = '';

      const button = documentNode.createElement('button');
      button.type = 'button';
      button.className = 'tool-button multiplayer-toolbar';
      button.dataset.state = 'offline';
      button.innerHTML = '<span class="multiplayer-dot"></span><span data-mp-label>联机</span>';
      button.title = '多人联机 / Users / Actor Ownership';
      toolbar.prepend(button);

      const overlay = documentNode.createElement('div');
      overlay.className = 'multiplayer-backdrop';
      overlay.hidden = true;
      overlay.style.display = 'none';
      documentNode.body.append(overlay);

      function defaultRole() { return isLocalHost(documentNode.defaultView?.location) ? 'gm' : 'player'; }
      function saved(key, fallback = '') {
        try { return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback; } catch { return fallback; }
      }
      function save(key, value) {
        try { localStorage.setItem(STORAGE_PREFIX + key, String(value)); } catch {}
      }
      function removeSaved(key) {
        try { localStorage.removeItem(STORAGE_PREFIX + key); } catch {}
      }
      function clearSavedIdentity() {
        removeSaved('userId');
        removeSaved('authToken');
        removeSaved('playerKey');
      }
      function actorName(actorId) {
        if (!actorId) return '未分配';
        return access.actors.find(actor => String(actor.id) === String(actorId))?.name || String(actorId);
      }
      function statusText() {
        if (!connected || !session) return joining ? '连接中…' : '联机';
        if (session.identityStatus === 'pending') return 'Player · 待批准';
        const online = clients.filter(item => item.identityStatus !== 'pending').length || 1;
        return `${session.role === 'gm' ? 'GM' : 'Player'} · ${online}人`;
      }
      function renderButton() {
        const pending = connected && session?.identityStatus === 'pending';
        button.dataset.state = pending ? 'pending' : connected ? 'online' : joining ? 'connecting' : 'offline';
        const label = button.querySelector('[data-mp-label]');
        if (label) label.textContent = statusText();
      }
      function setMapStatus(message) {
        const node = shell.querySelector?.('[data-role="map-status"]');
        if (node) node.textContent = message;
      }
      function showDialog() {
        overlay.hidden = false;
        overlay.style.removeProperty('display');
      }
      function hideDialog() {
        overlay.hidden = true;
        overlay.style.display = 'none';
      }

      function presenceHtml() {
        if (!clients.length) return '<span class="multiplayer-muted">暂无在线 Session</span>';
        return clients.map(item => {
          const gm = item.role === 'gm';
          const pending = item.identityStatus === 'pending';
          const character = !gm && item.defaultActorId ? ` · ${escapeHtml(actorName(item.defaultActorId))}` : '';
          return `<span class="multiplayer-chip ${gm ? 'gm' : ''}">${gm ? 'GM' : pending ? '待批准' : 'P'} · ${escapeHtml(item.name || 'Player')}${character}</span>`;
        }).join('');
      }

      function renderLogin(message = '') {
        const role = saved('role', defaultRole());
        const name = saved('name', role === 'gm' ? 'GM' : 'Player');
        const joinCode = saved('joinCode', '');
        const savedUserId = saved('userId', '');
        const savedAuth = saved('authToken', '');
        const hasSavedIdentity = Boolean(savedUserId && savedAuth);
        overlay.innerHTML = `<form class="multiplayer-dialog login" data-mp-login-form>
          <h2>RPGmap V1.4.1 多人联机</h2>
          <p>Player 第一次加入会向 GM 发起身份申请；GM 批准并分配角色后，该 User 会持久保存在当前 World。GM 也可以提前创建 User，并把 Player Key 发给指定玩家。</p>
          ${message ? `<div class="multiplayer-status-card ${message.includes('等待') ? 'warn' : ''}">${escapeHtml(message)}</div>` : ''}
          ${hasSavedIdentity ? `<div class="multiplayer-status-card">检测到本网址已保存的 Player 身份。正常情况下直接加入即可。<button type="button" class="multiplayer-mini-button" data-mp-clear-identity>清除本机身份</button></div>` : ''}
          <div class="multiplayer-fields">
            <label class="multiplayer-field">显示名称<input name="name" maxlength="40" value="${escapeHtml(name)}" required></label>
            <label class="multiplayer-field">身份<select name="role"><option value="gm" ${role === 'gm' ? 'selected' : ''}>GM</option><option value="player" ${role !== 'gm' ? 'selected' : ''}>Player</option></select></label>
            <label class="multiplayer-field">Join Code<input name="joinCode" maxlength="80" value="${escapeHtml(joinCode)}" autocomplete="off" placeholder="玩家首次加入时填写"></label>
            <label class="multiplayer-field">Player Key（已有 User / 新 Tunnel 时）<input name="playerKey" maxlength="120" autocomplete="off" placeholder="例如 A1B2C3D4E5F60708"></label>
            <label class="multiplayer-field">GM Secret<input name="gmSecret" maxlength="120" autocomplete="off" placeholder="仅 GM 填写"></label>
          </div>
          <div class="multiplayer-presence">${presenceHtml()}</div>
          <div class="multiplayer-actions"><button type="button" data-mp-close>取消</button><button type="submit" class="primary">加入游戏</button></div>
        </form>`;
        showDialog();
      }

      function ownershipRows(user) {
        if (!access.actors.length) return '<div class="multiplayer-muted">World 中还没有 Actor。</div>';
        return `<div class="multiplayer-ownership">${access.actors.map(actor => {
          const level = user.ownership?.[actor.id] || 'none';
          return `<span>${escapeHtml(actor.name)}</span><select data-mp-actor-permission="${escapeHtml(actor.id)}"><option value="none" ${level === 'none' ? 'selected' : ''}>NONE</option><option value="observer" ${level === 'observer' ? 'selected' : ''}>OBSERVER</option><option value="owner" ${level === 'owner' ? 'selected' : ''}>OWNER</option></select>`;
        }).join('')}</div>`;
      }

      function defaultActorOptions(selected, ownerOnly = false, ownership = {}) {
        const actors = ownerOnly ? access.actors.filter(actor => ownership?.[actor.id] === 'owner') : access.actors;
        return `<option value="">未分配</option>${actors.map(actor => `<option value="${escapeHtml(actor.id)}" ${String(selected || '') === String(actor.id) ? 'selected' : ''}>${escapeHtml(actor.name)}</option>`).join('')}`;
      }

      function renderDashboard(message = '') {
        const isGm = session?.role === 'gm';
        const selfUser = access.users.find(user => user.id === access.selfUserId) || null;
        const pending = session?.identityStatus === 'pending';
        const userCards = access.users.map(user => {
          const online = user.online;
          if (!isGm) {
            return `<article class="multiplayer-user-card"><div class="multiplayer-user-head"><span class="multiplayer-online ${online ? 'on' : ''}"></span><strong>${escapeHtml(user.name)}</strong><span class="multiplayer-muted">${online ? '在线' : '离线'} · ${escapeHtml(actorName(user.defaultActorId))}</span></div></article>`;
          }
          return `<form class="multiplayer-user-card" data-mp-user-form data-user-id="${escapeHtml(user.id)}">
            <div class="multiplayer-user-head"><span class="multiplayer-online ${online ? 'on' : ''}"></span><strong>${escapeHtml(user.name)}</strong><span class="multiplayer-muted">${online ? '在线' : '离线'}${user.disabled ? ' · 已禁用' : ''}</span></div>
            <div class="multiplayer-grid-2">
              <label class="multiplayer-field">User 名称<input name="userName" maxlength="40" value="${escapeHtml(user.name)}"></label>
              <label class="multiplayer-field">默认角色<select name="defaultActorId">${defaultActorOptions(user.defaultActorId)}</select></label>
            </div>
            ${ownershipRows(user)}
            <div class="multiplayer-actions"><button type="button" class="multiplayer-mini-button" data-mp-reset-key="${escapeHtml(user.id)}">重发 Player Key</button><button type="button" class="multiplayer-mini-button danger" data-mp-delete-user="${escapeHtml(user.id)}">删除 User</button><button type="submit" class="multiplayer-mini-button primary">保存权限</button></div>
          </form>`;
        }).join('');

        overlay.innerHTML = `<div class="multiplayer-dialog" data-mp-dashboard>
          <div class="multiplayer-user-head"><h2>联机 / Users</h2><span class="multiplayer-muted">revision ${revision}</span></div>
          ${message ? `<div class="multiplayer-status-card">${escapeHtml(message)}</div>` : ''}
          ${latestNotice ? `<div class="multiplayer-status-card">${escapeHtml(latestNotice)}</div>` : ''}
          ${latestPlayerKey ? `<div class="multiplayer-status-card key"><b>Player Key</b> — 请保存并发送给对应玩家。Quick Tunnel 地址变化后用它恢复原 User。<span class="multiplayer-key-value">${escapeHtml(latestPlayerKey)}</span><button type="button" class="multiplayer-mini-button" data-mp-dismiss-key>我已保存</button></div>` : ''}
          ${pending ? `<div class="multiplayer-status-card warn"><b>等待 GM 批准身份</b><br>你已经连接服务器，但在 GM 批准并分配角色之前不会获得 World 操作权限。请保持此页面打开。</div>` : ''}
          <section class="multiplayer-section"><h3>当前在线</h3><div class="multiplayer-presence">${presenceHtml()}</div></section>
          ${!isGm && selfUser ? `<section class="multiplayer-section"><h3>我的身份</h3><div><b>${escapeHtml(selfUser.name)}</b> · 默认角色 ${escapeHtml(actorName(selfUser.defaultActorId))}</div><div class="multiplayer-muted">OWNER：${Object.entries(selfUser.ownership || {}).filter(([,v]) => v === 'owner').map(([id]) => escapeHtml(actorName(id))).join('、') || '无'}<br>OBSERVER：${Object.entries(selfUser.ownership || {}).filter(([,v]) => v === 'observer').map(([id]) => escapeHtml(actorName(id))).join('、') || '无'}</div><form data-mp-self-default><label class="multiplayer-field">默认角色<select name="defaultActorId">${defaultActorOptions(selfUser.defaultActorId, true, selfUser.ownership)}</select></label><div class="multiplayer-actions"><button type="submit" class="multiplayer-mini-button primary">保存默认角色</button></div></form></section>` : ''}
          ${isGm ? `<section class="multiplayer-section"><h3>待批准 Player</h3>${access.pending.length ? access.pending.map(item => `<form class="multiplayer-user-card" data-mp-pending-form data-session-id="${escapeHtml(item.id)}"><div class="multiplayer-user-head"><span class="multiplayer-online on"></span><strong>${escapeHtml(item.name)}</strong><span class="multiplayer-muted">首次申请</span></div><div class="multiplayer-grid-2"><label class="multiplayer-field">正式 User 名称<input name="userName" maxlength="40" value="${escapeHtml(item.name)}"></label><label class="multiplayer-field">默认角色<select name="defaultActorId">${defaultActorOptions(null)}</select></label></div><div class="multiplayer-actions"><button type="submit" class="multiplayer-mini-button primary">批准并绑定</button></div></form>`).join('') : '<div class="multiplayer-muted">当前没有待批准玩家。</div>'}</section>
          <section class="multiplayer-section"><h3>预创建 Player User</h3><p>适合开团前准备。创建后会生成一个长期 Player Key，只显示一次。</p><form data-mp-create-user><div class="multiplayer-grid-2"><label class="multiplayer-field">User 名称<input name="userName" maxlength="40" placeholder="玩家名称" required></label><label class="multiplayer-field">默认角色<select name="defaultActorId">${defaultActorOptions(null)}</select></label></div><div class="multiplayer-actions"><button type="submit" class="multiplayer-mini-button primary">创建 User + Player Key</button></div></form></section>
          <section class="multiplayer-section"><h3>Player Users / Actor Ownership</h3>${userCards || '<div class="multiplayer-muted">还没有正式 Player User。</div>'}</section>` : `<section class="multiplayer-section"><h3>World Users</h3>${userCards || '<div class="multiplayer-muted">暂无其他 User。</div>'}</section>`}
          <div class="multiplayer-actions"><button type="button" data-mp-disconnect>断开连接</button><button type="button" class="primary" data-mp-close>关闭</button></div>
        </div>`;
        showDialog();
      }

      function renderDialog(message = '') {
        if (connected && session) renderDashboard(message);
        else renderLogin(message);
      }

      function socketUrl() { return multiplayerSocketUrl(documentNode.defaultView?.location); }

      async function applyRemoteState(state, nextRevision, reason = 'remote') {
        if (!state || typeof state !== 'object') return false;
        applyingRemote = true;
        try {
          await api.importState(state, false);
          revision = Number(nextRevision) || revision;
          lastServerState = structuredClone(state);
          setMapStatus(`联机同步完成 · revision ${revision}${reason ? ` · ${reason}` : ''}`);
          return true;
        } catch (error) {
          console.error('[RPGmap Multiplayer] remote state import failed', error);
          setMapStatus('联机同步失败：' + error.message);
          return false;
        } finally {
          queueMicrotask(() => { applyingRemote = false; });
        }
      }

      function send(message) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(message));
        return true;
      }

      function flushPush() {
        if (!connected || applyingRemote || inFlight || !permissions.worldWrite || !pendingPush) return;
        const nextState = api.exportState();
        if (session?.role !== 'gm' && lastServerState) {
          const authorization = validateLocalPlayerChange({ before: lastServerState, next: nextState, permissions });
          if (!authorization.ok) {
            pendingPush = false;
            inFlight = false;
            const message = authorization.message || '当前操作没有权限';
            setMapStatus('权限：' + message);
            applyRemoteState(lastServerState, revision, '权限回滚');
            return;
          }
        }
        pendingPush = false;
        inFlight = true;
        if (!send({ type: 'world.push', baseRevision: revision, state: nextState, reason: 'client-state' })) {
          inFlight = false;
          pendingPush = true;
        }
      }

      function queuePush() {
        if (!connected || applyingRemote || !permissions.worldWrite) return;
        pendingPush = true;
        queueMicrotask(flushPush);
      }

      function handleMessage(event) {
        const message = parseMessage(event);
        if (!message) return;

        if (message.type === 'identity.bound') {
          const wasPending = session?.identityStatus === 'pending';
          save('userId', message.userId || '');
          save('authToken', message.authToken || '');
          if (submittedPlayerKey) save('playerKey', submittedPlayerKey);
          else if (wasPending && message.authToken) {
            // Server deliberately uses the first short token as the portable Player Key.
            save('playerKey', message.authToken);
            latestPlayerKey = message.authToken;
          }
          return;
        }

        if (message.type === 'welcome') {
          connected = true;
          joining = false;
          session = message.session || null;
          permissions = message.permissions || permissions;
          revision = Number(message.world?.revision) || 0;
          renderButton();
          save('role', session?.role || 'player');
          if (session?.identityStatus === 'pending') {
            lastServerState = null;
            setMapStatus('Player 身份申请已发送 · 等待 GM 批准并分配角色');
            renderDashboard('已连接服务器，正在等待 GM 批准。');
            return;
          }
          hideDialog();
          if (message.world?.state) {
            applyRemoteState(message.world.state, revision, 'initial').then(() => { inFlight = false; flushPush(); });
          } else if (session?.role === 'gm' && permissions.worldWrite) {
            lastServerState = null;
            pendingPush = true;
            flushPush();
          } else {
            setMapStatus('已连接多人服务器 · 等待 GM 初始化 World');
          }
          return;
        }

        if (message.type === 'presence') {
          clients = Array.isArray(message.clients) ? message.clients : [];
          renderButton();
          if (!overlay.hidden && connected) renderDashboard();
          return;
        }

        if (message.type === 'access.snapshot') {
          access = {
            users: Array.isArray(message.users) ? message.users : [],
            pending: Array.isArray(message.pending) ? message.pending : [],
            actors: Array.isArray(message.actors) ? message.actors : [],
            canManage: message.canManage === true,
            selfUserId: message.selfUserId || null,
          };
          if (!overlay.hidden && connected) renderDashboard();
          return;
        }

        if (message.type === 'permissions.update') {
          permissions = message.permissions || permissions;
          if (session && message.user) {
            session.name = message.user.name || session.name;
            session.defaultActorId = message.user.defaultActorId || null;
          }
          renderButton();
          if (!overlay.hidden) renderDashboard('权限已由 GM 更新。');
          return;
        }

        if (message.type === 'access.notice') {
          latestNotice = message.message || '';
          if (!overlay.hidden) renderDashboard();
          return;
        }

        if (message.type === 'access.claim') {
          latestPlayerKey = message.claimCode || message.playerKey || '';
          latestNotice = message.message || '请保存 Player Key。';
          renderDashboard();
          return;
        }

        if (message.type === 'world.snapshot') {
          const own = session?.id && message.originSessionId === session.id;
          revision = Number(message.revision) || revision;
          lastServerState = message.state && typeof message.state === 'object' ? structuredClone(message.state) : lastServerState;
          if (own) {
            inFlight = false;
            flushPush();
          } else {
            inFlight = false;
            pendingPush = false;
            applyRemoteState(message.state, revision, message.reason || 'remote').then(flushPush);
          }
          return;
        }

        if (message.type === 'world.conflict' || message.type === 'world.denied') {
          inFlight = false;
          pendingPush = false;
          const text = message.type === 'world.denied' ? (message.message || '服务器拒绝了当前操作') : '检测到并发更新，已重新载入服务器状态';
          setMapStatus('联机：' + text);
          applyRemoteState(message.state, message.revision, message.type === 'world.denied' ? '权限回滚' : 'conflict-reload');
          return;
        }

        if (message.type === 'error') {
          inFlight = false;
          joining = false;
          renderButton();
          const text = message.message || message.code || '联机错误';
          setMapStatus('联机：' + text);
          if (['identity_invalid','identity_disabled','identity_reissued'].includes(message.code)) clearSavedIdentity();
          renderDialog(text);
        }
      }

      function connect({ name, requestedRole, joinCode = '', gmSecret = '', playerKey = '' }) {
        intentionalClose = false;
        if (socket) {
          try { socket.close(); } catch {}
          socket = null;
        }
        connected = false;
        joining = true;
        session = null;
        inFlight = false;
        pendingPush = false;
        lastServerState = null;
        submittedPlayerKey = String(playerKey || '').trim().toUpperCase();
        renderButton();
        save('name', name);
        save('role', requestedRole);
        save('joinCode', joinCode);
        const ws = new WebSocket(socketUrl());
        socket = ws;
        ws.addEventListener('open', () => {
          if (socket !== ws) return;
          const isPlayer = normalizeRequestedRole(requestedRole) === 'player';
          send({
            type: 'hello',
            name: sanitizeMultiplayerName(name),
            requestedRole: normalizeRequestedRole(requestedRole),
            joinCode,
            gmSecret,
            userId: isPlayer ? saved('userId', '') : '',
            authToken: isPlayer ? saved('authToken', '') : '',
            claimCode: isPlayer ? submittedPlayerKey : '',
          });
        });
        ws.addEventListener('message', handleMessage);
        ws.addEventListener('error', () => {
          if (socket !== ws) return;
          setMapStatus('联机连接失败，请确认主机 Server 与网络地址');
        });
        ws.addEventListener('close', () => {
          if (socket !== ws) return;
          socket = null;
          connected = false;
          joining = false;
          session = null;
          inFlight = false;
          pendingPush = false;
          renderButton();
          if (!intentionalClose) setMapStatus('多人连接已断开 · 点击“联机”重新连接');
        });
      }

      function disconnect() {
        intentionalClose = true;
        if (socket) { try { socket.close(); } catch {} }
        socket = null;
        connected = false;
        joining = false;
        session = null;
        inFlight = false;
        pendingPush = false;
        lastServerState = null;
        renderButton();
        hideDialog();
      }

      function collectOwnership(form) {
        const result = {};
        for (const select of form.querySelectorAll('[data-mp-actor-permission]')) {
          if (select.value !== 'none') result[select.dataset.mpActorPermission] = select.value;
        }
        const defaultActorId = String(new FormData(form).get('defaultActorId') || '');
        if (defaultActorId) result[defaultActorId] = 'owner';
        return result;
      }

      button.addEventListener('click', () => renderDialog(connected ? `当前已连接 · revision ${revision}` : ''));
      overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.closest?.('[data-mp-close]')) { hideDialog(); return; }
        if (event.target.closest?.('[data-mp-disconnect]')) { disconnect(); return; }
        if (event.target.closest?.('[data-mp-clear-identity]')) {
          clearSavedIdentity();
          latestPlayerKey = '';
          renderLogin('已清除这个网址保存的 Player 身份。');
          return;
        }
        if (event.target.closest?.('[data-mp-dismiss-key]')) {
          latestPlayerKey = '';
          renderDashboard();
          return;
        }
        const reset = event.target.closest?.('[data-mp-reset-key]');
        if (reset) {
          latestPlayerKey = '';
          send({ type: 'access.user.reset-claim', userId: reset.dataset.mpResetKey });
          return;
        }
        const del = event.target.closest?.('[data-mp-delete-user]');
        if (del && confirm('删除这个 Player User？该玩家现有身份会立即失效。')) {
          send({ type: 'access.user.delete', userId: del.dataset.mpDeleteUser });
        }
      });

      overlay.addEventListener('submit', event => {
        event.preventDefault();
        const target = event.target;
        const form = new FormData(target);

        if (target.matches('[data-mp-login-form]')) {
          const name = sanitizeMultiplayerName(form.get('name'), 'Player');
          const requestedRole = normalizeRequestedRole(form.get('role'));
          connect({
            name,
            requestedRole,
            joinCode: String(form.get('joinCode') || ''),
            gmSecret: String(form.get('gmSecret') || ''),
            playerKey: String(form.get('playerKey') || ''),
          });
          renderLogin('正在连接 ' + socketUrl() + ' …');
          return;
        }

        if (target.matches('[data-mp-pending-form]')) {
          const defaultActorId = String(form.get('defaultActorId') || '');
          send({ type: 'access.user.approve', sessionId: target.dataset.sessionId, name: String(form.get('userName') || ''), defaultActorId, ownership: defaultActorId ? { [defaultActorId]: 'owner' } : {} });
          return;
        }

        if (target.matches('[data-mp-create-user]')) {
          latestPlayerKey = '';
          const defaultActorId = String(form.get('defaultActorId') || '');
          send({ type: 'access.user.create', name: String(form.get('userName') || ''), defaultActorId, ownership: defaultActorId ? { [defaultActorId]: 'owner' } : {} });
          return;
        }

        if (target.matches('[data-mp-user-form]')) {
          send({
            type: 'access.user.update',
            userId: target.dataset.userId,
            name: String(form.get('userName') || ''),
            defaultActorId: String(form.get('defaultActorId') || ''),
            ownership: collectOwnership(target),
          });
          return;
        }

        if (target.matches('[data-mp-self-default]')) {
          send({ type: 'access.self.default', actorId: String(form.get('defaultActorId') || '') });
        }
      });

      api.on('state:saved', queuePush);
      api.on('state:import', queuePush);

      api.multiplayer = {
        connect,
        disconnect,
        requestWorld: () => send({ type: 'world.request' }),
        requestAccess: () => send({ type: 'access.request' }),
        pushWorld: () => { pendingPush = true; flushPush(); },
        canControlActor: actorId => canControlActor({ actorId, state: api.getState(), permissions }),
        canControlCharacter: characterId => {
          if (session?.role === 'gm') return true;
          const actorId = actorIdForCharacter(api.getState(), characterId);
          return canControlActor({ actorId, state: api.getState(), permissions });
        },
        canObserveActor: actorId => session?.role === 'gm' || (permissions.actorObserverIds || []).map(String).includes(String(actorId)),
        getStatus: () => ({
          connected,
          joining,
          revision,
          session: session ? { ...session } : null,
          permissions: structuredClone(permissions),
          clients: clients.map(item => ({ ...item })),
          access: structuredClone(access),
        }),
      };

      renderButton();
      renderLogin('Player 第一次加入后需要 GM 批准身份并分配角色；已有 User 可使用 Player Key 恢复身份。');
    },
  };
}
