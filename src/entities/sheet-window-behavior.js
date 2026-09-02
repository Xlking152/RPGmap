export function createSheetWindowBehavior() {
  return Object.freeze({
    register(api) {
      const documentNode = api?.map?.getContainer?.()?.ownerDocument || globalThis.document;
      const windowNode = documentNode?.defaultView || globalThis.window;
      if (!documentNode?.body || !windowNode) return;
      let drag = null;

      function pointerDown(event) {
        if (windowNode.innerWidth <= 760 || event.button !== 0 || event.target.closest('input,button,select,textarea,a,[contenteditable="true"]')) return;
        const header = event.target?.closest?.('.entity-sheet-backdrop>.entity-sheet>.entity-sheet-header');
        if (!header) return;
        const sheet = header.parentElement;
        const rect = sheet.getBoundingClientRect();
        drag = { sheet, x: event.clientX - rect.left, y: event.clientY - rect.top };
        event.preventDefault();
      }

      function pointerMove(event) {
        if (!drag?.sheet?.isConnected) return;
        drag.sheet.style.left = `${Math.max(8, Math.min(windowNode.innerWidth - 80, event.clientX - drag.x))}px`;
        drag.sheet.style.top = `${Math.max(8, Math.min(windowNode.innerHeight - 56, event.clientY - drag.y))}px`;
        event.preventDefault();
      }

      const pointerUp = () => { drag = null; };
      documentNode.addEventListener('pointerdown', pointerDown, true);
      documentNode.addEventListener('pointermove', pointerMove, true);
      documentNode.addEventListener('pointerup', pointerUp, true);
      api.on?.('app:destroy', () => {
        documentNode.removeEventListener('pointerdown', pointerDown, true);
        documentNode.removeEventListener('pointermove', pointerMove, true);
        documentNode.removeEventListener('pointerup', pointerUp, true);
      });
    },
  });
}
