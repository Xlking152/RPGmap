import { isLocalHost, multiplayerSocketUrl, normalizeRequestedRole, sanitizeMultiplayerName } from './protocol.js';
import { canControlActor, validateLocalPlayerChange } from './permissions.js';
import {
  applyWorldOperationPatch,
  deriveWorldOperations,
  WORLD_OPERATION_SCHEMA_VERSION,
} from '../world/operations.js';
import { STATUS_SCHEMA_VERSION } from '../status/model.js';
import { ACCESS_SCHEMA_VERSION } from '../permissions/model.js';
import { escapeMultiplayerHtml as escapeHtml } from './access-ui.js';
import { createMultiplayerSessionStorage } from './session.js';
import { createOperationId, parseTransportMessage, sendTransportMessage } from './transport.js';
import { hasWorldOperationRevisionGap, shouldApplyOwnServerSnapshot } from './revision.js';

const STYLE_ID = 'rpgmap-multiplayer-style';

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

export function isWorldOperationChannelBusy(state = {}) {
  return Boolean(
    state.applyingRemote || state.remoteApplyPending || state.inFlight || state.pendingPush
    || state.activeAtomicWorldOperation || state.atomicWorldOperationQueueLength
    || state.activeStatusOperation || state.statusOperationQueueLength
    || state.activeOperation || state.operationQueueLength,
  );
}

export { hasWorldOperationRevisionGap, shouldApplyOwnServerSnapshot } from './revision.js';

