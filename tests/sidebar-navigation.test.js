import assert from 'node:assert/strict';
import test from 'node:test';
import { activateSidebarPanel } from '../src/ui/sidebar-navigation.js';

function node(dataset) {
  const classes = new Set(), attributes = {};
  return { dataset, attributes, classList: {
    toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
    contains(name) { return classes.has(name); },
  }, setAttribute(name, value) { attributes[name] = value; } };
}
function fixture() {
  const panels = ['current', 'actors', 'vision'].map(panel => node({ panel }));
  const tabs = ['current', 'actors'].map(uiPanel => node({ uiPanel }));
  return { panels, tabs, querySelectorAll(selector) { return selector === '.sidebar [data-panel]' ? panels : tabs; } };
}

test('late registered chat returns to exactly one object panel and one active tab', () => {
  const shell = fixture();
  activateSidebarPanel(shell, 'current');
  shell.panels.push(node({ panel: 'chat' }));
  shell.tabs.push(node({ uiSidebar: 'chat' }));
  for (const target of ['chat', 'current', 'chat', 'actors', 'vision', 'current']) {
    assert.equal(activateSidebarPanel(shell, target), true);
    assert.deepEqual(shell.panels.filter(item => item.classList.contains('active')).map(item => item.dataset.panel), [target]);
    assert.equal(shell.tabs.filter(item => item.classList.contains('active')).length, target === 'vision' ? 0 : 1);
    for (const tab of shell.tabs) {
      assert.equal(tab.attributes['aria-selected'], String(tab.classList.contains('active')));
      assert.equal(tab.attributes.role, 'tab');
    }
  }
});

test('unknown panel names do not clear the active selection or interpolate a DOM selector', () => {
  const shell = fixture();
  activateSidebarPanel(shell, 'current');
  for (const target of ['', null, 'missing', 'current"] .secret']) {
    assert.equal(activateSidebarPanel(shell, target), false);
    assert.equal(shell.panels[0].classList.contains('active'), true);
    assert.equal(shell.tabs[0].attributes['aria-selected'], 'true');
  }
});
