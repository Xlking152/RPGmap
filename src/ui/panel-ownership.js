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

function takePanelOwnership(shell, documentNode, name) {
  const current = shell?.querySelector?.(`[data-panel="${name}"]`);
  if (!current || current.dataset?.canonicalPanelOwner === 'true') return current || null;
  const panel = clonePanelShell(documentNode, current, name);
  current.replaceWith(panel);
  return panel;
}

/**
 * AppCore still contains the pre-World-V2 panel renderers while the refactor is
 * being completed. Those renderers retain direct references to the DOM nodes
 * created by shellMarkup(). Replacing the two runtime panels once gives the
 * Token/Actor systems exclusive ownership without MutationObserver/capture
 * bridges: AppCore can only render into its now-detached nodes.
 */
export function createCanonicalPanelOwnershipSystem() {
  return Object.freeze({
    register(api) {
      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document;
      const shell = mapElement?.closest?.('.app-shell') || documentNode;
      if (!shell || !documentNode) return;

      const characters = takePanelOwnership(shell, documentNode, 'characters');
      const inspect = takePanelOwnership(shell, documentNode, 'inspect');
      api.uiPanels = Object.freeze({
        canonical: true,
        characters,
        inspect,
        get(name) { return shell.querySelector?.(`[data-panel="${String(name)}"]`) || null; },
      });
      api.emit?.('ui:canonical-panels-ready', { panels: ['characters', 'inspect'] });
    },
  });
}
