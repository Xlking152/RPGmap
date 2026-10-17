import { renderUiIcon } from './icons.js';

export function workbenchConnectionLabel(status) {
  if (status?.connected) return status.session?.role === 'gm' ? '主持人 · 已连接' : '玩家 · 已连接';
  if (status?.joining || status?.connecting) return '正在连接';
  return status?.serverUrl ? '连接已断开' : '本地模式';
}

export function workbenchWorldLabel(world, mapPackage) {
  return String(world?.name || mapPackage?.name || mapPackage?.title || 'RPGmap');
}

export function installWorkbenchChrome(api, { shell, documentNode }) {
  const toolbar = shell.querySelector('.toolbar');
  const toolbarRight = shell.querySelector('.toolbar-right');
  const sidebar = shell.querySelector('.sidebar');
  if (!toolbarRight || !sidebar) return;
  const windowNode = documentNode.defaultView;
  let disposed = false;
  shell.querySelector('.brand-mark').innerHTML = renderUiIcon('layers', { size: 26 });
  const toggle = documentNode.createElement('button');
  toggle.type = 'button'; toggle.className = 'tool-button ui-inspector-toggle';
  toggle.dataset.inspectorToggle = 'true';
  toggle.setAttribute('aria-expanded', 'true');
  sidebar.id ||= 'runtime-inspector';
  toggle.setAttribute('aria-controls', sidebar.id);
  toolbarRight.append(toggle);

  function setInspectorVisible(visible) {
    shell.classList.toggle('is-inspector-collapsed', !visible);
    toggle.setAttribute('aria-expanded', String(visible));
    toggle.title = visible ? '收起侧栏' : '展开侧栏';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.innerHTML = renderUiIcon(visible ? 'panel-right-close' : 'panel-right-open');
    api.map.invalidateSize?.({ pan: false });
  }
  toggle.addEventListener('click', () => setInspectorVisible(shell.classList.contains('is-inspector-collapsed')));
  setInspectorVisible(true);

  function updateHeading() {
    const heading = shell.querySelector('[data-role="app-title"]');
    if (!heading) return;
    heading.textContent = workbenchWorldLabel(api.world?.get?.(), api.mapPackage);
    heading.title = heading.textContent;
  }

  function decorateTools() {
    if (disposed) return;
    for (const node of toolbar?.querySelectorAll('button') || []) {
      if (node.querySelector('.ui-icon')) continue;
      const label = node.classList.contains('ui-token-ruler-tool') ? '棋子测距' : node.textContent.trim();
      const icon = node.classList.contains('ui-ruler-tool') || node.classList.contains('ui-token-ruler-tool') ? 'ruler'
        : node.closest('.combat-top-controls') ? 'shield' : null;
      if (!icon) continue;
      node.replaceChildren();
      node.insertAdjacentHTML('beforeend', renderUiIcon(icon));
      const text = documentNode.createElement('span'); text.textContent = label;
      node.append(text); node.title = label; node.setAttribute('aria-label', label);
    }
    for (const [selector, icon, label] of [
      ['[data-journal]', 'book-open', '资料页'], ['[data-template-library]', 'users', '模板资料库'],
      ['.entity-toolbar-button', 'upload', '导入角色卡'],
    ]) {
      const node = toolbarRight.querySelector(selector);
      if (!node || node.querySelector('.ui-icon')) continue;
      node.innerHTML = `${renderUiIcon(icon)}<span class="ui-command-label">${label}</span>`;
      node.title = label; node.setAttribute('aria-label', label);
    }
  }
  const observer = new windowNode.MutationObserver(decorateTools);
  observer.observe(toolbarRight, { childList: true });
  if (toolbar) observer.observe(toolbar, { childList: true, subtree: true });
  decorateTools();

  function closeMenus(event) {
    for (const menu of shell.querySelectorAll('.ui-command-menu[open]')) {
      if (event.type === 'keydown' && event.key !== 'Escape') continue;
      if (event.type === 'keydown' || !menu.contains(event.target)) {
        menu.open = false;
        if (event.type === 'keydown') menu.querySelector('summary').focus();
      }
    }
  }
  documentNode.addEventListener('pointerdown', closeMenus);
  documentNode.addEventListener('keydown', closeMenus);
  function updateFooter() {
    const count = api.selection.getSelectedTokenIds?.().length || 0;
    const selectionLabel = shell.querySelector('[data-ui-selection-label]');
    if (selectionLabel) selectionLabel.textContent = count ? `已选择 ${count} 个棋子` : '未选择棋子';
    const connection = shell.querySelector('[data-ui-connection-label]');
    if (connection) connection.textContent = workbenchConnectionLabel(api.multiplayer?.getStatus?.());
  }
  const off = [api.selection.subscribe?.(updateFooter), api.on?.('multiplayer:capabilities', updateFooter),
    api.on?.('multiplayer:status', updateFooter), api.on?.('ui:panel-change', () => setInspectorVisible(true)),
    ...['world:ready', 'state:import', 'scene:activate'].map(event => api.on?.(event, updateHeading))];
  // Other systems register their toolbar buttons after the shell.
  queueMicrotask(() => { if (!disposed) { decorateTools(); updateFooter(); updateHeading(); } });
  off.push(api.on?.('app:destroy', () => {
    disposed = true;
    observer.disconnect();
    documentNode.removeEventListener('pointerdown', closeMenus);
    documentNode.removeEventListener('keydown', closeMenus);
    off.splice(0).forEach(dispose => dispose?.());
  }));
}