export function createMultiplayerController() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const toolbar = shell.querySelector?.('.toolbar-right');
      if (!toolbar) return;
      installStyles(documentNode);
      const sessionStorage = createMultiplayerSessionStorage(documentNode.defaultView?.localStorage);

      let socket = null;
      let connected = false;
      let joining = false;
      let applyingRemote = false;
      let revision = 0;
      let audienceRevision = 0;
      let pendingVisionSource = null;
      let activeVisionSourceTokenId = null;
      let session = null;
      let permissions = { worldWrite: false, worldReset: false, manageAccess: false, combatManage: false, actorOwnerIds: [], actorObserverIds: [], actorLimitedIds: [], defaultActorId: null, placementGrants: { actorTypes: [], actorIds: [], markerKinds: [] } };
      let clients = [];
      let access = { users: [], pending: [], actors: [], canManage: false, selfUserId: null };
      let inFlight = false;
      let pendingPush = false;
      let intentionalClose = false;
      let lastServerState = null;
      let submittedPlayerKey = '';
      let latestPlayerKey = '';
      let latestNotice = '';
      let localCommitSerial = 0;
      let lastSavedCommitSerial = 0;
      let deferredChat = [];
      let activeWorldOperationId = null;
      let activeAtomicWorldOperation = null;
      let atomicWorldOperationQueue = [];
      let activeOperation = null;
      let operationQueue = [];
      let lastObservedLocalState = null;
      let remoteApplyChain = Promise.resolve();
      let remoteApplyPending = 0;
      let remoteEpoch = 0;

      const operationId = createOperationId;

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
        return sessionStorage.get(key, fallback);
      }
      function save(key, value) {
        sessionStorage.set(key, value);
      }
      function removeSaved(key) {
        sessionStorage.remove(key);
      }
      function clearSavedIdentity() {
        sessionStorage.clearIdentity();
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
          const actor = !gm && item.defaultActorId ? ` · ${escapeHtml(actorName(item.defaultActorId))}` : '';
          return `<span class="multiplayer-chip ${gm ? 'gm' : ''}">${gm ? 'GM' : pending ? '待批准' : 'P'} · ${escapeHtml(item.name || 'Player')}${actor}</span>`;
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
          <h2>RPGmap V1.5 多人联机</h2>
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
          return `<span>${escapeHtml(actor.name)}</span><select data-mp-actor-permission="${escapeHtml(actor.id)}"><option value="none" ${level === 'none' ? 'selected' : ''}>NONE</option><option value="limited" ${level === 'limited' ? 'selected' : ''}>LIMITED</option><option value="observer" ${level === 'observer' ? 'selected' : ''}>OBSERVER</option><option value="owner" ${level === 'owner' ? 'selected' : ''}>OWNER</option></select>`;
        }).join('')}</div>`;
      }

      function placementGrantRows(user) {
        const grants = user.placementGrants || {};
        const actorTypeOptions = [
          ['pc', 'PC'], ['monster', '怪物'], ['npc', 'NPC'], ['summon', '召唤物'], ['other', '其他 Actor'],
        ];
        const markerOptions = [
          ['trap', '陷阱'], ['target', '目标点'], ['area', '区域'], ['note', '注释'],
        ];
        const checks = (values, key, options) => options.map(([value, label]) =>
          `<label><input type="checkbox" data-mp-placement-grant="${key}" value="${escapeHtml(value)}" ${(values || []).includes(value) ? 'checked' : ''}>${escapeHtml(label)}</label>`).join('');
        const actorIds = access.actors.map(actor =>
          `<label><input type="checkbox" data-mp-placement-grant="actorIds" value="${escapeHtml(actor.id)}" ${(grants.actorIds || []).includes(actor.id) ? 'checked' : ''}>${escapeHtml(actor.name)}</label>`).join('');
        return `<div class="multiplayer-section"><h3>放置授权</h3>
          <div class="multiplayer-muted">Actor 类型</div><div class="multiplayer-presence">${checks(grants.actorTypes, 'actorTypes', actorTypeOptions)}</div>
          <div class="multiplayer-muted">指定模板</div><div class="multiplayer-presence">${actorIds || '无 Actor 模板'}</div>
          <div class="multiplayer-muted">其他指示物</div><div class="multiplayer-presence">${checks(grants.markerKinds, 'markerKinds', markerOptions)}</div>
        </div>`;
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
            ${placementGrantRows(user)}
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

      function applyRemoteState(state, nextRevision, reason = 'remote', { serverState = state } = {}) {
        if (!state || typeof state !== 'object') return Promise.resolve(false);
        const epoch = remoteEpoch;
        const requestedState = structuredClone(state);
        const requestedRevision = Number(nextRevision) || revision;
        remoteApplyPending += 1;
        applyingRemote = true;
        const task = remoteApplyChain.catch(() => {}).then(async () => {
          if (epoch !== remoteEpoch) return false;
          try {
            const requestedWorld = requestedState?.preferences?.worldV2;
            const requestedScenes = Array.isArray(requestedWorld?.scenes) ? requestedWorld.scenes : [];
            const requestedScene = requestedScenes.find(scene => String(scene?.id || '') === String(requestedWorld?.activeSceneId || '')) || requestedScenes[0] || null;
            const requestedMapId = String(requestedScene?.mapPackage?.id || '');
            const loadedMapId = String(api.mapPackage?.id || api.mapPackage?.mapId || '');
            if (requestedMapId && loadedMapId && requestedMapId !== loadedMapId) {
              revision = requestedRevision;
              lastServerState = structuredClone(serverState);
              lastObservedLocalState = structuredClone(requestedState);
              setMapStatus(`Scene 已切换到 ${requestedMapId}，正在重新载入地图…`);
              queueMicrotask(() => documentNode.defaultView?.location?.reload?.());
              return true;
            }
            await api.importState(requestedState, false);
            if (epoch !== remoteEpoch) return false;
            revision = requestedRevision;
            lastServerState = structuredClone(serverState);
            lastObservedLocalState = structuredClone(requestedState);
            setMapStatus(`联机同步完成 · revision ${revision}${reason ? ` · ${reason}` : ''}`);
            return true;
          } catch (error) {
            console.error('[RPGmap Multiplayer] remote state import failed', error);
            setMapStatus('联机同步失败：' + error.message);
            return false;
          }
        });
        remoteApplyChain = task.finally(() => {
          remoteApplyPending = Math.max(0, remoteApplyPending - 1);
          applyingRemote = remoteApplyPending > 0;
        });
        return task;
      }

      function applyAuthoritativeOperationState(state, nextRevision, changeSet, serverState) {
        if (!state || typeof state !== 'object') return Promise.resolve(false);
        try {
          api.applyAuthoritativePatchState(state, {
            source: 'world.operation',
            revision: nextRevision,
            changeSet: changeSet || {},
          });
          revision = Number(nextRevision) || revision;
          lastServerState = structuredClone(serverState);
          lastObservedLocalState = structuredClone(state);
          return Promise.resolve(true);
        } catch (error) {
          console.error('[RPGmap Multiplayer] authoritative patch apply failed', error);
          return Promise.resolve(false);
        }
      }

      function send(message) {
        return sendTransportMessage(socket, message);
      }

      function flushDeferredChat() {
        if (!connected || applyingRemote || inFlight || activeAtomicWorldOperation || atomicWorldOperationQueue.length
          || pendingPush
          || activeOperation || operationQueue.length || !deferredChat.length) return;
        const message = deferredChat.shift();
        performOperations([{ type: 'chat.append', payload: message }], { kind: 'chat' })
          .catch(error => setMapStatus(`聊天发送失败：${error.message}`));
      }

      function appendChat({ text, event = 'chat', data = null } = {}) {
        if (!connected) return false;
        return performOperations([{
          type: 'chat.append', payload: { text, event, data },
        }], { kind: 'chat' }).catch(error => {
          setMapStatus(`聊天发送失败：${error.message}`);
          throw error;
        });
      }

      function appendChatAfterWorld({ text, event = 'chat', data = null } = {}) {
        if (!connected) return false;
        deferredChat.push({ text, event, data });
        flushDeferredChat();
        return true;
      }

      function getCapabilities() {
        if (!connected) return {
          connected: false, role: 'offline', canManageWorld: true, canManageStructure: true,
          canImportActors: true, canClearChat: true, canEditActor: () => true,
          canPlaceActor: () => true, canPlaceMarker: () => true, canManageStatuses: true,
          canManageStatusDefinitions: true, canControlToken: () => true,
        };
        const gm = session?.role === 'gm';
        const activePlayer = !gm && session?.identityStatus === 'active';
        return {
          connected: true,
          role: gm ? 'gm' : activePlayer ? 'player' : 'observer',
          canManageWorld: gm,
          canManageStructure: gm,
          canImportActors: gm,
          canClearChat: gm,
          canManageStatuses: gm || activePlayer,
          canManageStatusDefinitions: gm,
          canEditActor: actorId => gm || canControlActor({ actorId, state: api.getState(), permissions }),
          canControlToken: tokenId => {
            if (gm) return true;
            const token = api.tokens?.get?.(tokenId);
            if (!token) return false;
            if ((token.controllerUserIds || []).map(String).includes(String(session?.userId || ''))) return true;
            const actor = api.world?.get?.()?.actors?.find(item => String(item?.id) === String(token.actorId));
            return actor?.type === 'pc' && canControlActor({ actorId: actor.id, state: api.getState(), permissions });
          },
          canPlaceActor: actorId => {
            if (gm) return true;
            const grants = permissions.placementGrants || {};
            const actor = api.world?.get?.()?.actors?.find(item => String(item?.id) === String(actorId));
            return Boolean(grants.actorIds?.includes(String(actorId)) || grants.actorTypes?.includes(String(actor?.type || '')));
          },
          canPlaceMarker: kind => gm || permissions.placementGrants?.markerKinds?.includes(String(kind)),
        };
      }
      function publishCapabilities() { api.emit?.('multiplayer:capabilities', getCapabilities()); }

      function rejectAtomicWorldOperations(message = '联机连接已中断') {
        const error = new Error(message);
        if (activeAtomicWorldOperation) activeAtomicWorldOperation.reject(error);
        for (const operation of atomicWorldOperationQueue) operation.reject(error);
        activeAtomicWorldOperation = null;
        atomicWorldOperationQueue = [];
      }

      function finishAtomicWorldOperation(error = null, detail = null) {
        const operation = activeAtomicWorldOperation;
        if (!operation) return;
        activeAtomicWorldOperation = null;
        if (error) operation.reject(error);
        else operation.resolve(detail || { operationId: operation.operationId, revision });
        queueMicrotask(() => {
          flushOperations();
          flushAtomicWorldOperations();
          flushPush();
          flushDeferredChat();
        });
      }

      function flushAtomicWorldOperations() {
        if (!connected || applyingRemote || inFlight || pendingPush || activeAtomicWorldOperation
          || activeOperation || operationQueue.length || !atomicWorldOperationQueue.length) return;
        const operation = atomicWorldOperationQueue.shift();
        activeAtomicWorldOperation = operation;
        if (!send({
          type: 'world.push',
          operationId: operation.operationId,
          baseRevision: revision,
          state: operation.state,
          reason: operation.reason,
        })) {
          activeAtomicWorldOperation = null;
          atomicWorldOperationQueue.unshift(operation);
        }
      }

      function performWorldOperation(state, { reason = 'atomic-world' } = {}) {
        if (!connected) return Promise.reject(new Error('当前未连接局域网服务器'));
        if (!permissions.worldWrite) return Promise.reject(new Error('当前身份没有 World 写入权限'));
        if (lastServerState && !/^(?:file-import:|backup-restore:|recovery:)/.test(String(reason || ''))) {
          const error = new Error('完整 World 只允许用于显式导入或恢复');
          error.code = 'world_replace_explicit_only';
          return Promise.reject(error);
        }
        if (isWorldOperationChannelBusy({
          applyingRemote,
          remoteApplyPending,
          inFlight,
          pendingPush,
          activeAtomicWorldOperation,
          atomicWorldOperationQueueLength: atomicWorldOperationQueue.length,
          activeOperation,
          operationQueueLength: operationQueue.length,
        })) {
          const error = new Error('另一项服务器写入尚未完成，请在同步完成后重试');
          error.code = 'world_operation_busy';
          return Promise.reject(error);
        }
        const id = operationId('world');
        return new Promise((resolve, reject) => {
          atomicWorldOperationQueue.push({
            operationId: id,
            state: structuredClone(state),
            reason: String(reason || 'atomic-world').slice(0, 80),
            resolve,
            reject,
          });
          flushAtomicWorldOperations();
        });
      }

      function rejectOperations(message = '联机连接已中断') {
        const error = new Error(message);
        error.code = 'operation_cancelled';
        if (activeOperation) activeOperation.reject(error);
        for (const operation of operationQueue) operation.reject(error);
        activeOperation = null;
        operationQueue = [];
        api.emit?.('world:operation-pending-clear', { reason: message });
      }

      function rejectQueuedOperations(error) {
        const queued = operationQueue;
        operationQueue = [];
        for (const operation of queued) operation.reject(error);
        if (queued.length) api.emit?.('world:operation-pending-clear', { reason: error.message });
      }

      function finishOperation(error = null, detail = null) {
        const operation = activeOperation;
        if (!operation) return;
        activeOperation = null;
        if (error) operation.reject(error);
        else operation.resolve(detail || {
          operationId: operation.operationId,
          revision,
          results: operation.results || [],
        });
        api.emit?.('world:operation-result', {
          operationId: operation.operationId,
          kind: operation.kind,
          ok: !error,
          error: error?.message || '',
          revision,
        });
        if (operation.kind === 'status') {
          api.emit?.('status:operation-result', {
            operationId: operation.operationId,
            ok: !error,
            error: error?.message || '',
            revision,
          });
        }
        queueMicrotask(flushPendingNetworkWork);
      }

      function maybeFinishOperation() {
        if (!activeOperation || !activeOperation.acknowledged || !activeOperation.patchApplied) return;
        finishOperation(null, {
          operationId: activeOperation.operationId,
          revision: activeOperation.revision || revision,
          results: activeOperation.results || [],
        });
      }

      function flushOperations() {
        if (!connected || applyingRemote || inFlight || pendingPush || activeAtomicWorldOperation
          || activeOperation || !operationQueue.length) return;
        const operation = operationQueue.shift();
        activeOperation = operation;
        if (!send({
          type: 'world.operation',
          operationId: operation.operationId,
          baseRevision: revision,
          operations: operation.operations,
        })) {
          activeOperation = null;
          operationQueue.unshift(operation);
        }
      }

      function performOperations(operations, { kind = 'world', requestedOperationId = null } = {}) {
        if (!connected) return Promise.reject(new Error('当前未连接局域网服务器'));
        const values = Array.isArray(operations) ? structuredClone(operations) : [];
        if (!values.length) return Promise.resolve({ unchanged: true, revision, results: [] });
        const id = String(requestedOperationId || operationId(kind === 'status' ? 'status' : 'operation'));
        return new Promise((resolve, reject) => {
          operationQueue.push({
            operationId: id,
            operations: values,
            kind,
            resolve,
            reject,
            acknowledged: false,
            patchApplied: false,
            awaitingCanonicalSnapshot: false,
            revision: null,
            results: [],
          });
          api.emit?.('world:operation-pending', { operationId: id, kind, operations: values });
          if (kind === 'status') api.emit?.('status:pending', { operationId: id, type: values[0]?.type || 'status.batch' });
          flushOperations();
        });
      }

      function setVisionSource(tokenId = null) {
        if (!connected) return Promise.reject(new Error('Not connected to the Local/LAN server'));
        if (pendingVisionSource) {
          const error = new Error('Another vision source request is pending');
          error.code = 'vision_source_busy';
          return Promise.reject(error);
        }
        const value = tokenId == null ? null : String(tokenId);
        return new Promise((resolve, reject) => {
          pendingVisionSource = { tokenId: value, resolve, reject };
          if (!send({ type: 'vision.source.set', tokenId: value })) {
            pendingVisionSource = null;
            reject(new Error('Unable to send vision source request'));
          }
        });
      }

      function setActiveVisionSource(tokenId = null) {
        const next = tokenId == null || String(tokenId).trim() === '' ? null : String(tokenId);
        if (activeVisionSourceTokenId === next) return;
        activeVisionSourceTokenId = next;
        api.emit?.('vision:source-change', { tokenId: next });
      }

      function rejectVisionSource(message = 'Vision source request was interrupted') {
        if (!pendingVisionSource) return;
        const error = new Error(message);
        error.code = 'vision_source_interrupted';
        pendingVisionSource.reject(error);
        pendingVisionSource = null;
      }

      function performStateOperation(state, { reason = 'state-operation' } = {}) {
        if (!connected) return Promise.reject(new Error('当前未连接局域网服务器'));
        const before = api.exportState();
        const derived = deriveWorldOperations(before, state);
        if (derived.unsupported.length) {
          api.emit?.('world:operation-unsynced', {
            source: reason,
            unsupported: [...derived.unsupported],
          });
        }
        if (derived.unsupported.includes('world_identity') || derived.unsupported.includes('operation_limit')) {
          const error = new Error(`当前变更不能通过原子 World 操作提交：${derived.unsupported.join(', ')}`);
          error.code = 'world_operation_unsupported';
          return Promise.reject(error);
        }
        if (!derived.operations.length) {
          return Promise.resolve({ unchanged: true, localOnly: true, revision, results: [] });
        }
        return performOperations(derived.operations, { kind: 'world' });
      }

      function queueCommittedOperations(nextState, source = 'state:commit') {
        const after = structuredClone(nextState);
        const before = lastObservedLocalState || lastServerState;
        lastObservedLocalState = structuredClone(after);
        if (!connected || applyingRemote || !permissions.worldWrite || !before) return false;
        const derived = deriveWorldOperations(before, after);
        if (derived.unsupported.length) {
          api.emit?.('world:operation-unsynced', {
            source,
            unsupported: [...derived.unsupported],
          });
        }
        if (!derived.operations.length) return true;
        if (derived.unsupported.includes('world_identity') || derived.unsupported.includes('operation_limit')) {
          setMapStatus(`联机操作未提交：${derived.unsupported.join(', ')}`);
          return true;
        }
        performOperations(derived.operations, { kind: 'world' }).catch(error => {
          console.error('[RPGmap Multiplayer] World operation failed', error);
          setMapStatus(`联机操作失败：${error.message}`);
        });
        return true;
      }

      function performStatusOperation(type, payload = {}) {
        if (!connected) return Promise.reject(new Error('当前未连接局域网服务器'));
        if (!getCapabilities().canManageStatuses) return Promise.reject(new Error('只有 GM 可以管理机械状态'));
        const id = String(payload.operationId || operationId('status'));
        const operationPayload = { ...payload };
        delete operationPayload.operationId;
        return performOperations([{
          type: String(type || ''),
          payload: operationPayload,
        }], { kind: 'status', requestedOperationId: id });
      }

      function flushPush() {
        if (!connected || applyingRemote || inFlight || activeAtomicWorldOperation
          || activeOperation || !permissions.worldWrite || !pendingPush) return;
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
        activeWorldOperationId = operationId('world');
        if (!send({ type: 'world.push', operationId: activeWorldOperationId, baseRevision: revision, state: nextState, reason: 'bootstrap-init' })) {
          inFlight = false;
          pendingPush = true;
          activeWorldOperationId = null;
        }
      }

      function flushPendingNetworkWork() {
        queueMicrotask(() => {
          flushOperations();
          flushAtomicWorldOperations();
          flushPush();
          flushDeferredChat();
        });
      }

      function handleMessage(event) {
        const message = parseTransportMessage(event);
        if (!message) return;

        if (message.type === 'identity.bound') {
          const wasPending = session?.identityStatus === 'pending';
          save('userId', message.userId || '');
          save('authToken', message.authToken || '');
          if (submittedPlayerKey) save('playerKey', submittedPlayerKey);
          else if (wasPending && message.authToken) {
            save('playerKey', message.authToken);
            latestPlayerKey = message.authToken;
          }
          return;
        }

        if (message.type === 'welcome') {
          if (Number(message.operationSchema) !== WORLD_OPERATION_SCHEMA_VERSION) {
            setMapStatus(`联机失败：Operation schema 需要 ${WORLD_OPERATION_SCHEMA_VERSION}`);
            try { socket?.close(); } catch {}
            return;
          }
          if (Number(message.statusSchema) !== STATUS_SCHEMA_VERSION) {
            setMapStatus(`联机失败：Status schema 需要 ${STATUS_SCHEMA_VERSION}`);
            try { socket?.close(); } catch {}
            return;
          }
          if (Number(message.accessSchema) !== ACCESS_SCHEMA_VERSION) {
            setMapStatus(`联机失败：Access schema 需要 ${ACCESS_SCHEMA_VERSION}`);
            try { socket?.close(); } catch {}
            return;
          }
          connected = true;
          joining = false;
          session = message.session || null;
          permissions = message.permissions || permissions;
          publishCapabilities();
          revision = Number(message.world?.revision) || 0;
          audienceRevision = Math.max(0, Number(message.audienceRevision) || 0);
          setActiveVisionSource(message.world?.state?.preferences?.audienceVision?.source?.tokenId || null);
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
            applyRemoteState(message.world.state, revision, 'initial').then(() => {
              inFlight = false;
              flushPendingNetworkWork();
            });
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

        if (message.type === 'vision.source.ack') {
          audienceRevision = Math.max(audienceRevision, Number(message.audienceRevision) || 0);
          const source = message.tokenId == null ? '' : String(message.tokenId);
          save('visionSourceTokenId', source);
          setActiveVisionSource(source || null);
          if (pendingVisionSource) pendingVisionSource.resolve({ tokenId: source || null, revision: Number(message.revision) || revision });
          pendingVisionSource = null;
          return;
        }

        if (message.type === 'vision.source.denied') {
          const error = new Error(message.message || 'Vision source rejected');
          error.code = message.code || 'vision_source_denied';
          if (pendingVisionSource) pendingVisionSource.reject(error);
          pendingVisionSource = null;
          setActiveVisionSource(null);
          save('visionSourceTokenId', '');
          return;
        }

        if (message.type === 'audience.snapshot') {
          const incomingAudienceRevision = Number(message.audienceRevision);
          if (!Number.isSafeInteger(incomingAudienceRevision) || incomingAudienceRevision <= audienceRevision) return;
          audienceRevision = incomingAudienceRevision;
          applyRemoteState(message.state, Number(message.revision) || revision, message.reason || 'audience.snapshot')
            .then(flushPendingNetworkWork);
          return;
        }

        if (message.type === 'permissions.update') {
          permissions = message.permissions || permissions;
          publishCapabilities();
          if (!getCapabilities().canManageStatuses) {
            const error = new Error('状态管理权限已被移除');
            error.code = 'status_permission_removed';
            if (activeOperation?.kind === 'status') finishOperation(error);
            const retained = [];
            for (const operation of operationQueue) {
              if (operation.kind === 'status') operation.reject(error);
              else retained.push(operation);
            }
            operationQueue = retained;
          }
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

        if (message.type === 'world.operation.committed') {
          const incomingRevision = Number(message.revision);
          if (hasWorldOperationRevisionGap(message, revision)) {
            const error = new Error('联机操作 revision 出现缺口，正在重新载入服务器状态');
            error.code = 'revision_gap';
            rejectOperations(error.message);
            send({ type: 'world.snapshot.request' });
            return;
          }
          let canonicalState;
          let localState;
          try {
            canonicalState = applyWorldOperationPatch(lastServerState || api.exportState(), message.patch);
            localState = applyWorldOperationPatch(api.exportState(), message.patch);
          } catch (cause) {
            const error = new Error(`无法应用服务器操作补丁：${cause.message}`);
            error.code = cause.code || 'world_operation_patch_invalid';
            rejectOperations(error.message);
            send({ type: 'world.snapshot.request' });
            return;
          }
          const matchesActive = activeOperation
            && String(message.operationId || '') === String(activeOperation.operationId);
          const expectedOperationId = matchesActive ? activeOperation.operationId : null;
          applyAuthoritativeOperationState(localState, incomingRevision, message.changeSet, canonicalState).then(applied => {
            if (!applied) {
              const error = new Error('服务器已经保存操作，但客户端无法载入操作补丁');
              error.code = 'world_operation_patch_import_failed';
              rejectOperations(error.message);
              send({ type: 'world.snapshot.request' });
              return;
            }
            if (expectedOperationId && activeOperation
              && String(activeOperation.operationId) === String(expectedOperationId)) {
              activeOperation.patchApplied = true;
              activeOperation.revision = incomingRevision;
              activeOperation.results = Array.isArray(message.results) ? structuredClone(message.results) : [];
              maybeFinishOperation();
            } else {
              flushPendingNetworkWork();
            }
          });
          return;
        }

        if (message.type === 'world.operation.ack') {
          if (!activeOperation || String(message.operationId || '') !== String(activeOperation.operationId)) return;
          activeOperation.acknowledged = true;
          activeOperation.revision = Number(message.revision) || revision;
          activeOperation.results = Array.isArray(message.results) ? structuredClone(message.results) : activeOperation.results;
          if (message.duplicate === true && !activeOperation.patchApplied) {
            activeOperation.awaitingCanonicalSnapshot = true;
            send({ type: 'world.snapshot.request' });
          }
          maybeFinishOperation();
          return;
        }

        if (message.type === 'world.operation.denied') {
          if (!activeOperation || String(message.operationId || '') !== String(activeOperation.operationId)) return;
          const error = new Error(message.message || '服务器拒绝了 World 操作');
          error.code = message.code || 'world_operation_denied';
          if (Array.isArray(message.conflictIds)) error.conflictIds = message.conflictIds.map(String);
          const finish = () => {
            finishOperation(error);
            rejectQueuedOperations(error);
          };
          if (message.state && typeof message.state === 'object') {
            applyRemoteState(message.state, message.revision, '操作回滚').then(finish);
          } else {
            send({ type: 'world.snapshot.request' });
            finish();
          }
          return;
        }

        if (message.type === 'world.snapshot') {
          const own = session?.id && message.originSessionId === session.id;
          const incomingRevision = Number(message.revision) || revision;
          const atomicWorldOperation = activeAtomicWorldOperation
            && message.operationId
            && String(message.operationId) === String(activeAtomicWorldOperation.operationId);
          const genericOperation = activeOperation
            && message.operationId
            && String(message.operationId) === String(activeOperation.operationId);
          const canonicalOperationReload = activeOperation
            && activeOperation.awaitingCanonicalSnapshot === true
            && !message.operationId;
          if (genericOperation || canonicalOperationReload) {
            const expectedOperationId = activeOperation.operationId;
            activeOperation.revision = incomingRevision;
            applyRemoteState(message.state, incomingRevision, message.reason || 'operation-reload').then(applied => {
              if (!activeOperation || String(activeOperation.operationId) !== String(expectedOperationId)) return;
              if (!applied) {
                finishOperation(new Error('服务器已经保存操作，但客户端无法载入最新快照'));
                return;
              }
              activeOperation.awaitingCanonicalSnapshot = false;
              activeOperation.patchApplied = true;
              maybeFinishOperation();
            });
          } else if (atomicWorldOperation) {
            const expectedOperationId = activeAtomicWorldOperation.operationId;
            applyRemoteState(message.state, incomingRevision, message.reason || 'atomic-world').then(applied => {
              if (!activeAtomicWorldOperation
                || String(activeAtomicWorldOperation.operationId) !== String(expectedOperationId)) return;
              if (!applied) {
                finishAtomicWorldOperation(new Error('服务器已经保存操作，但客户端无法载入最新快照'));
                return;
              }
              finishAtomicWorldOperation(null, { operationId: expectedOperationId, revision: incomingRevision });
            });
          } else if (own && shouldApplyOwnServerSnapshot(message)) {
            // Chat is server-only: unlike ordinary optimistic World mutations,
            // the sender has not applied this change locally before the server
            // broadcasts it. Re-import exactly these authoritative snapshots.
            inFlight = false;
            pendingPush = false;
            activeWorldOperationId = null;
            applyRemoteState(message.state, incomingRevision, message.reason || 'server-only').then(flushPendingNetworkWork);
          } else if (own) {
            revision = incomingRevision;
            if (message.state && typeof message.state === 'object') lastServerState = structuredClone(message.state);
            inFlight = false;
            activeWorldOperationId = null;
            flushPendingNetworkWork();
          } else {
            inFlight = false;
            pendingPush = false;
            applyRemoteState(message.state, incomingRevision, message.reason || 'remote').then(flushPendingNetworkWork);
          }
          return;
        }

        if (message.type === 'world.conflict' || message.type === 'world.denied') {
          const atomicWorldOperation = activeAtomicWorldOperation
            && message.operationId
            && String(message.operationId) === String(activeAtomicWorldOperation.operationId);
          inFlight = false;
          activeWorldOperationId = null;
          pendingPush = false;
          deferredChat = [];
          const text = message.type === 'world.denied' ? (message.message || '服务器拒绝了当前操作') : '检测到并发更新，已重新载入服务器状态';
          setMapStatus('联机：' + text);
          const reload = applyRemoteState(message.state, message.revision, message.type === 'world.denied' ? '权限回滚' : 'conflict-reload');
          if (atomicWorldOperation) {
            const error = new Error(text);
            error.code = message.code || (message.type === 'world.denied' ? 'world_denied' : 'revision_conflict');
            reload.then(() => finishAtomicWorldOperation(error));
          }
          return;
        }

        if (message.type === 'error') {
          if (message.operationId && activeOperation
            && String(message.operationId) === String(activeOperation.operationId)) {
            const error = new Error(message.message || message.code || 'World 操作失败');
            error.code = message.code || 'world_operation_error';
            finishOperation(error);
            rejectQueuedOperations(error);
            return;
          }
          if (message.operationId && activeAtomicWorldOperation
            && String(message.operationId) === String(activeAtomicWorldOperation.operationId)) {
            const error = new Error(message.message || message.code || 'World 操作失败');
            error.code = message.code || 'world_error';
            finishAtomicWorldOperation(error);
            return;
          }
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
        remoteEpoch += 1;
        if (socket) {
          try { socket.close(); } catch {}
          socket = null;
        }
        connected = false;
        joining = true;
        setActiveVisionSource(null);
        rejectVisionSource('Reconnecting to the Local/LAN server');
        session = null;
        inFlight = false;
        pendingPush = false;
        deferredChat = [];
        activeWorldOperationId = null;
        rejectAtomicWorldOperations('正在重新连接局域网服务器');
        rejectOperations('正在重新连接局域网服务器');
        lastServerState = null;
        lastObservedLocalState = null;
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
            operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
            statusSchema: STATUS_SCHEMA_VERSION,
            accessSchema: ACCESS_SCHEMA_VERSION,
            name: sanitizeMultiplayerName(name),
            requestedRole: normalizeRequestedRole(requestedRole),
            joinCode,
            gmSecret,
            userId: isPlayer ? saved('userId', '') : '',
            authToken: isPlayer ? saved('authToken', '') : '',
            claimCode: isPlayer ? submittedPlayerKey : '',
            visionSourceTokenId: saved('visionSourceTokenId', ''),
          });
        });
        ws.addEventListener('message', event => { if (socket === ws) handleMessage(event); });
        ws.addEventListener('error', () => {
          if (socket !== ws) return;
          setMapStatus('联机连接失败，请确认主机 Server 与网络地址');
        });
        ws.addEventListener('close', () => {
          if (socket !== ws) return;
          socket = null;
          remoteEpoch += 1;
          connected = false;
          joining = false;
          setActiveVisionSource(null);
          session = null;
          inFlight = false;
          pendingPush = false;
          rejectVisionSource('Local/LAN connection closed');
          deferredChat = [];
          activeWorldOperationId = null;
          rejectAtomicWorldOperations('局域网连接已断开，未确认的 World 操作已取消');
          rejectOperations('局域网连接已断开，未确认的操作已取消');
          lastServerState = null;
          lastObservedLocalState = null;
          renderButton();
          publishCapabilities();
          if (!intentionalClose) setMapStatus('多人连接已断开 · 点击“联机”重新连接');
        });
      }

      function disconnect() {
        intentionalClose = true;
        remoteEpoch += 1;
        if (socket) { try { socket.close(); } catch {} }
        socket = null;
        connected = false;
        joining = false;
        setActiveVisionSource(null);
        session = null;
        rejectVisionSource('Local/LAN connection closed');
        inFlight = false;
        pendingPush = false;
        deferredChat = [];
        activeWorldOperationId = null;
        rejectAtomicWorldOperations('已主动断开局域网连接，未确认的 World 操作已取消');
        rejectOperations('已主动断开局域网连接，未确认的操作已取消');
        lastServerState = null;
        lastObservedLocalState = null;
        renderButton();
        hideDialog();
        publishCapabilities();
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

      function collectPlacementGrants(form) {
        const grants = { actorTypes: [], actorIds: [], markerKinds: [] };
        for (const input of form.querySelectorAll('[data-mp-placement-grant]:checked')) {
          const key = input.dataset.mpPlacementGrant;
          if (Object.hasOwn(grants, key)) grants[key].push(String(input.value));
        }
        return grants;
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
            placementGrants: collectPlacementGrants(target),
          });
          return;
        }

        if (target.matches('[data-mp-self-default]')) {
          send({ type: 'access.self.default', actorId: String(form.get('defaultActorId') || '') });
        }
      });

      api.on('state:commit', detail => {
        localCommitSerial += 1;
        queueCommittedOperations(detail?.state || api.exportState(), detail?.source || 'state:commit');
      });
      api.on('state:saved', () => {
        if (lastSavedCommitSerial < localCommitSerial) {
          lastSavedCommitSerial = localCommitSerial;
          return;
        }
        queueCommittedOperations(api.exportState(), 'state:saved');
      });
      api.on('state:import', detail => {
        if (!connected || session?.role !== 'gm') return;
        performWorldOperation(detail?.state || api.exportState(), {
          reason: `file-import:${String(detail?.source || 'import').slice(0, 40)}`,
        }).catch(error => setMapStatus(`Import sync failed: ${error.message}`));
      });

      api.multiplayer = {
        connect,
        disconnect,
        requestWorld: () => send({ type: 'world.snapshot.request' }),
        requestAccess: () => send({ type: 'access.request' }),
        appendChat,
        appendChatAfterWorld,
        performStatusOperation,
        performOperations,
        performStateOperation,
        performWorldOperation,
        setVisionSource,
        getVisionSource: () => activeVisionSourceTokenId,
        clearChat: () => {
          if (!connected) return false;
          performOperations([{ type: 'chat.clear', payload: {} }], { kind: 'chat' })
            .catch(error => setMapStatus(`清空聊天失败：${error.message}`));
          return true;
        },
        getCapabilities,
        canControlActor: actorId => canControlActor({ actorId, state: api.getState(), permissions }),
        canControlToken: tokenId => {
          if (session?.role === 'gm') return true;
          const token = api.tokens?.get?.(tokenId);
          if (!token) return false;
          if ((token.controllerUserIds || []).map(String).includes(String(session?.userId || ''))) return true;
          const actor = api.world?.get?.()?.actors?.find(item => String(item?.id) === String(token.actorId));
          return actor?.type === 'pc' && canControlActor({ actorId: actor.id, state: api.getState(), permissions });
        },
        canObserveActor: actorId => session?.role === 'gm' || (permissions.actorObserverIds || []).map(String).includes(String(actorId)),
        canViewLimitedActor: actorId => session?.role === 'gm' || (permissions.actorLimitedIds || []).map(String).includes(String(actorId)),
        getActorAccessLevel: actorId => {
          if (session?.role === 'gm') return 'owner';
          const id = String(actorId ?? '');
          if ((permissions.actorOwnerIds || []).map(String).includes(id)) return 'owner';
          if ((permissions.actorObserverIds || []).map(String).includes(id)) return 'observer';
          if ((permissions.actorLimitedIds || []).map(String).includes(id)) return 'limited';
          return 'none';
        },
        getStatus: () => ({
          connected,
          joining,
          revision,
          audienceRevision,
          visionSourceTokenId: activeVisionSourceTokenId,
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
