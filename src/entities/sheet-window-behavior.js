export function createSheetWindowBehavior() {
  return {
    register(api) {
      const documentNode = api.map.getContainer().ownerDocument;
      const windowNode = documentNode.defaultView;
      const abort = new AbortController();
      const options = { capture: true, signal: abort.signal };
      let drag = null;

      function pointerDown(event) {
        if (windowNode.innerWidth <= 760 || event.button || event.target.closest('input,button,select,textarea,a')) return;
        const header = event.target.closest('.entity-sheet-header');
        if (!header) return;
        const sheet = header.parentElement;
        const rect = sheet.getBoundingClientRect();
        drag = { sheet, x: event.clientX - rect.left, y: event.clientY - rect.top };
        event.preventDefault();
      }

      function pointerMove(event) {
        if (!drag) return;
        drag.sheet.style.left = `${Math.max(8, Math.min(windowNode.innerWidth - 80, event.clientX - drag.x))}px`;
        drag.sheet.style.top = `${Math.max(8, Math.min(windowNode.innerHeight - 56, event.clientY - drag.y))}px`;
      }

      documentNode.addEventListener('pointerdown', pointerDown, options);
      documentNode.addEventListener('pointermove', pointerMove, options);
      documentNode.addEventListener('pointerup', () => { drag = null; }, options);
      api.on?.('app:destroy', () => abort.abort());
    },
  };
}
