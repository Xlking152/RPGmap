export function createEntitySystem(options = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const windowNode = documentNode.defaultView;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const actorTabbar = shell.querySelector('.sidebar .tabbar');
      const abort = new AbortController();
      const dragOptions = { signal: abort.signal };
      const captureOptions = { capture: true, signal: abort.signal };
      let loading = null;
      let destroyed = false;
      let drag = null;
      let geometryPointer = null;
      let pendingImport = null;

      const xlsxInput = documentNode.createElement('input');
      xlsxInput.type = 'file';
      xlsxInput.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      xlsxInput.hidden = true;
      (shell.querySelector('.toolbar-right') || shell).append(xlsxInput);

      function focusWindowFromEvent(event) {
        const sheet = event.target?.closest?.('.entity-sheet');
        const key = String(sheet?.dataset?.sheetWindowKey || '');
        if (key) api.entities?.focusSheet?.(key);
        return { sheet, key };
      }

      function pointerDown(event) {
        const { sheet, key } = focusWindowFromEvent(event);
        geometryPointer = sheet && key ? { sheet, key } : null;
        if (windowNode.innerWidth <= 760 || event.button || event.target.closest('input,button,select,textarea,a')) return;
        const header = event.target.closest('.entity-sheet-header');
        if (!header || !sheet) return;
        const rect = sheet.getBoundingClientRect();
        drag = { sheet, key, x: event.clientX - rect.left, y: event.clientY - rect.top };
        event.preventDefault();
      }

      function pointerMove(event) {
        if (!drag) return;
        drag.sheet.style.left = `${Math.max(8, Math.min(windowNode.innerWidth - 80, event.clientX - drag.x))}px`;
        drag.sheet.style.top = `${Math.max(8, Math.min(windowNode.innerHeight - 56, event.clientY - drag.y))}px`;
      }

      function pointerUp() {
        const target = drag || geometryPointer;
        drag = null;
        geometryPointer = null;
        if (!target?.sheet?.isConnected || !target.key) return;
        api.entities?.captureSheetGeometry?.(target.key, target.sheet.getBoundingClientRect());
      }

      function pointerCancel() {
        drag = null;
        geometryPointer = null;
      }

      documentNode.addEventListener('pointerdown', pointerDown, dragOptions);
      documentNode.addEventListener('pointermove', pointerMove, dragOptions);
      documentNode.addEventListener('pointerup', pointerUp, dragOptions);
      documentNode.addEventListener('pointercancel', pointerCancel, dragOptions);
      documentNode.addEventListener('focusin', focusWindowFromEvent, dragOptions);
      // Capture submit before the lazy sheet runtime consumes it so keyboard-only
      // form submission always resolves against the form's own live window.
      documentNode.addEventListener('submit', focusWindowFromEvent, captureOptions);

      async function load() {
        if (destroyed) return null;
        if (!loading) loading = import('../ui/lazy-runtime-tools.js').then(({
          createEntityUiTool,
          installActorSheetOpenPolicy,
        }) => {
          if (destroyed) return null;
          actorTabbar?.removeEventListener('click', handleActorTabClick, true);
          mapElement.removeEventListener('dblclick', handleTokenDoubleClick, true);
          createEntityUiTool(options).register(api);
          installActorSheetOpenPolicy(api);
          return api.entities;
        });
        return loading;
      }

      function invoke(method, ...args) {
        return load().then(entityApi => entityApi?.[method]?.(...args));
      }

      function requestImport(request = {}) {
        const normalized = typeof request === 'string' ? { actorType: request } : (request || {});
        pendingImport = {
          actorId: String(normalized.actorId || '').trim() || null,
          actorType: ['pc', 'monster', 'npc', 'summon'].includes(String(normalized.actorType))
            ? String(normalized.actorType)
            : 'pc',
        };
        // This click must stay in the original trusted user gesture. Loading the
        // XLSX runtime before opening the picker loses activation in Edge/Chrome.
        xlsxInput.value = '';
        xlsxInput.click();
        return true;
      }

      async function handleImportFile() {
        const file = xlsxInput.files?.[0] || null;
        const context = pendingImport || { actorId: null, actorType: 'pc' };
        pendingImport = null;
        xlsxInput.value = '';
        if (!file) return;
        try {
          const entityApi = await load();
          await entityApi?.importFile?.(file, context);
        } catch (error) {
          console.error('[RPGmap Entity Import] failed', error);
          api.showToast?.(`角色卡导入失败：${error?.message || error}`, 'error');
        }
      }

      function handleActorTabClick(event) {
        if (event.target?.closest?.('[data-ui-panel="actors"]')) void load();
      }

      function handleTokenDoubleClick(event) {
        if (!event.target?.closest?.('.rpg-token-v2')) return;
        const tokenId = api.selection?.getPrimaryTokenId?.();
        if (tokenId) void invoke('openToken', tokenId);
      }

      function handleCharacterSheetKey(event) {
        if (event.code !== 'KeyC'
          || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
          || event.target?.closest?.('input,textarea,select,[contenteditable]')) return;
        const tokenId = api.selection?.getPrimaryTokenId?.();
        if (tokenId) void invoke('openToken', tokenId);
      }

      api.entities = {
        canImportXlsx: typeof api.ruleset?.importers?.xlsx?.importFile === 'function',
        openActor: (...args) => invoke('openActor', ...args),
        openToken: (...args) => invoke('openToken', ...args),
        placeActor: (...args) => invoke('placeActor', ...args),
        requestImport,
        removeActor: (...args) => invoke('removeActor', ...args),
      };
      xlsxInput.addEventListener('change', handleImportFile, { signal: abort.signal });
      actorTabbar?.addEventListener('click', handleActorTabClick, true);
      mapElement.addEventListener('dblclick', handleTokenDoubleClick, true);
      documentNode.addEventListener('keydown', handleCharacterSheetKey, true);
      api.on?.('app:destroy', () => {
        destroyed = true;
        abort.abort();
        actorTabbar?.removeEventListener('click', handleActorTabClick, true);
        mapElement.removeEventListener('dblclick', handleTokenDoubleClick, true);
        documentNode.removeEventListener('keydown', handleCharacterSheetKey, true);
        pendingImport = null;
        xlsxInput.remove();
      });
    },
  };
}
