import { installStatusUiStyles, renderStatusStrip, resolveStatusUiSnapshot } from '../status/ui.js';
import { describeActor } from '../actor/index.js';

const STYLE_ID = 'rpgmap-app-shell-v2-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .runtime-v2-shell { grid-template-rows:auto 1fr auto; min-height:100vh; }
    .runtime-v2-shell .topbar { gap:14px; padding:9px 14px; align-items:center; }
    .runtime-v2-shell .brand-copy p { display:none; }
    .runtime-v2-shell .brand-copy h1 { font-size:15px; white-space:nowrap; }
    .runtime-v2-shell .toolbar, .runtime-v2-shell .toolbar-right { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    .runtime-v2-shell .toolbar-right { margin-left:auto; }
    .runtime-v2-shell .ui-primary-tool { min-height:34px; display:inline-flex; align-items:center; justify-content:center; gap:5px; border:1px solid rgba(79,96,98,.22); border-radius:8px; padding:6px 10px; color:#334347; background:#f7f9f6; font:inherit; font-weight:750; cursor:pointer; }
    .runtime-v2-shell .ui-primary-tool:hover { background:#eef4f0; }
    .runtime-v2-shell .ui-primary-tool.active { color:#fff; background:#176d76; border-color:#176d76; }
    .runtime-v2-shell .sidebar .tabbar { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; padding:8px; }
    .runtime-v2-shell .ui-sidebar-tab { border:0; border-radius:7px; padding:8px 10px; background:#edf1ee; color:#556265; font-weight:800; cursor:pointer; }
    .runtime-v2-shell .ui-sidebar-tab.active { color:#fff; background:#176d76; }
    .runtime-v2-shell .ui-current-card { border:1px solid rgba(70,90,90,.18); border-radius:10px; padding:11px; background:#fff; display:grid; gap:9px; }
    .runtime-v2-shell .ui-current-head { display:flex; gap:10px; align-items:center; }
    .runtime-v2-shell .ui-token-avatar { width:48px; height:48px; border-radius:50%; display:grid; place-items:center; overflow:hidden; background:#176d76; color:#fff; font-weight:850; flex:0 0 auto; }
    .runtime-v2-shell .ui-token-avatar img { width:100%; height:100%; object-fit:cover; }
    .runtime-v2-shell .ui-token-meta { display:grid; grid-template-columns:1fr 1fr; gap:7px; font-size:12px; color:#536164; }
    .runtime-v2-shell .ui-token-meta div { padding:7px 8px; border-radius:7px; background:#f1f4f2; }
    .runtime-v2-shell .ui-current-empty { padding:24px 10px; text-align:center; color:#718083; line-height:1.6; }
    .runtime-v2-shell .ui-actions { display:flex; flex-wrap:wrap; gap:6px; }
    .runtime-v2-shell .ui-file-input { display:none; }
    .entity-sheet-backdrop{background:transparent!important;pointer-events:none}
    .entity-sheet{position:fixed;left:24px;top:72px;resize:both;pointer-events:auto}
    .entity-sheet-header{cursor:move}
    @media(max-width:760px){.entity-sheet{left:8px!important;top:8px!important;width:calc(100vw - 16px)!important;height:calc(100vh - 16px)!important;max-height:none;resize:none}}
  `;
  documentNode.head.append(style);
}

function button(documentNode, label, action, className = 'ui-primary-tool') {
  const node = documentNode.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  if (action) node.addEventListener('click', action);
  return node;
}

function actorView(api, token) {
  try {
    const resolved = api.tokens.resolveActor(token.id);
    const actor = resolved.actor;
    const presentation = describeActor(actor, { ruleset: api.ruleset }) || {};
    return {
      actor,
      synthetic: resolved.synthetic === true,
      name: String(token.name || presentation.name || actor?.name || token.id),
      avatar: presentation.avatarDataUrl || null,
      color: presentation.color || '#176d76',
    };
  } catch {
    return { actor: null, synthetic: false, name: String(token.id), avatar: null, color: '#176d76' };
  }
}

function locationLabel(token) {
  if (token?.placement === 'feature') return `Feature ${token.featureId || '—'}`;
  if (token?.placement === 'map') return `x ${Number(token.x).toFixed(1)} · y ${Number(token.y).toFixed(1)}`;
  return '未放置';
}

export function createAppShellUiV2() {
  return Object.freeze({
    register(api) {
      if (!api?.tokens?.get || !api?.tokens?.resolveActor || !api?.selection) {
        throw new Error('AppShell V2 requires Token Runtime and Selection');
      }
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      installStyles(documentNode);
      installStatusUiStyles(documentNode);

      const toolbar = shell.querySelector('.toolbar');
      const toolbarRight = shell.querySelector('.toolbar-right');
      const tabbar = shell.querySelector('.sidebar .tabbar');
      const currentPanel = api.uiPanels?.get?.('current');
      const importInput = documentNode.createElement('input');
      importInput.type = 'file';
      importInput.accept = 'application/json,.json';
      importInput.className = 'ui-file-input';
      shell.append(importInput);

      function playerShell() {
        const capabilities = api.multiplayer?.getCapabilities?.();
        return capabilities?.connected === true && capabilities.role !== 'gm';
      }
      function openMyActor() {
        const actorId = api.multiplayer?.getStatus?.()?.session?.defaultActorId;
        if (!actorId) {
          api.showToast?.('GM 还没有为当前 Player 分配 OWNER 角色', 'info');
          return;
        }
        void api.entities?.openActor?.(actorId);
      }

      function activatePanel(name) {
        api.setActivePanel?.(name);
        shell.querySelectorAll('[data-ui-panel]').forEach(node => node.classList.toggle('active', node.dataset.uiPanel === name));
        if (name === 'current') renderCurrent();
      }

      let library = null;
      if (tabbar) {
        tabbar.replaceChildren();
        library = button(documentNode, '角色库', () => activatePanel('actors'), 'ui-sidebar-tab active');
        library.dataset.uiPanel = 'actors';
        const current = button(documentNode, '当前', () => activatePanel('current'), 'ui-sidebar-tab');
        current.dataset.uiPanel = 'current';
        tabbar.append(library, current);
      }

      function setMainTool(tool) {
        api.setTool?.(tool);
        toolbar?.querySelectorAll('[data-main-tool]').forEach(node => node.classList.toggle('active', node.dataset.mainTool === tool));
      }

      let myActorButton = null;
      if (toolbar) {
        toolbar.replaceChildren();
        const select = button(documentNode, '选择', () => { setMainTool('pan'); activatePanel('current'); });
        select.dataset.mainTool = 'pan';
        select.classList.add('active');
        const range = button(documentNode, '范围', () => { setMainTool('aoe'); activatePanel('areas'); });
        range.dataset.mainTool = 'aoe';
        myActorButton = button(documentNode, '我的角色卡', openMyActor);
        myActorButton.hidden = true;
        toolbar.append(select, range, myActorButton);
      }

      let exportButton = null;
      let importButton = null;
      if (toolbarRight) {
        toolbarRight.replaceChildren();
        exportButton = button(documentNode, '导出', () => api.downloadState?.());
        importButton = button(documentNode, '导入', () => importInput.click());
        toolbarRight.append(exportButton, importButton, button(documentNode, '回到底图', () => api.resetView?.()));
      }

      importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        importInput.value = '';
        if (!file) return;
        try {
          await api.importFile?.(file);
          api.showToast?.('World 存档导入成功', 'success');
        } catch (error) {
          api.showToast?.(`导入失败：${error?.message || error}`, 'error');
        }
      });

      function renderCurrent() {
        if (!currentPanel) return;
        currentPanel.replaceChildren();
        const player = playerShell();
        const tokenId = api.selection.getPrimaryTokenId?.();
        const token = tokenId ? api.tokens.get(tokenId) : null;
        if (!token) {
          const empty = documentNode.createElement('div');
          empty.className = 'ui-current-empty';
          empty.textContent = player
            ? '选择 Token 查看信息；顶部可打开自己的角色卡。'
            : '选择 Token 后，这里会显示实例信息与快捷操作。';
          currentPanel.append(empty);
          return;
        }
        const view = actorView(api, token);
        const card = documentNode.createElement('div');
        card.className = 'ui-current-card';
        const head = documentNode.createElement('div');
        head.className = 'ui-current-head';
        const avatar = documentNode.createElement('span');
        avatar.className = 'ui-token-avatar';
        avatar.style.background = view.color;
        if (view.avatar) avatar.innerHTML = `<img src="${escapeHtml(view.avatar)}" alt="">`;
        else avatar.textContent = (Array.from(view.name.trim())[0] || '?').toUpperCase();
        const title = documentNode.createElement('div');
        const strong = documentNode.createElement('strong'); strong.textContent = view.name;
        const small = documentNode.createElement('small');
        small.textContent = view.synthetic ? '独立角色实例' : '共享角色资料';
        title.append(strong, documentNode.createElement('br'), small);
        head.append(avatar, title);
        card.append(head);

        const statusSnapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
        card.insertAdjacentHTML('beforeend', `<div class="ui-status-summary">${renderStatusStrip(statusSnapshot.statuses, { limit: 6, emptyText: '无机械状态' })}</div>`);

        const meta = documentNode.createElement('div');
        meta.className = 'ui-token-meta';
        const metaRows = player
          ? [locationLabel(token), `高度 ${Number(token.elevationFt || 0)} ft`]
          : [`棋子 ID ${token.id}`, `角色 ID ${token.actorId}`, locationLabel(token), `高度 ${Number(token.elevationFt || 0)} ft`];
        for (const text of metaRows) {
          const item = documentNode.createElement('div'); item.textContent = text; meta.append(item);
        }
        card.append(meta);

        const actions = documentNode.createElement('div');
        actions.className = 'ui-actions';
        const canControl = !player || api.multiplayer?.canControlToken?.(token.id) === true;
        if (canControl && token.placement === 'map') {
          actions.append(button(documentNode, '移动', () => api.movementUi?.begin?.(token.id), 'small-button primary'));
        } else if (canControl && token.placement === 'feature') {
          actions.append(button(documentNode, '离开 Feature', () => void api.movement?.exitFeature?.(token.id), 'small-button primary'));
        }
        if (canControl) actions.append(button(documentNode, '高度', event => api.elevation?.openTokenElevationEditor?.(token.id, event), 'small-button'));
        if (view.actor?.id) actions.append(button(documentNode, view.actor.audienceRestricted ? '公开摘要' : '角色卡', () => api.entities?.openToken?.(token.id), 'small-button'));
        card.append(actions);
        currentPanel.append(card);
      }

      function applySessionShell() {
        const player = playerShell();
        if (library) library.hidden = player;
        if (myActorButton) myActorButton.hidden = !player;
        if (exportButton) exportButton.hidden = player;
        if (importButton) importButton.hidden = player;
        renderCurrent();
      }

      const off = [];
      const selectionOff = api.selection.subscribe?.(renderCurrent);
      if (selectionOff) off.push(selectionOff);
      for (const eventName of ['token:create', 'token:delete', 'token:move', 'token:property-change', 'elevation:token-change', 'actor:change', 'health:change', 'status:change', 'state:import']) {
        off.push(api.on?.(eventName, renderCurrent));
      }
      off.push(api.on?.('multiplayer:capabilities', applySessionShell));
      off.push(api.on?.('tool:change', event => {
        const tool = event.detail?.tool || api.getTool?.();
        toolbar?.querySelectorAll('[data-main-tool]').forEach(node => node.classList.toggle('active', node.dataset.mainTool === tool));
      }));
      off.push(api.on?.('app:destroy', () => {
        off.splice(0).forEach(dispose => dispose?.());
        importInput.remove();
      }));

      api.setActivePanel?.('current');
      shell.querySelectorAll('[data-ui-panel]').forEach(node => node.classList.toggle('active', node.dataset.uiPanel === 'current'));
      applySessionShell();
      api.emit?.('ui:shell-ready', { tokenFirst: true });
    },
  });
}
