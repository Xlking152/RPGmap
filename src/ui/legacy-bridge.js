function showContextPanel(shell, name) {
  shell.querySelectorAll('.sidebar [data-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === name));
  shell.querySelectorAll('.ui-sidebar-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.uiSidebar === 'current'));
}

function menuByLabel(shell, prefix) {
  return [...shell.querySelectorAll('.ui-menu')].find(node => node.querySelector('summary')?.textContent?.trim().startsWith(prefix)) || null;
}

function addMenuButton(documentNode, parent, label, action) {
  const button = documentNode.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', event => {
    event.preventDefault();
    parent.closest('details')?.removeAttribute('open');
    action();
  });
  parent.append(button);
}

export function createLegacyUiBridge() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell');
      if (!shell) return;

      const rangeMenu = menuByLabel(shell, '范围');
      const rangePopover = rangeMenu?.querySelector('.ui-menu-popover');
      if (rangePopover) {
        rangePopover.replaceChildren();
        const startArea = shape => {
          api.setTool('aoe');
          showContextPanel(shell, 'areas');
          queueMicrotask(() => shell.querySelector(`[data-action="new-area"][data-shape="${shape}"]`)?.click());
        };
        addMenuButton(documentNode, rangePopover, '圆形范围', () => startArea('circle'));
        addMenuButton(documentNode, rangePopover, '扇形范围', () => startArea('sector'));
        addMenuButton(documentNode, rangePopover, '矩形范围', () => startArea('rectangle'));
        const separator = documentNode.createElement('div'); separator.className = 'ui-context-separator'; rangePopover.append(separator);
        addMenuButton(documentNode, rangePopover, '范围列表 / 参数', () => { api.setTool('aoe'); showContextPanel(shell, 'areas'); });
      }

      const sceneMenu = menuByLabel(shell, '场景');
      const undoItem = [...(sceneMenu?.querySelectorAll('.ui-menu-popover button') || [])]
        .find(node => node.textContent?.trim() === '撤销场景变化');
      undoItem?.addEventListener('click', () => {
        queueMicrotask(() => shell.querySelector('[data-action="undo-scene"]')?.click());
      });
    },
  };
}
