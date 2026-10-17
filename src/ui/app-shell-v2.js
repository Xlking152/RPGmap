import { installStatusUiStyles, renderStatusStrip, resolveStatusUiSnapshot } from '../status/ui.js';
import { describeActor } from '../actor/index.js';
import { restoreCurrentSceneEnvironment, clearCurrentScene } from './scene-reset.js';
import { renderUiIcon } from './icons.js';
import { installWorkbenchChrome } from './workbench.js';
import { describeObjectInspector } from './object-inspector.js';
import { installVisionPanel } from './vision-panel.js';

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
    .runtime-v2-shell .topbar { align-items:center; }
    .runtime-v2-shell .brand-copy p { display:none; }
    .runtime-v2-shell .brand-copy h1 { white-space:nowrap; }
    .runtime-v2-shell .toolbar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    .runtime-v2-shell .toolbar-right { display:flex; align-items:center; }
    .runtime-v2-shell .toolbar-right { margin-left:auto; }
    .runtime-v2-shell .ui-primary-tool { min-height:34px; display:inline-flex; align-items:center; justify-content:center; gap:5px; border:1px solid rgba(79,96,98,.22); padding:6px 10px; color:#334347; background:#f7f9f6; font:inherit; cursor:pointer; }
    .runtime-v2-shell .ui-primary-tool:hover { background:#eef4f0; }
    .runtime-v2-shell .ui-primary-tool.active { color:#fff; background:#176d76; border-color:#176d76; }
    .runtime-v2-shell .sidebar .tabbar { grid-template-columns:repeat(4,minmax(0,1fr)); }
    .runtime-v2-shell .ui-sidebar-tab { border:0; border-radius:7px; padding:8px 10px; background:#edf1ee; color:#556265; font-weight:800; cursor:pointer; }
    .runtime-v2-shell .ui-sidebar-tab.active { color:#fff; background:#176d76; }
    .runtime-v2-shell .ui-current-card { display:grid; }
    .runtime-v2-shell .ui-current-head { display:flex; align-items:center; }
    .runtime-v2-shell .ui-token-avatar { border-radius:50%; display:grid; place-items:center; overflow:hidden; background:#176d76; color:#fff; font-weight:850; flex:0 0 auto; }
    .runtime-v2-shell .ui-token-avatar img { width:100%; height:100%; object-fit:cover; }
    .runtime-v2-shell .ui-token-meta { color:#536164; }
    .runtime-v2-shell .ui-token-meta div { border-radius:7px; }
    .runtime-v2-shell .ui-current-empty { text-align:center; line-height:1.6; }
    .runtime-v2-shell .ui-actions { flex-wrap:wrap; }
    .runtime-v2-shell .ui-file-input { display:none; }
    .entity-sheet-backdrop{background:transparent!important;pointer-events:none}
    .entity-sheet{position:fixed;left:24px;top:72px;resize:both;pointer-events:auto}
    .entity-sheet-header{cursor:move}
    @media(max-width:760px){.entity-sheet{left:8px!important;top:8px!important;width:calc(100vw - 16px)!important;height:calc(100vh - 16px)!important;resize:none}}
  `;
  documentNode.head.append(style);
}

function button(documentNode, label, action, className = 'ui-primary-tool') {
  const node = documentNode.createElement('button');
  node.type = 'button';
  node.className = className;
  const icon = {
    '选择': 'mouse-pointer-2', '范围': 'circle', '检查': 'search', '视野': 'eye',
    '我的角色卡': 'user', '导出': 'download', '导入': 'upload', '回到底图': 'map',
    '恢复地图环境': 'rotate-ccw', '清空当前场景': 'trash-2',
    '移动': 'move', '高度': 'layers', '角色卡': 'user', '打开角色卡': 'user', '公开摘要': 'info',
    '状态': 'sparkles', '棋子配置': 'sliders-horizontal', '设为视野来源': 'eye',
  }[label];
  node.innerHTML = `${icon ? renderUiIcon(icon) : ''}<span class="ui-command-label">${escapeHtml(label)}</span>`;
  node.title = label;
  node.setAttribute('aria-label', label);
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
      const actorPanel = api.uiPanels?.actors;
      const currentPanel = api.uiPanels?.get?.('current');
      const importInput = documentNode.createElement('input');
      importInput.type = 'file';
      importInput.accept = 'application/json,.json,application/zip,.zip';
      importInput.className = 'ui-file-input';
      shell.append(importInput);

      function playerShell() {
        const capabilities = api.multiplayer?.getCapabilities?.();
        return capabilities?.connected === true && capabilities.role !== 'gm';
      }
      function openMyActor() {
        const actorId = api.multiplayer?.getStatus?.()?.session?.defaultActorId;
        if (!actorId) {
          api.showToast?.('主持人尚未为你分配角色', 'info');
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
        const current = button(documentNode, '对象', () => activatePanel('current'), 'ui-sidebar-tab');
        current.dataset.uiPanel = 'current';
        tabbar.append(current, library);
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
        const inspect = button(documentNode, '检查', () => { setMainTool('inspect'); activatePanel('inspect'); });
        inspect.dataset.mainTool = 'inspect';
        const vision = button(documentNode, '视野', () => activatePanel('vision'));
        vision.dataset.visionTool = 'true';
        toolbar.append(select, range, inspect, vision, myActorButton);
      }

      let exportButton = null;
      let importButton = null;
      let resetButton = null;
      let clearButton = null;
      if (toolbarRight) {
        toolbarRight.replaceChildren();
        exportButton = button(documentNode, '导出', async () => {
          try { await api.downloadState?.(); }
          catch (error) { api.showToast?.(`导出失败：${error.message}`, 'error'); }
        });
        importButton = button(documentNode, '导入', () => importInput.click());
        async function resetAction(action, label) {
          if (resetButton.disabled || clearButton.disabled) return;
          resetButton.disabled = true; clearButton.disabled = true;
          try {
            await action(api, message => documentNode.defaultView?.confirm?.(message) === true);
          } catch (error) {
            api.showToast?.(`${label}失败：${error?.message || error}`, 'error');
          } finally { resetButton.disabled = false; clearButton.disabled = false; }
        }
        resetButton = button(documentNode, '恢复地图环境', () => resetAction(restoreCurrentSceneEnvironment, '恢复地图环境'));
        clearButton = button(documentNode, '清空当前场景', () => resetAction(clearCurrentScene, '清空当前场景'));
        const menu = documentNode.createElement('details');
        menu.className = 'ui-command-menu';
        menu.dataset.worldCommands = 'true';
        menu.innerHTML = `<summary title="世界操作" aria-label="世界操作">${renderUiIcon('settings')}</summary><div class="ui-command-popover"></div>`;
        const menuBody = menu.querySelector('.ui-command-popover');
        resetButton.classList.add('danger'); clearButton.classList.add('danger');
        menuBody.append(exportButton, importButton, button(documentNode, '回到底图', () => api.resetView?.()), resetButton, clearButton);
        menuBody.addEventListener('click', event => { if (event.target.closest('button')) menu.open = false; });
        toolbarRight.append(menu);
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
        const player = playerShell();
        const tokenId = api.selection.getPrimaryTokenId?.();
        const token = tokenId ? api.tokens.get(tokenId) : null;
        if (!token) {
          const empty = documentNode.createElement('div');
          empty.className = 'ui-current-empty';
          empty.innerHTML = `${renderUiIcon('mouse-pointer-2', { size: 30 })}<span>未选择棋子</span>`;
          currentPanel.replaceChildren(empty);
          return;
        }
        const view = actorView(api, token);
        const overview = describeObjectInspector(api, token, view.actor);
        const card = documentNode.createElement('div');
        card.className = 'ui-current-card';
        card.dataset.tokenId = token.id;
        const head = documentNode.createElement('div');
        head.className = 'ui-current-head';
        const avatar = documentNode.createElement('span');
        avatar.className = 'ui-token-avatar';
        avatar.style.background = view.color;
        if (view.avatar) avatar.innerHTML = `<img ${contentImageAttributes(view.avatar, escapeHtml)} alt="">`;
        else avatar.textContent = (Array.from(view.name.trim())[0] || '?').toUpperCase();
        const title = documentNode.createElement('div');
        const strong = documentNode.createElement('strong'); strong.textContent = view.name;
        const small = documentNode.createElement('small');
        small.textContent = `${view.synthetic ? '独立实例' : '共享角色'} · ${api.world?.getActiveScene?.()?.name || '当前场景'}`;
        title.append(strong, documentNode.createElement('br'), small);
        head.append(avatar, title);
        card.append(head);

        if (overview.health) {
          const section = documentNode.createElement('section');
          section.className = 'ui-object-health';
          section.innerHTML = `<div class="ui-object-health-heading"><span>生命</span><strong>${escapeHtml(overview.health.label)}</strong></div>`;
          const bar = documentNode.createElement('div');
          bar.className = 'ui-object-health-track';
          bar.setAttribute('role', 'img');
          bar.setAttribute('aria-label', `${overview.health.title} ${overview.health.label}`);
          for (const segment of overview.health.segments) {
            const part = documentNode.createElement('span');
            part.style.width = `${segment.percent}%`; part.style.background = segment.color; part.title = segment.label;
            bar.append(part);
          }
          section.append(bar); card.append(section);
        }
        if (!overview.restricted) {
          const statusSnapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
          card.insertAdjacentHTML('beforeend', `<div class="ui-status-summary">${renderStatusStrip(statusSnapshot.statuses, { limit: 6, emptyText: '无状态' })}</div>`);
        }

        const meta = documentNode.createElement('div');
        meta.className = 'ui-token-meta';
        for (const [label, value] of overview.properties) {
          const row = documentNode.createElement('div');
          row.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
          meta.append(row);
        }
        const debug = documentNode.createElement('details');
        debug.className = 'ui-token-debug';
        debug.innerHTML = '<summary>对象标识</summary>';
        if (!player) for (const text of [`棋子 ID ${token.id}`, `角色 ID ${token.actorId}`]) {
          const item = documentNode.createElement('p'); item.textContent = text; debug.append(item);
        }
        if (overview.properties.length) card.append(meta);

        const primary = documentNode.createElement('div');
        primary.className = 'ui-object-primary';
        if (view.actor?.id) primary.append(button(documentNode, overview.restricted ? '公开摘要' : '打开角色卡',
          () => api.entities?.openToken?.(token.id), 'small-button primary'));
        card.append(primary);

        const actions = documentNode.createElement('div');
        actions.className = 'ui-actions';
        const canControl = !player || api.multiplayer?.canControlToken?.(token.id) === true;
        if (canControl && token.placement === 'map') {
          actions.append(button(documentNode, '移动', () => api.movementUi?.begin?.(token.id), 'small-button'));
        } else if (canControl && token.placement === 'feature') {
          actions.append(button(documentNode, '离开 Feature', () => void api.movement?.exitFeature?.(token.id), 'small-button primary'));
        }
        if (canControl) actions.append(button(documentNode, '高度', event => api.elevation?.openTokenElevationEditor?.(token.id, event), 'small-button'));
        if (canControl && !overview.restricted) {
          actions.append(button(documentNode, '状态', event => {
            const rect = event.currentTarget.getBoundingClientRect();
            void api.statusUi?.openQuickHud?.(token.id, { x: rect.left, y: rect.bottom });
          }, 'small-button'));
          if (token.placement === 'map') actions.append(button(documentNode, '设为视野来源', async () => {
            try { await api.vision?.setSource?.(token.id); activatePanel('vision'); }
            catch (error) { api.showToast?.(error.message, 'error'); }
          }, 'small-button'));
        }
        card.append(actions);
        const location = documentNode.createElement('section');
        location.className = 'ui-object-location';
        const feature = token.placement === 'feature' ? api.mapPackage.features?.find(item => item.id === token.featureId) : null;
        location.innerHTML = `<h3>当前位置</h3><p>${renderUiIcon('map-pin')}<span>${escapeHtml(feature?.name || locationLabel(token))}</span></p>`;
        card.append(location);
        if (!player) card.append(debug);
        const existing = currentPanel.querySelector('.ui-current-card');
        if (!existing || existing.dataset.tokenId !== String(token.id)) currentPanel.replaceChildren(card);
        else {
          const classes = new Set([...card.children].map(node => node.className));
          for (const part of [...existing.children]) if (!classes.has(part.className)) part.remove();
          for (const [index, part] of [...card.children].entries()) {
            let current = [...existing.children].find(node => node.className === part.className);
            if (!current) current = part;
            else if (current.outerHTML !== part.outerHTML) { current.replaceWith(part); current = part; }
            if (existing.children[index] !== current) existing.insertBefore(current, existing.children[index] || null);
          }
        }
      }

      function applySessionShell() {
        const player = playerShell();
        if (library) library.hidden = player;
        if (myActorButton) myActorButton.hidden = !player;
        if (exportButton) exportButton.hidden = player;
        if (importButton) importButton.hidden = player;
        if (resetButton) resetButton.hidden = player;
        if (clearButton) clearButton.hidden = player;
        if (player && actorPanel?.classList?.contains('active')) activatePanel('current');
        renderCurrent();
      }

      const off = [];
      let summaryFrame = null;
      const windowNode = documentNode.defaultView || globalThis;
      function scheduleCurrent(event) {
        const detail = event?.detail || {};
        const tokenIds = [detail.tokenId, detail.id, ...(detail.tokenIds || [])].filter(Boolean).map(String);
        const actorIds = [detail.actorId, ...(detail.actorIds || [])].filter(Boolean).map(String);
        const primaryId = api.selection.getPrimaryTokenId?.();
        if (!primaryId && (tokenIds.length || actorIds.length)) return;
        if (primaryId && (tokenIds.length || actorIds.length)) {
          const token = api.tokens.get(primaryId);
          if (!tokenIds.includes(String(primaryId)) && !actorIds.includes(String(token?.actorId))) return;
        }
        if (summaryFrame !== null) return;
        summaryFrame = windowNode.requestAnimationFrame(() => { summaryFrame = null; renderCurrent(); });
      }
      const selectionOff = api.selection.subscribe?.(scheduleCurrent);
      if (selectionOff) off.push(selectionOff);
      for (const eventName of ['token:create', 'token:delete', 'token:move', 'token:property-change', 'elevation:token-change', 'actor:change', 'health:change', 'status:change', 'vision:source-change', 'multiplayer:vision', 'state:import']) {
        off.push(api.on?.(eventName, scheduleCurrent));
      }
      off.push(api.on?.('multiplayer:capabilities', applySessionShell));
      off.push(api.on?.('tool:change', event => {
        const tool = event.detail?.tool || api.getTool?.();
        toolbar?.querySelectorAll('[data-main-tool]').forEach(node => node.classList.toggle('active', node.dataset.mainTool === tool));
      }));
      off.push(api.on?.('app:destroy', () => {
        if (summaryFrame !== null) windowNode.cancelAnimationFrame(summaryFrame);
        off.splice(0).forEach(dispose => dispose?.());
        importInput.remove();
      }));

      api.setActivePanel?.('current');
      shell.querySelectorAll('[data-ui-panel]').forEach(node => node.classList.toggle('active', node.dataset.uiPanel === 'current'));
      applySessionShell();
      installWorkbenchChrome(api, { shell, documentNode });
      installVisionPanel(api, { container: api.uiPanels?.get?.('vision') });
      api.emit?.('ui:shell-ready', { tokenFirst: true });
    },
  });
}
import { contentImageAttributes } from '../content/references.js';
