import { isLocalHost, multiplayerSocketUrl, normalizeRequestedRole, sanitizeMultiplayerName } from './protocol.js';

const STYLE_ID = 'rpgmap-multiplayer-style';
const STORAGE_PREFIX = 'rpgmap:multiplayer:';

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .multiplayer-toolbar { position:relative; }
    .multiplayer-toolbar[data-state="online"] { border-color:#3d9b63 !important; }
    .multiplayer-toolbar[data-state="connecting"] { border-color:#d99729 !important; }
    .multiplayer-toolbar[data-state="offline"] { border-color:#b9c1bf !important; }
    .multiplayer-dot { width:7px; height:7px; border-radius:50%; display:inline-block; background:#a9b1af; margin-right:4px; }
    .multiplayer-toolbar[data-state="online"] .multiplayer-dot { background:#3d9b63; }
    .multiplayer-toolbar[data-state="connecting"] .multiplayer-dot { background:#d99729; }
    .multiplayer-backdrop { position:fixed; inset:0; z-index:5200; background:rgba(18,23,24,.52); display:grid; place-items:center; padding:18px; }
    .multiplayer-backdrop[hidden] { display:none !important; }
    .multiplayer-dialog { width:min(440px,94vw); background:#f8faf7; border-radius:14px; border:1px solid rgba(40,70,70,.28); box-shadow:0 22px 70px rgba(0,0,0,.32); padding:18px; display:grid; gap:13px; }
    .multiplayer-dialog h2 { margin:0; font-size:18px; }
    .multiplayer-dialog p { margin:0; color:#647174; font-size:12px; line-height:1.55; }
    .multiplayer-fields { display:grid; gap:9px; }
    .multiplayer-field { display:grid; gap:5px; font-size:12px; color:#59676a; }
    .multiplayer-field input,.multiplayer-field select { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid #cbd5d2; border-radius:8px; background:white; font:inherit; }
    .multiplayer-actions { display:flex; gap:8px; justify-content:flex-end; }
    .multiplayer-actions button { border:1px solid #b9c5c1; border-radius:8px; padding:8px 12px; background:#fff; cursor:pointer; font-weight:800; }
    .multiplayer-actions .primary { border-color:#176d76; background:#176d76; color:white; }
    .multiplayer-status-card { padding:9px 10px; border-radius:8px; background:#eef3ef; color:#526164; font-size:12px; line-height:1.5; }
    .multiplayer-presence { display:flex; gap:5px; flex-wrap:wrap; }
    .multiplayer-chip { padding:3px 7px; border-radius:999px; background:#e3ebe6; color:#4f615d; font-size:10px; font-weight:800; }
    .multiplayer-chip.gm { background:#f1e7d8; color:#875b27; }
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
      let permissions = { worldWrite: false, worldReset: false };
      let clients = [];
      let inFlight = false;
      let pendingPush = false;
      let intentionalClose = false;

      const button = documentNode.createElement('button');
      button.type = 'button';
      button.className = 'tool-button multiplayer-toolbar';
      button.dataset.state = 'offline';
      button.innerHTML = '<span class="multiplayer-dot"></span><span data-mp-label>联机</span>';
      button.title = '多人联机状态 / 重新连接';
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
      function statusText() {
        if (!connected || !session) return joining ? '连接中…' : '联机';
        return `${session.role === 'gm' ? 'GM' : 'Player'} · ${clients.length || 1}人`;
      }
      function renderButton() {
        button.dataset.state = connected ? 'online' : joining ? 'connecting' : 'offline';
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

      function renderDialog(message = '') {
        const role = saved('role', defaultRole());
        const name = saved('name', role === 'gm' ? 'GM' : 'Player');
        const joinCode = saved('joinCode', '');
        const safe = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
        overlay.innerHTML = `<form class="multiplayer-dialog" data-mp-form>
          <h2>RPGmap 多人联机</h2>
          <p>主机电脑启动 RPGmap Server 后，其他设备用浏览器打开主机显示的 Network 地址即可加入。同一套连接也可用于 Tailscale / ZeroTier；HTTPS Tunnel 会自动改用 WSS。</p>
          ${message ? `<div class="multiplayer-status-card">${safe(message)}</div>` : ''}
          <div class="multiplayer-fields">
            <label class="multiplayer-field">显示名称<input name="name" maxlength="40" value="${safe(name)}" required></label>
            <label class="multiplayer-field">身份<select name="role"><option value="gm" ${role === 'gm' ? 'selected' : ''}>GM</option><option value="player" ${role !== 'gm' ? 'selected' : ''}>Player</option></select></label>
            <label class="multiplayer-field">房间码（未启用时留空）<input name="joinCode" maxlength="80" value="${safe(joinCode)}" autocomplete="off"></label>
            <label class="multiplayer-field">GM Secret（本机 GM 通常可留空；公网模式 GM 必填）<input name="gmSecret" maxlength="120" autocomplete="off"></label>
          </div>
          <div class="multiplayer-presence">${clients.map(item => `<span class="multiplayer-chip ${item.role === 'gm' ? 'gm' : ''}">${item.role === 'gm' ? 'GM' : 'P'} · ${safe(item.name || 'Player')}</span>`).join('')}</div>
          <div class="multiplayer-actions"><button type="button" data-mp-close>取消</button><button type="submit" class="primary">${connected ? '重新连接' : '加入游戏'}</button></div>
        </form>`;
        showDialog();
      }

      function socketUrl() { return multiplayerSocketUrl(documentNode.defaultView?.location); }

      async function applyRemoteState(state, nextRevision, reason = 'remote') {
        if (!state || typeof state !== 'object') return false;
        applyingRemote = true;
        try {
          await api.importState(state, false);
          revision = Number(nextRevision) || revision;
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
        pendingPush = false;
        inFlight = true;
        if (!send({ type: 'world.push', baseRevision: revision, state: api.exportState(), reason: 'client-state' })) {
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
        if (message.type === 'welcome') {
          connected = true;
          joining = false;
          session = message.session || null;
          permissions = message.permissions || permissions;
          revision = Number(message.world?.revision) || 0;
          renderButton();
          hideDialog();
          save('role', session?.role || 'player');
          if (message.world?.state) {
            applyRemoteState(message.world.state, revision, 'initial').then(() => { inFlight = false; flushPush(); });
          } else if (session?.role === 'gm' && permissions.worldWrite) {
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
          if (!overlay.hidden) renderDialog();
          return;
        }
        if (message.type === 'world.snapshot') {
          const own = session?.id && message.originSessionId === session.id;
          revision = Number(message.revision) || revision;
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
        if (message.type === 'world.conflict') {
          inFlight = false;
          pendingPush = false;
          applyRemoteState(message.state, message.revision, 'conflict-reload');
          return;
        }
        if (message.type === 'error') {
          inFlight = false;
          joining = false;
          renderButton();
          const text = message.message || message.code || '联机错误';
          setMapStatus('联机：' + text);
          renderDialog(text);
        }
      }

      function connect({ name, requestedRole, joinCode = '', gmSecret = '' }) {
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
        renderButton();
        save('name', name);
        save('role', requestedRole);
        save('joinCode', joinCode);
        const ws = new WebSocket(socketUrl());
        socket = ws;
        ws.addEventListener('open', () => {
          if (socket !== ws) return;
          send({ type: 'hello', name: sanitizeMultiplayerName(name), requestedRole: normalizeRequestedRole(requestedRole), joinCode, gmSecret });
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
        renderButton();
      }

      button.addEventListener('click', () => renderDialog(connected ? `当前已连接 · revision ${revision}` : ''));
      overlay.addEventListener('click', event => { if (event.target === overlay || event.target.closest?.('[data-mp-close]')) hideDialog(); });
      overlay.addEventListener('submit', event => {
        if (!event.target.matches('[data-mp-form]')) return;
        event.preventDefault();
        const form = new FormData(event.target);
        const name = sanitizeMultiplayerName(form.get('name'), 'Player');
        const requestedRole = normalizeRequestedRole(form.get('role'));
        connect({ name, requestedRole, joinCode: String(form.get('joinCode') || ''), gmSecret: String(form.get('gmSecret') || '') });
        renderDialog('正在连接 ' + socketUrl() + ' …');
      });

      api.on('state:saved', queuePush);
      api.on('state:import', queuePush);

      api.multiplayer = {
        connect,
        disconnect,
        requestWorld: () => send({ type: 'world.request' }),
        pushWorld: () => { pendingPush = true; flushPush(); },
        getStatus: () => ({ connected, joining, revision, session: session ? { ...session } : null, permissions: { ...permissions }, clients: clients.map(item => ({ ...item })) }),
      };

      renderButton();
      renderDialog('这是 Multiplayer V1 测试入口。主机本机建议选择 GM，其他设备选择 Player。');
    },
  };
}
