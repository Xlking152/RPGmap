function clonePanelShell(documentNode, legacy, name) {
  const panel = documentNode.createElement(legacy?.tagName?.toLowerCase?.() || 'section');
  panel.className = legacy?.className || 'panel';
  panel.dataset.panel = name;
  panel.dataset.canonicalPanelOwner = 'true';
  for (const attribute of legacy?.attributes || []) {
    if (attribute.name === 'class' || attribute.name === 'data-panel') continue;
    panel.setAttribute(attribute.name, attribute.value);
  }
  return panel;
}

function takePanelOwnership(shell, documentNode, legacyName, canonicalName = legacyName) {
  const current = shell?.querySelector?.(`[data-panel="${legacyName}"]`);
  if (!current) return shell?.querySelector?.(`[data-panel="${canonicalName}"]`) || null;
  if (current.dataset?.canonicalPanelOwner === 'true') return current;
  const panel = clonePanelShell(documentNode, current, canonicalName);
  current.replaceWith(panel);
  return panel;
}

/**
 * AppCore still contains pre-World-V2 panel renderers for one-way legacy
 * compatibility. Replacing their DOM nodes once leaves those renderers attached
 * only to detached elements, while the visible runtime panels use canonical
 * Actor/Token terminology and ownership.
 */
export function createCanonicalPanelOwnershipSystem() {
  return Object.freeze({
    register(api) {
      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document;
      const shell = mapElement?.closest?.('.app-shell') || documentNode;
      if (!shell || !documentNode) return;

      const actors = takePanelOwnership(shell, documentNode, 'characters', 'actors');
      const inspect = takePanelOwnership(shell, documentNode, 'inspect');
      api.uiPanels = Object.freeze({
        canonical: true,
        actors,
        inspect,
        get(name) { return shell.querySelector?.(`[data-panel="${String(name)}"]`) || null; },
      });
      api.emit?.('ui:canonical-panels-ready', { panels: ['actors', 'inspect'] });
    },
  });
}
