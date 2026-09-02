const STYLE_ID = 'rpgmap-entity-sheet-window-style';
const MIN_WIDTH = 360;
const MIN_HEIGHT = 260;
let zSerial = 4300;

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .entity-sheet-backdrop.entity-sheet-window-layer {
      background:transparent !important;
      display:block !important;
      padding:0 !important;
      pointer-events:none !important;
    }
    .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet {
      position:fixed;
      left:24px;
      top:72px;
      width:min(880px,calc(100vw - 48px));
      min-width:${MIN_WIDTH}px;
      min-height:${MIN_HEIGHT}px;
      max-width:calc(100vw - 16px);
      max-height:calc(100vh - 16px);
      margin:0;
      overflow:auto;
      resize:both;
      pointer-events:auto;
    }
    .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet > .entity-sheet-header {
      cursor:move;
    }
    .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet > .entity-sheet-header input,
    .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet > .entity-sheet-header button,
    .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet > .entity-sheet-header select,
    .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet > .entity-sheet-header textarea,
    .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet > .entity-sheet-header a {
      cursor:auto;
    }
    @media(max-width:760px) {
      .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet {
        left:8px !important;
        top:8px !important;
        width:calc(100vw - 16px) !important;
        height:calc(100vh - 16px) !important;
        min-width:0;
        min-height:0;
        max-width:none;
        max-height:none;
        resize:none;
      }
      .entity-sheet-backdrop.entity-sheet-window-layer > .entity-sheet > .entity-sheet-header { cursor:auto; }
    }
  `;
  documentNode.head.append(style);
}

function sheetKey(sheet) {
  const tokenId = String(sheet?.dataset?.tokenId || '');
  const actorId = String(sheet?.dataset?.actorId || '');
  const mode = String(sheet?.dataset?.sheetMode || 'template');
  return tokenId ? `token:${tokenId}` : `${mode}:${actorId}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function createSheetWindowBehavior() {
  return Object.freeze({
    register(api) {
      const mapElement = api?.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document;
      const windowNode = documentNode?.defaultView || globalThis.window;
      if (!documentNode?.body || !windowNode) return;
      installStyles(documentNode);

      const geometry = new Map();
      let drag = null;
      let destroyed = false;

      function save(sheet) {
        if (!sheet?.isConnected || windowNode.innerWidth <= 760) return;
        const rect = sheet.getBoundingClientRect();
        geometry.set(sheetKey(sheet), {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          zIndex: Number(sheet.style.zIndex) || zSerial,
        });
      }

      function bringToFront(sheet) {
        if (!sheet) return;
        zSerial += 1;
        sheet.style.zIndex = String(zSerial);
        const record = geometry.get(sheetKey(sheet));
        if (record) record.zIndex = zSerial;
      }

      function applyGeometry(sheet) {
        if (windowNode.innerWidth <= 760) return;
        const record = geometry.get(sheetKey(sheet));
        if (record) {
          const maxLeft = Math.max(8, windowNode.innerWidth - MIN_WIDTH);
          const maxTop = Math.max(8, windowNode.innerHeight - 80);
          sheet.style.left = `${clamp(record.left, 8, maxLeft)}px`;
          sheet.style.top = `${clamp(record.top, 8, maxTop)}px`;
          sheet.style.width = `${clamp(record.width, MIN_WIDTH, Math.max(MIN_WIDTH, windowNode.innerWidth - 16))}px`;
          sheet.style.height = `${clamp(record.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, windowNode.innerHeight - 16))}px`;
          sheet.style.zIndex = String(record.zIndex || ++zSerial);
          return;
        }
        const rect = sheet.getBoundingClientRect();
        const cascade = geometry.size % 6;
        const width = Math.min(Math.max(rect.width || 760, MIN_WIDTH), Math.max(MIN_WIDTH, windowNode.innerWidth - 32));
        const height = Math.min(Math.max(rect.height || 620, MIN_HEIGHT), Math.max(MIN_HEIGHT, windowNode.innerHeight - 32));
        const left = clamp(windowNode.innerWidth - width - 24 - cascade * 18, 8, Math.max(8, windowNode.innerWidth - MIN_WIDTH));
        const top = clamp(68 + cascade * 18, 8, Math.max(8, windowNode.innerHeight - 80));
        sheet.style.left = `${left}px`;
        sheet.style.top = `${top}px`;
        sheet.style.width = `${width}px`;
        sheet.style.height = `${height}px`;
        bringToFront(sheet);
        save(sheet);
      }

      function wire(root) {
        const backdrop = root?.matches?.('.entity-sheet-backdrop') ? root : root?.querySelector?.('.entity-sheet-backdrop');
        if (!backdrop) return;
        backdrop.classList.add('entity-sheet-window-layer');
        const sheet = backdrop.querySelector(':scope > .entity-sheet');
        if (!sheet) return;
        sheet.setAttribute('aria-modal', 'false');
        if (sheet.dataset.sheetWindowWired === 'true') return;
        sheet.dataset.sheetWindowWired = 'true';
        applyGeometry(sheet);
        sheet.addEventListener('pointerdown', () => bringToFront(sheet), { passive: true });
      }

      function wireAll() {
        for (const backdrop of documentNode.querySelectorAll('.entity-sheet-backdrop')) wire(backdrop);
      }

      const observer = new MutationObserver(records => {
        if (destroyed) return;
        for (const record of records) {
          for (const node of record.addedNodes) if (node?.nodeType === 1) wire(node);
        }
      });
      observer.observe(documentNode.body, { childList: true, subtree: true });
      wireAll();

      function pointerDown(event) {
        if (windowNode.innerWidth <= 760 || event.button !== 0) return;
        const header = event.target?.closest?.('.entity-sheet-window-layer > .entity-sheet > .entity-sheet-header');
        if (!header || event.target.closest('input,button,select,textarea,a,[contenteditable="true"]')) return;
        const sheet = header.parentElement;
        if (!sheet) return;
        const rect = sheet.getBoundingClientRect();
        bringToFront(sheet);
        drag = {
          sheet,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          left: rect.left,
          top: rect.top,
        };
        event.preventDefault();
        event.stopPropagation();
      }

      function pointerMove(event) {
        if (!drag || drag.pointerId !== event.pointerId || !drag.sheet?.isConnected) return;
        const maxLeft = Math.max(8, windowNode.innerWidth - Math.min(MIN_WIDTH, drag.sheet.offsetWidth));
        const maxTop = Math.max(8, windowNode.innerHeight - 56);
        drag.sheet.style.left = `${clamp(drag.left + event.clientX - drag.startX, 8, maxLeft)}px`;
        drag.sheet.style.top = `${clamp(drag.top + event.clientY - drag.startY, 8, maxTop)}px`;
        event.preventDefault();
        event.stopPropagation();
      }

      function pointerUp(event) {
        if (!drag || drag.pointerId !== event.pointerId) return;
        save(drag.sheet);
        drag = null;
      }

      function saveWindowGeometry(event) {
        const sheet = event.target?.closest?.('.entity-sheet-window-layer > .entity-sheet');
        if (sheet) queueMicrotask(() => save(sheet));
      }

      documentNode.addEventListener('pointerdown', pointerDown, true);
      documentNode.addEventListener('pointermove', pointerMove, true);
      documentNode.addEventListener('pointerup', pointerUp, true);
      documentNode.addEventListener('pointercancel', pointerUp, true);
      documentNode.addEventListener('mouseup', saveWindowGeometry, true);
      windowNode.addEventListener('resize', wireAll);

      api.on?.('app:destroy', () => {
        destroyed = true;
        drag = null;
        observer.disconnect();
        documentNode.removeEventListener('pointerdown', pointerDown, true);
        documentNode.removeEventListener('pointermove', pointerMove, true);
        documentNode.removeEventListener('pointerup', pointerUp, true);
        documentNode.removeEventListener('pointercancel', pointerUp, true);
        documentNode.removeEventListener('mouseup', saveWindowGeometry, true);
        windowNode.removeEventListener('resize', wireAll);
      });
    },
  });
}
