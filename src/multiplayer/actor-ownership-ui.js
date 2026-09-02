const STYLE_ID = 'rpgmap-actor-ownership-style';
const LEVELS = Object.freeze(['none', 'limited', 'observer', 'owner']);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function normalizeLevel(value) {
  const level = String(value || 'none').toLowerCase();
  return LEVELS.includes(level) ? level : 'none';
}

export function actorOwnershipRows(access = {}, actorId) {
  const id = String(actorId || '');
  return (Array.isArray(access.users) ? access.users : []).map(user => {
    const defaultActor = String(user?.defaultActorId || '') === id;
    return Object.freeze({
      userId: String(user?.id || ''),
      name: String(user?.name || user?.id || 'Player'),
      online: user?.online === true,
      disabled: user?.disabled === true,
      defaultActor,
      level: defaultActor ? 'owner' : normalizeLevel(user?.ownership?.[id]),
    });
  }).filter(row => row.userId);
}

export function actorOwnershipCatalogReady(access = {}, actorId) {
  const id = String(actorId || '');
  return Boolean(id && (Array.isArray(access.actors) ? access.actors : [])
    .some(actor => String(actor?.id || '') === id));
}

export function buildActorOwnershipChanges(access = {}, actorId, requestedLevels = {}) {
  const changes = [];
  for (const row of actorOwnershipRows(access, actorId)) {
    if (row.defaultActor) continue;
    const next = normalizeLevel(requestedLevels[row.userId]);
    if (next === row.level) continue;
    changes.push(Object.freeze({ userId: row.userId, actorId: String(actorId), level: next }));
  }
  return Object.freeze(changes);
}

