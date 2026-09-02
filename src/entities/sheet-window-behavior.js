const STYLE_ID = 'rpgmap-entity-sheet-window-style';
let zSerial = 4300;

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .entity-sheet-backdrop{background:transparent!important;display:block!important;padding:0!important;pointer-events:none!important}
    .entity-sheet-backdrop>.entity-sheet{position:fixed;left:24px;top:72px;width:min(880px,calc(100vw - 48px));min-width:360px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);margin:0;overflow:auto;resize:both;pointer-events:auto}
    .entity-sheet-backdrop>.entity-sheet>.entity-sheet-header{cursor:move}
    .entity-sheet-backdrop>.entity-sheet>.entity-sheet-header :is(input,button,select,textarea,a){cursor:auto}
    @media(max-width:760px){.entity-sheet-backdrop>.entity-sheet{left:8px!important;top:8px!important;width:calc(100vw - 16px)!important;height:calc(100vh - 16px)!important;min-width:0;max-width:none;max-height:none;resize:none}.entity-sheet-backdrop>.entity-sheet>.entity-sheet-header{cursor:auto}}
  `;
  documentNode.head.append(style);
}

export function createSheetWindowBehavior() {
  return Object.freeze({
    register(api) {
      const documentNode = api?.map?.getContainer?.()?.ownerDocument || globalThis.document;
      const windowNode = documentNode?.defaultView || globalThis.window;
      if (!documentNode?.body || !windowNode) return;
      installStyles(documentNode);
      let drag = null;

      function pointerDown(event) {
        if (windowNode.innerWidth <= 760 || event.button !== 0) return;
        const header = event.target?.closest?.('.entity-sheet-backdrop>.entity-sheet>.entity-sheet-header');
        if (!header || event.target.closest('input,button,select,textarea,a,[contenteditable="true"]')) return;
        const sheet = header.parentElement;
        const rect = sheet.getBoundingClientRect();
        sheet.style.zIndex = String(++zSerial);
        drag = { sheet, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        event.preventDefault();
        event.stopPropagation();
      }

      function pointerMove(event) {
        if (!drag || drag.pointerId !== event.pointerId || !drag.sheet.isConnected) return;
        drag.sheet.style.left = `${Math.max(8, Math.min(windowNode.innerWidth - 80, drag.left + event.clientX - drag.x))}px`;
        drag.sheet.style.top = `${Math.max(8, Math.min(windowNode.innerHeight - 56, drag.top + event.clientY - drag.y))}px`;
        event.preventDefault();
        event.stopPropagation();
      }

      function pointerUp(event) {
        if (drag?.pointerId === event.pointerId) drag = null;
      }

      documentNode.addEventListener('pointerdown', pointerDown, true);
      documentNode.addEventListener('pointermove', pointerMove, true);
      documentNode.addEventListener('pointerup', pointerUp, true);
      documentNode.addEventListener('pointercancel', pointerUp, true);
      api.on?.('app:destroy', () => {
        drag = null;
        documentNode.removeEventListener('pointerdown', pointerDown, true);
        documentNode.removeEventListener('pointermove', pointerMove, true);
        documentNode.removeEventListener('pointerup', pointerUp, true);
        documentNode.removeEventListener('pointercancel', pointerUp, true);
      });
    },
  });
}
