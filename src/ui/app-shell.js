import { latLngToWorld } from '../engine/geometry.js';
import { resolveActor } from '../entities/resolver.js';
import { findSelectedEntity, isMovementStatus, selectionStatus } from './model.js';
import { installStatusUiStyles, renderStatusStrip, resolveStatusUiSnapshot } from '../status/ui.js';

const STYLE_ID = 'rpgmap-app-shell-ui-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .app-shell.ui-vtt-shell { grid-template-rows:auto 1fr auto; min-height:100vh; }
    .ui-vtt-shell .topbar { gap:14px; padding:9px 14px; align-items:center; }
    .ui-vtt-shell .brand-copy p { display:none; }
    .ui-vtt-shell .brand-copy h1 { font-size:15px; white-space:nowrap; }
    .ui-vtt-shell .toolbar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    .ui-vtt-shell .toolbar-right { display:flex; gap:6px; align-items:center; margin-left:auto; }
    .ui-vtt-shell .ui-primary-tool {
      min-height:34px; display:inline-flex; align-items:center; justify-content:center; gap:5px;
      border:1px solid rgba(79,96,98,.22); border-radius:8px; padding:6px 10px;
      color:#334347; background:#f7f9f6; font:inherit; font-weight:750; cursor:pointer; list-style:none;
    }
    .ui-vtt-shell .ui-primary-tool:hover { background:#eef4f0; }
    .ui-vtt-shell .ui-primary-tool.active { color:#fff; background:#176d76; border-color:#176d76; }
    .ui-menu-trigger.active { color:#176d76; border-color:rgba(23,109,118,.5); background:#edf6f4; }
    .ui-menu-popover { position:fixed; z-index:5300; min-width:155px; padding:5px; border:1px solid rgba(60,80,80,.22); border-radius:9px; background:#fff; box-shadow:0 10px 28px rgba(20,30,30,.18); display:grid; gap:3px; }
    /* The author display:grid rule above wins over the browser's [hidden]
       rule unless we explicitly restore it.  Without this, closed portal
       menus remain visible and can intercept map clicks. */
    .ui-menu-popover[hidden] { display:none !important; }
    .ui-menu-popover button { border:0; border-radius:6px; padding:8px 9px; text-align:left; background:transparent; color:#354347; font:inherit; cursor:pointer; }
    .ui-menu-popover button:hover { background:#eef4f0; }
    .ui-menu-popover .danger { color:#a43b34; }
    .ui-legacy-action-proxy { display:none !important; }
    .ui-vtt-shell .sidebar .tabbar { display:grid; grid-template-columns:1fr 1fr; gap:5px; padding:8px; }
    .ui-vtt-shell .sidebar .ui-sidebar-tab { border:0; border-radius:7px; padding:8px 10px; background:#edf1ee; color:#556265; font-weight:800; cursor:pointer; }
    .ui-vtt-shell .sidebar .ui-sidebar-tab.active { color:#fff; background:#176d76; }
    .ui-vtt-shell [data-panel="markers"] { display:none !important; }
    .ui-current-inspector { display:grid; gap:10px; }
    .ui-current-empty { padding:24px 10px; text-align:center; color:#718083; line-height:1.6; }
    .ui-inspector-card { border:1px solid rgba(70,90,90,.18); border-radius:10px; padding:11px; background:#fff; display:grid; gap:9px; }
    .ui-inspector-head { display:flex; gap:10px; align-items:center; }
    .ui-inspector-avatar, .ui-inspector-avatar img { width:48px; height:48px; border-radius:50%; object-fit:cover; }
    .ui-inspector-avatar { display:grid; place-items:center; background:#176d76; color:#fff; font-weight:850; overflow:hidden; flex:0 0 auto; }
    .ui-inspector-name { min-width:0; flex:1; }
    .ui-inspector-name strong { display:block; font-size:15px; overflow:hidden; text-overflow:ellipsis; }
    .ui-inspector-name small { color:#6b787a; }
    .ui-resource-mini { display:grid; grid-template-columns:62px 1fr auto; gap:7px; align-items:center; font-size:12px; }
    .ui-resource-mini .bar { height:6px; overflow:hidden; border-radius:5px; background:#e2e7e4; }
    .ui-resource-mini .bar span { display:block; height:100%; background:#3d9b63; }
    .ui-inspector-actions { display:flex; flex-wrap:wrap; gap:6px; }
    .ui-inspector-actions button { min-height:30px; }
    .ui-token-meta { display:grid; grid-template-columns:1fr 1fr; gap:7px; font-size:12px; color:#536164; }
    .ui-token-meta div { padding:7px 8px; border-radius:7px; background:#f1f4f2; }
    .ui-statusbar { min-height:32px; display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:14px; align-items:center; padding:6px 12px; border-top:1px solid rgba(65,85,85,.2); background:#f8faf7; color:#536164; font-size:12px; }
    .ui-statusbar .ui-status-main { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .ui-statusbar .ui-status-selection { color:#176d76; font-weight:800; }
    .ui-statusbar .ui-status-hints { color:#778385; white-space:nowrap; }
    .ui-vtt-shell [data-role="map-status"] { display:none !important; }
    .ui-vtt-shell .fvtt-distance-step-control { display:none !important; }
    .ui-vtt-shell.ui-movement-active .fvtt-distance-step-control { display:inline-flex !important; top:12px; right:12px; }
    .ui-vtt-shell .fvtt-move-confirm { bottom:18px !important; }
    .ui-context-menu { position:fixed; z-index:5200; width:185px; padding:5px; border:1px solid rgba(50,70,70,.24); border-radius:9px; background:#fff; box-shadow:0 12px 34px rgba(15,25,25,.24); display:grid; gap:3px; }
    .ui-context-menu button { border:0; border-radius:6px; padding:8px 9px; text-align:left; background:transparent; color:#354347; font:inherit; cursor:pointer; }
    .ui-context-menu button:hover { background:#edf3ef; }
    .ui-context-menu button.danger { color:#a23c35; }
    .ui-context-separator { height:1px; margin:3px 2px; background:#e3e8e5; }
    @media (max-width:900px) {
      .ui-statusbar { grid-template-columns:1fr auto; }
      .ui-statusbar .ui-status-hints { display:none; }
      .ui-vtt-shell .brand-copy { display:none; }
    }
  `;
  documentNode.head.append(style);
}

function button(documentNode, label, onClick, className = 'ui-primary-tool') {
  const node = documentNode.createElement('button');
  node.type = 'button'; node.className = className; node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function menu(documentNode, label, items) {
  const trigger = button(documentNode, label, null, 'ui-primary-tool ui-menu-trigger');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const popover = documentNode.createElement('div'); popover.className = 'ui-menu-popover';
  popover.hidden = true;
  popover.setAttribute('role', 'menu');
  let open = false;
  const close = () => {
    if (!open) return;
    open = false;
    popover.hidden = true;
    trigger.classList.remove('active');
    trigger.setAttribute('aria-expanded', 'false');
  };
  const position = () => {
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    popover.style.top = `${Math.min(window.innerHeight - popover.offsetHeight - margin, rect.bottom + 6)}px`;
    popover.style.left = `${Math.max(margin, Math.min(window.innerWidth - popover.offsetWidth - margin, rect.left))}px`;
  };
  const show = () => {
    open = true;
    documentNode.body.append(popover);
    popover.hidden = false;
    trigger.classList.add('active');
    trigger.setAttribute('aria-expanded', 'true');
    position();
  };
  trigger.addEventListener('click', event => { event.preventDefault(); open ? close() : show(); });
  for (const item of items) {
    if (item.separator) { const hr = documentNode.createElement('div'); hr.className = 'ui-context-separator'; popover.append(hr); continue; }
    const itemButton = documentNode.createElement('button'); itemButton.type = 'button'; itemButton.textContent = item.label;
    if (item.danger) itemButton.classList.add('danger');
    itemButton.addEventListener('click', event => { event.preventDefault(); close(); item.action?.(); });
    popover.append(itemButton);
  }
  documentNode.addEventListener('pointerdown', event => {
    if (open && !popover.contains(event.target) && !trigger.contains(event.target)) close();
  }, true);
  documentNode.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  window.addEventListener('resize', () => { if (open) position(); });
  return trigger;
}

function findNearestCharacter(api, event) {
  const point = latLngToWorld(api.map.mouseEventToLatLng(event), api.mapPackage.height);
  let best = null; let distance = Infinity;
  for (const character of api.getState().characters || []) {
    if (character.location?.type !== 'map' || character.visible === false) continue;
    const next = Math.hypot(character.location.x - point.x, character.location.y - point.y);
    if (next < distance) { best = character; distance = next; }
  }
  return best;
}

function tokenAvatar(selection) {
  const avatar = selection?.form?.avatarDataUrl;
  if (avatar) return `<span class="ui-inspector-avatar"><img src="${escapeHtml(avatar)}" alt=""></span>`;
  return `<span class="ui-inspector-avatar">${escapeHtml(selection?.actor?.name?.trim()?.[0] || '?')}</span>`;
}

export function createAppShellUi() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell');
      if (!shell) return;
      installStyles(documentNode);
      installStatusUiStyles(documentNode);
      shell.classList.add('ui-vtt-shell');

      let selectedTokenId = null;
      let currentPanelName = 'current';
      let contextMenu = null;

      const topToolbar = shell.querySelector('.toolbar');
      const toolbarRight = shell.querySelector('.toolbar-right');
      const tabbar = shell.querySelector('.sidebar .tabbar');
      const panelStack = shell.querySelector('.sidebar .panel-stack');
      const statusSource = shell.querySelector('[data-role="map-status"]');

      function canManageWorld() {
        const capabilities = api.multiplayer?.getCapabilities?.();
        return !capabilities?.connected || capabilities.canManageWorld === true;
      }
      function requireWorldManager() {
        if (canManageWorld()) return true;
        if (statusSource) statusSource.textContent = '只有 GM 可以修改共享 World';
        return false;
      }
      function syncCapabilities() {
        const allowed = canManageWorld();
        shell.querySelectorAll('[data-capability="manage-world"]').forEach(node => { node.hidden = !allowed; });
      }

      shell.querySelector('[data-tab="markers"]')?.remove();
      shell.querySelector('[data-panel="markers"]')?.remove();

      const legacyProxy = documentNode.createElement('div'); legacyProxy.className = 'ui-legacy-action-proxy';
      const legacyActions = [...(toolbarRight?.querySelectorAll('[data-action], [data-role="import-file"]') || [])];
      legacyActions.forEach(node => legacyProxy.append(node));
      shell.append(legacyProxy);

      function activatePanel(name) {
        // The replacement sidebar used to only toggle CSS classes.  After a
        // Feature/scene operation the core still believed that its old panel
        // was active, so a later render could resurrect the retired marker
        // editor.  Synchronize real map panels first; “当前” is shell-only.
        // Opening the library is also an explicit exit from a map-operation
        // workflow.  Leaving Inspect active here made the next map click look
        // like a continuation of the building operation.
        if (name === 'characters') api.setTool('pan');
        if (name !== 'current') api.setActivePanel?.(name);
        currentPanelName = name;
        shell.querySelectorAll('.sidebar [data-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === name));
        shell.querySelectorAll('.ui-sidebar-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.uiSidebar === (name === 'characters' ? 'library' : 'current')));
        if (name === 'current') renderCurrent();
      }

      let currentPanel = shell.querySelector('[data-panel="current"]');
      if (!currentPanel) {
        currentPanel = documentNode.createElement('section'); currentPanel.className = 'panel'; currentPanel.dataset.panel = 'current';
        panelStack?.prepend(currentPanel);
      }

      if (tabbar) {
        tabbar.replaceChildren();
        const libraryTab = button(documentNode, '角色库', () => activatePanel('characters'), 'ui-sidebar-tab'); libraryTab.dataset.uiSidebar = 'library';
        const currentTab = button(documentNode, '当前', () => activatePanel('current'), 'ui-sidebar-tab'); currentTab.dataset.uiSidebar = 'current';
        tabbar.append(libraryTab, currentTab);
      }

      function openCurrentTool(panelName, toolName = null) {
        if (toolName) api.setTool(toolName);
        activatePanel(panelName);
      }

      function legacyAction(selector) {
        legacyProxy.querySelector(selector)?.click();
      }

      if (topToolbar) {
        topToolbar.replaceChildren();
        const select = button(documentNode, '选择', () => { api.setTool('pan'); activatePanel('current'); });
        select.dataset.uiMainTool = 'select'; select.classList.add('active');
        const measure = menu(documentNode, '测量 ▾', [
          { label: '两点测距', action: () => openCurrentTool('measure', 'distance') },
          { label: '路线测距', action: () => openCurrentTool('measure', 'route') },
        ]);
        const range = menu(documentNode, '范围 ▾', [
          { label: '范围工具', action: () => { if (requireWorldManager()) openCurrentTool('areas', 'aoe'); } },
        ]);
        range.dataset.capability = 'manage-world';
        const scene = menu(documentNode, '场景 ▾', [
          { label: '检查地物', action: () => { if (requireWorldManager()) openCurrentTool('inspect', 'inspect'); } },
          { label: '图层', action: () => { if (requireWorldManager()) openCurrentTool('layers'); } },
          { separator: true },
          { label: '撤销场景变化', action: () => { if (requireWorldManager()) legacyAction('[data-action="undo-scene"]'); } },
        ]);
        scene.dataset.capability = 'manage-world';
        topToolbar.append(select, measure, range, scene);
      }

      if (toolbarRight) {
        const entityImport = toolbarRight.querySelector('.entity-toolbar-button');
        if (entityImport) { entityImport.textContent = '+ 导入角色'; entityImport.classList.add('ui-primary-tool'); }
        const saveMenu = menu(documentNode, '存档 ▾', [
          { label: '导出存档', action: () => legacyAction('[data-action="export"]') },
          { label: '导入存档', action: () => { if (requireWorldManager()) legacyAction('[data-action="import"]'); } },
          { separator: true },
          { label: '定位所选', action: () => legacyAction('[data-action="focus-selected"]') },
          { label: '回到底图', action: () => legacyAction('[data-action="reset-view"]') },
        ]);
        saveMenu.dataset.capability = 'manage-world';
        toolbarRight.append(saveMenu);
      }

      api.on('multiplayer:capabilities', syncCapabilities);
      syncCapabilities();

      const statusbar = documentNode.createElement('footer'); statusbar.className = 'ui-statusbar';
      statusbar.innerHTML = '<span class="ui-status-main">浏览模式</span><span class="ui-status-selection">未选择 Token</span><span class="ui-status-hints">拖 Token 移动 · V 切换形态 · 双击打开角色卡</span>';
      shell.append(statusbar);
      const statusMain = statusbar.querySelector('.ui-status-main');
      const statusSelection = statusbar.querySelector('.ui-status-selection');

      function currentSelection() { return findSelectedEntity(api.getState(), selectedTokenId); }
      function syncStatus() {
        const message = statusSource?.textContent?.trim() || '浏览模式';
        statusMain.textContent = message;
        const selection = currentSelection(); statusSelection.textContent = selectionStatus(selection);
        shell.classList.toggle('ui-movement-active', isMovementStatus(message));
      }
      if (statusSource) new MutationObserver(syncStatus).observe(statusSource, { childList: true, subtree: true, characterData: true });

      function renderCurrent() {
        if (!currentPanel) return;
        const selection = currentSelection();
        if (!selection) {
          currentPanel.innerHTML = '<div class="ui-current-inspector"><div class="ui-current-empty"><b>当前对象</b><br>单击 Token 查看快速状态；双击打开完整角色卡。<br>地图工具的参数也会在这里显示。</div></div>';
          return;
        }
        const resolved = resolveActor(selection.actor);
        const resources = (resolved?.resources || []).map(resource => {
          const ratio = resource.max > 0 ? Math.max(0, Math.min(100, resource.current / resource.max * 100)) : 0;
          return `<div class="ui-resource-mini"><span>${escapeHtml(resource.name)}</span><div class="bar"><span style="width:${ratio}%"></span></div><b>${resource.current} / ${resource.max}</b></div>`;
        }).join('');
        const location = selection.character?.location;
        const position = location?.type === 'map' ? `${Math.round(location.x)}, ${Math.round(location.y)}` : location?.type === 'building' ? `建筑 ${location.featureId}` : '未放置';
        const statusSnapshot = resolveStatusUiSnapshot(api, {
          actorId: selection.actor.id,
          tokenId: selection.token.id,
          characterId: selection.character?.id || selection.token.characterId,
        });
        currentPanel.innerHTML = `<div class="ui-current-inspector">
          <section class="ui-inspector-card">
            <div class="ui-inspector-head">${tokenAvatar(selection)}<div class="ui-inspector-name"><strong>${escapeHtml(selection.actor.name)}</strong><small>${escapeHtml(selection.form?.name || '默认形态')}</small></div></div>
            <div class="ui-status-summary">${renderStatusStrip(statusSnapshot.statuses, { limit: 6, emptyText: '无机械状态' })}</div>
            ${resources}
            <div class="ui-inspector-actions">
              <button type="button" class="small-button primary" data-ui-current-action="sheet">打开角色卡</button>
              ${selection.actor.forms?.length > 1 ? '<button type="button" class="small-button" data-ui-current-action="form">V · 切换形态</button>' : ''}
              <button type="button" class="small-button" data-ui-current-action="lock">${selection.token.locked ? '解锁 Token' : '锁定 Token'}</button>
            </div>
          </section>
          <section class="ui-inspector-card"><strong>Token</strong><div class="ui-token-meta"><div>位置<br><b>${escapeHtml(position)}</b></div><div>状态<br><b>${selection.token.locked ? '锁定' : '可移动'}</b></div></div></section>
        </div>`;
      }

      function openActorSheet(selection = currentSelection()) {
        if (!selection) return;
        activatePanel('characters');
        queueMicrotask(() => shell.querySelector(`[data-entity-action="open"][data-id="${CSS.escape(String(selection.actor.id))}"]`)?.click());
      }

      function cycleSelectedForm() {
        const selection = currentSelection();
        if (!selection?.actor?.forms?.length || selection.actor.forms.length < 2) return;
        documentNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true }));
        queueMicrotask(() => { renderCurrent(); syncStatus(); });
      }

      function setTokenLocked(locked) {
        const selection = currentSelection(); if (!selection) return;
        const appState = api.getState();
        const token = appState.preferences?.entitySystem?.tokens?.find(item => String(item.id) === String(selection.token.id) || String(item.characterId) === String(selection.token.characterId));
        if (!token) return;
        token.locked = Boolean(locked);
        api.importState(appState);
        queueMicrotask(() => { selectedTokenId = selection.character?.id || selection.token.characterId || selection.token.id; api.selectCharacter?.(selectedTokenId); activatePanel('current'); renderCurrent(); syncStatus(); });
      }

      currentPanel?.addEventListener('click', event => {
        const action = event.target.closest('[data-ui-current-action]')?.dataset.uiCurrentAction;
        if (action === 'sheet') openActorSheet();
        else if (action === 'form') cycleSelectedForm();
        else if (action === 'lock') setTokenLocked(!currentSelection()?.token?.locked);
      });

      function closeContextMenu() { contextMenu?.remove(); contextMenu = null; }
      function removeSelectedToken() {
        const selection = currentSelection(); if (!selection || !confirm(`将“${selection.actor.name}”的这个 Token 移出地图？角色数据会保留。`)) return;
        const appState = api.getState();
        const characterId = String(selection.character?.id || selection.token.characterId || selection.token.id);
        appState.characters = (appState.characters || []).filter(item => String(item.id) !== characterId);
        if (appState.preferences?.entitySystem?.tokens) appState.preferences.entitySystem.tokens = appState.preferences.entitySystem.tokens.filter(item => String(item.characterId || item.id) !== characterId);
        for (const area of appState.attackAreas || []) if (area.anchor?.type === 'character' && String(area.anchor.characterId) === characterId) area.anchor = { type: 'free', markerId: null };
        selectedTokenId = null; api.importState(appState); activatePanel('current'); renderCurrent(); syncStatus();
      }

      function showTokenContextMenu(event, selection) {
        closeContextMenu();
        const characterId = String(selection.character?.id || selection.token.characterId || selection.token.id || '');
        const node = documentNode.createElement('div'); node.className = 'ui-context-menu';
        const entries = [
          ['打开角色卡', () => openActorSheet(selection)],
          ...(selection.actor.forms?.length > 1 ? [['切换形态  V', cycleSelectedForm]] : []),
          ['调整高度', () => api.elevation?.openTokenElevationEditor?.(characterId, event)],
          [selection.token.locked ? '解锁 Token' : '锁定 Token', () => setTokenLocked(!selection.token.locked)],
          ['separator', null],
          ['移出地图', removeSelectedToken, 'danger'],
        ];
        for (const [label, action, className] of entries) {
          if (label === 'separator') { const sep = documentNode.createElement('div'); sep.className = 'ui-context-separator'; node.append(sep); continue; }
          const item = button(documentNode, label, () => { closeContextMenu(); action?.(); }, ''); if (className) item.className = className; node.append(item);
        }
        node.style.left = `${Math.min(event.clientX, innerWidth - 205)}px`; node.style.top = `${Math.min(event.clientY, innerHeight - 190)}px`;
        documentNode.body.append(node); contextMenu = node;
      }

      documentNode.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const tokenNode = event.target.closest?.('.rpg-character, .rpg-character-core'); if (!tokenNode) return;
        const character = findNearestCharacter(api, event); if (!character) return;
        const selection = findSelectedEntity(api.getState(), character.id);
        if (!selection?.token?.locked) return;
        event.preventDefault(); event.stopImmediatePropagation();
        selectedTokenId = character.id; api.selectCharacter?.(character.id); activatePanel('current'); renderCurrent();
        if (statusSource) statusSource.textContent = `Token 已锁定：${selection.actor.name} · 右键可解锁`;
      }, true);

      documentNode.addEventListener('contextmenu', event => {
        if (shell.classList.contains('ui-movement-active')) return;
        const tokenNode = event.target.closest?.('.rpg-character, .rpg-character-core'); if (!tokenNode) return;
        const character = findNearestCharacter(api, event); if (!character) return;
        const selection = findSelectedEntity(api.getState(), character.id); if (!selection) return;
        event.preventDefault(); event.stopImmediatePropagation(); selectedTokenId = character.id; api.selectCharacter?.(character.id); activatePanel('current'); renderCurrent(); showTokenContextMenu(event, selection);
      }, true);
      documentNode.addEventListener('pointerdown', event => { if (contextMenu && !event.target.closest('.ui-context-menu')) closeContextMenu(); });
      window.addEventListener('blur', closeContextMenu);

      api.on('character:select', event => { selectedTokenId = event.detail?.id || null; if (currentPanelName === 'current') renderCurrent(); syncStatus(); });
      api.on('character:create', event => { selectedTokenId = event.detail?.id || selectedTokenId; if (currentPanelName === 'current') renderCurrent(); syncStatus(); });
      api.on('character:delete', event => { if (String(event.detail?.id) === String(selectedTokenId)) selectedTokenId = null; renderCurrent(); syncStatus(); });
      api.on('character:move', () => { if (currentPanelName === 'current') renderCurrent(); syncStatus(); });
      api.on('state:import', () => { if (currentPanelName === 'current') renderCurrent(); syncStatus(); });
      api.on('status:change', () => { if (currentPanelName === 'current') renderCurrent(); syncStatus(); });

      activatePanel('characters');
      syncStatus();
    },
  };
}
