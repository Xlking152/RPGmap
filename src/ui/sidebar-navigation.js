export function activateSidebarPanel(container, name) {
  const target = String(name || '');
  const panels = [...container.querySelectorAll('.sidebar [data-panel]')];
  const selected = panels.find(panel => panel.dataset.panel === target);
  if (!selected) return false;
  for (const panel of panels) panel.classList.toggle('active', panel === selected);
  for (const tab of container.querySelectorAll('.sidebar [data-ui-panel], .sidebar [data-ui-sidebar]')) {
    const active = (tab.dataset.uiPanel || tab.dataset.uiSidebar) === target;
    tab.classList.toggle('active', active);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(active));
  }
  return true;
}