function installStyles(documentNode) {
  if (!documentNode || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .actor-ownership-backdrop { position:fixed; inset:0; z-index:5400; display:grid; place-items:center; padding:18px; background:rgba(18,23,24,.52); }
    .actor-ownership-backdrop[hidden] { display:none !important; }
    .actor-ownership-dialog { width:min(620px,94vw); max-height:88vh; overflow:auto; padding:18px; border:1px solid rgba(40,70,70,.28); border-radius:14px; background:#f8faf7; box-shadow:0 22px 70px rgba(0,0,0,.32); display:grid; gap:13px; }
    .actor-ownership-dialog h2 { margin:0; font-size:18px; }
    .actor-ownership-dialog p { margin:0; color:#647174; font-size:12px; line-height:1.55; }
    .actor-ownership-list { display:grid; gap:7px; }
    .actor-ownership-row { display:grid; grid-template-columns:minmax(150px,1fr) 160px; gap:10px; align-items:center; padding:9px 10px; border:1px solid #dce4e0; border-radius:9px; background:#fff; }
    .actor-ownership-user { min-width:0; display:flex; align-items:center; gap:7px; }
    .actor-ownership-user-copy { min-width:0; display:grid; }
    .actor-ownership-user-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .actor-ownership-user-copy small { color:#748083; }
    .actor-ownership-online { width:8px; height:8px; flex:0 0 auto; border-radius:50%; background:#aab2b0; }
    .actor-ownership-online.on { background:#3d9b63; }
    .actor-ownership-row select { width:100%; box-sizing:border-box; padding:7px 8px; border:1px solid #cbd5d2; border-radius:7px; background:#fff; }
    .actor-ownership-row select:disabled { background:#eef2ef; color:#677; }
    .actor-ownership-badge { display:inline-flex; width:max-content; margin-top:2px; padding:1px 5px; border-radius:999px; background:#e8f0ea; color:#52645c; font-size:9px; font-weight:800; }
    .actor-ownership-feedback { padding:8px 10px; border-radius:8px; background:#eef3ef; color:#526164; font-size:12px; }
    .actor-ownership-feedback.error { background:#fbe9e7; color:#9a302a; }
    .actor-ownership-actions { display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
    .actor-ownership-actions button { border:1px solid #b9c5c1; border-radius:8px; padding:8px 12px; background:#fff; cursor:pointer; font-weight:800; }
    .actor-ownership-actions button.primary { border-color:#176d76; background:#176d76; color:#fff; }
    [data-actor-ownership-open] { white-space:nowrap; }
    @media(max-width:560px) { .actor-ownership-row { grid-template-columns:1fr; } }
  `;
  documentNode.head?.append(style);
}

function canManageActorOwnership(api) {
  const status = api?.multiplayer?.getStatus?.();
  return Boolean(status?.connected && status?.session?.role === 'gm' && status?.access?.canManage === true);
}

function findUserForm(controllerOverlay, userId) {
  return [...(controllerOverlay?.querySelectorAll?.('[data-mp-user-form]') || [])]
    .find(form => String(form.dataset?.userId || '') === String(userId)) || null;
}

function findActorPermissionSelect(form, actorId) {
  return [...(form?.querySelectorAll?.('[data-mp-actor-permission]') || [])]
    .find(select => String(select.dataset?.mpActorPermission || '') === String(actorId)) || null;
}

/**
 * The access controller remains the single WebSocket writer for users.json.
 * Until it exposes a public access mutation method, reuse its already validated
 * dashboard submit path instead of opening a second socket or duplicating auth.
 */
export function submitActorOwnershipChanges(documentNode, changes = []) {
  if (!changes.length) return 0;
  const toolbar = documentNode?.querySelector?.('.multiplayer-toolbar');
  const controllerOverlay = documentNode?.querySelector?.('.multiplayer-backdrop');
  if (!toolbar || !controllerOverlay) throw new Error('联机权限控制器尚未初始化');

  const wasHidden = controllerOverlay.hidden === true;
  const previousVisibility = controllerOverlay.style.visibility;
  if (wasHidden) controllerOverlay.style.visibility = 'hidden';
  toolbar.click();

  const EventCtor = documentNode.defaultView?.Event || globalThis.Event;
  let submitted = 0;
  try {
    for (const change of changes) {
      const form = findUserForm(controllerOverlay, change.userId);
      const select = findActorPermissionSelect(form, change.actorId);
      if (!form || !select) throw new Error(`无法找到 Player ${change.userId} 的 Actor 权限表单`);
      select.value = normalizeLevel(change.level);
      form.dispatchEvent(new EventCtor('submit', { bubbles: true, cancelable: true }));
      submitted += 1;
    }
  } finally {
    if (wasHidden) {
      const close = controllerOverlay.querySelector?.('[data-mp-close]');
      if (close) close.click();
      else {
        controllerOverlay.hidden = true;
        controllerOverlay.style.display = 'none';
      }
    }
    controllerOverlay.style.visibility = previousVisibility;
  }
  return submitted;
}

function levelOptions(selected) {
  const labels = { none: 'NONE', limited: 'LIMITED', observer: 'OBSERVER', owner: 'OWNER' };
  return LEVELS.map(level => `<option value="${level}" ${selected === level ? 'selected' : ''}>${labels[level]}</option>`).join('');
}

export function createActorOwnershipUi() {
  return Object.freeze({
    register(api) {
      const mapElement = api?.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document;
      if (!documentNode?.body) return;
      installStyles(documentNode);

      const overlay = documentNode.createElement('div');
      overlay.className = 'actor-ownership-backdrop';
      overlay.hidden = true;
      documentNode.body.append(overlay);

      let actorId = null;
      let feedback = '';
      let feedbackError = false;

      function statusAccess() {
        return api.multiplayer?.getStatus?.()?.access || { users: [], actors: [], canManage: false };
      }

      function actorRecord() {
        const id = String(actorId || '');
        return (statusAccess().actors || []).find(actor => String(actor?.id || '') === id)
          || api.world?.get?.()?.actors?.find(actor => String(actor?.id || '') === id)
          || null;
      }

      function close() {
        actorId = null;
        feedback = '';
        feedbackError = false;
        overlay.hidden = true;
        overlay.replaceChildren();
      }

      function render() {
        if (!actorId || !canManageActorOwnership(api)) { close(); return; }
        const access = statusAccess();
        const actor = actorRecord();
        if (!actor) { close(); return; }
        const rows = actorOwnershipRows(access, actorId);
        const catalogReady = actorOwnershipCatalogReady(access, actorId);
        const notice = feedback || (!catalogReady ? '正在同步 Actor 权限目录，完成前不会提交旧快照。' : '');
        overlay.innerHTML = `<form class="actor-ownership-dialog" data-actor-ownership-form data-actor-id="${escapeHtml(actorId)}">
          <h2>${escapeHtml(actor.name || actorId)} · 权限</h2>
          <p>这里以 Actor 为中心配置 Player 的角色卡访问级别。Token 的地图可见性与 <code>controllerUserIds</code> 仍由 Token 设置独立管理，不会因为这里设为 OWNER 就自动取得怪物/NPC/召唤物实例控制权。</p>
          ${notice ? `<div class="actor-ownership-feedback ${feedbackError ? 'error' : ''}">${escapeHtml(notice)}</div>` : ''}
          <div class="actor-ownership-list">${rows.length ? rows.map(row => `<label class="actor-ownership-row">
            <span class="actor-ownership-user"><span class="actor-ownership-online ${row.online ? 'on' : ''}"></span><span class="actor-ownership-user-copy"><strong>${escapeHtml(row.name)}</strong><small>${row.online ? '在线' : '离线'}${row.disabled ? ' · 已禁用' : ''}</small>${row.defaultActor ? '<span class="actor-ownership-badge">默认角色 · 必须 OWNER</span>' : ''}</span></span>
            <select data-actor-ownership-user="${escapeHtml(row.userId)}" ${row.defaultActor ? 'disabled' : ''}>${levelOptions(row.level)}</select>
          </label>`).join('') : '<div class="actor-ownership-feedback">还没有正式 Player User。请先在“联机 / Users”中创建或批准玩家。</div>'}</div>
          <div class="actor-ownership-actions"><button type="button" data-actor-ownership-refresh>刷新</button><button type="button" data-actor-ownership-close>取消</button><button type="submit" class="primary" ${rows.length && catalogReady ? '' : 'disabled'}>保存权限</button></div>
        </form>`;
        overlay.hidden = false;
      }

      function open(nextActorId) {
        if (!canManageActorOwnership(api)) return false;
        actorId = String(nextActorId || '');
        if (!actorId) return false;
        const openedActorId = actorId;
        feedback = '';
        feedbackError = false;
        api.multiplayer?.requestAccess?.();
        render();
        setTimeout(() => { if (actorId === openedActorId) render(); }, 180);
        return true;
      }

      function decorateActorUi() {
        const allowed = canManageActorOwnership(api);
        for (const button of documentNode.querySelectorAll('[data-actor-ownership-open]')) {
          if (!allowed) button.remove();
        }
        if (!allowed) return;

        for (const card of documentNode.querySelectorAll('.entity-card[data-actor-id]')) {
          const actions = card.querySelector('.entity-card-actions');
          if (!actions || actions.querySelector('[data-actor-ownership-open]')) continue;
          const button = documentNode.createElement('button');
          button.type = 'button';
          button.className = 'small-button';
          button.dataset.actorOwnershipOpen = String(card.dataset.actorId || '');
          button.textContent = '权限';
          button.title = '按 Actor 配置 Player 的 NONE / LIMITED / OBSERVER / OWNER';
          actions.append(button);
        }

        for (const sheet of documentNode.querySelectorAll('.entity-sheet[data-actor-id]')) {
          if (sheet.dataset.sheetMode === 'limited') continue;
          const header = sheet.querySelector('.entity-sheet-header');
          if (!header || header.querySelector('[data-actor-ownership-open]')) continue;
          const button = documentNode.createElement('button');
          button.type = 'button';
          button.className = 'small-button';
          button.dataset.actorOwnershipOpen = String(sheet.dataset.actorId || '');
          button.textContent = '权限';
          button.title = 'Actor Ownership';
          const closeButton = header.querySelector('[data-sheet-action="close"]');
          if (closeButton) header.insertBefore(button, closeButton);
          else header.append(button);
        }
      }

      const observer = new MutationObserver(() => queueMicrotask(decorateActorUi));
      observer.observe(documentNode.body, { childList: true, subtree: true });

      documentNode.addEventListener('click', event => {
        const openButton = event.target.closest?.('[data-actor-ownership-open]');
        if (openButton) {
          event.preventDefault();
          event.stopPropagation();
          open(openButton.dataset.actorOwnershipOpen);
          return;
        }
        if (event.target === overlay || event.target.closest?.('[data-actor-ownership-close]')) {
          close();
          return;
        }
        if (event.target.closest?.('[data-actor-ownership-refresh]')) {
          api.multiplayer?.requestAccess?.();
          feedback = '已请求服务器刷新 User / Ownership 快照。';
          feedbackError = false;
          setTimeout(() => { if (actorId) render(); }, 180);
        }
      });

      overlay.addEventListener('submit', event => {
        event.preventDefault();
        if (!actorId || !canManageActorOwnership(api)) { close(); return; }
        const access = statusAccess();
        if (!actorOwnershipCatalogReady(access, actorId)) {
          api.multiplayer?.requestAccess?.();
          feedback = 'Actor 权限目录仍在同步，请稍后再保存。';
          feedbackError = false;
          render();
          return;
        }
        const requested = {};
        for (const select of overlay.querySelectorAll('[data-actor-ownership-user]')) {
          requested[String(select.dataset.actorOwnershipUser || '')] = select.value;
        }
        const changes = buildActorOwnershipChanges(access, actorId, requested);
        if (!changes.length) {
          feedback = '权限没有变化。';
          feedbackError = false;
          render();
          return;
        }
        try {
          const submitted = submitActorOwnershipChanges(documentNode, changes);
          if (submitted !== changes.length) throw new Error('部分权限更新没有提交');
          api.multiplayer?.requestAccess?.();
          api.emit?.('multiplayer:actor-ownership-update', { actorId, changes: structuredClone(changes) });
          close();
        } catch (error) {
          feedback = `保存失败：${error?.message || error}`;
          feedbackError = true;
          render();
        }
      });

      api.multiplayer.openActorOwnership = open;
      api.multiplayer.closeActorOwnership = close;
      api.multiplayer.actorOwnershipRows = nextActorId => actorOwnershipRows(statusAccess(), nextActorId);

      api.on?.('multiplayer:capabilities', decorateActorUi);
      api.on?.('state:commit', decorateActorUi);
      api.on?.('app:destroy', () => {
        observer.disconnect();
        overlay.remove();
      });
      decorateActorUi();
    },
  });
}
