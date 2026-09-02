export function createEntitySystem(options = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const windowNode = documentNode.defaultView;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const actorTabbar = shell.querySelector?.('.sidebar .tabbar');
      const abort = new AbortController();
      const dragOptions = { capture: true, signal: abort.signal };
      let loading = null;
      let destroyed = false;
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

      documentNode.addEventListener('pointerdown', pointerDown, dragOptions);
      documentNode.addEventListener('pointermove', pointerMove, dragOptions);
      documentNode.addEventListener('pointerup', () => { drag = null; }, dragOptions);

      async function load() {
        if (destroyed) return null;
        if (!loading) loading = import('../ui/lazy-runtime-tools.js').then(({ createEntityUiTool }) => {
          if (destroyed) return null;
          actorTabbar?.removeEventListener('click', handleActorTabClick, true);
          mapElement.removeEventListener('dblclick', handleTokenDoubleClick, true);
          createEntityUiTool(options).register(api);
          return api.entities;
        });
        return loading;
      }

      function invoke(method, ...args) {
        return load().then(entityApi => entityApi?.[method]?.(...args));
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
          || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
        const tokenId = api.selection?.getPrimaryTokenId?.();
        if (!tokenId) return;
        void invoke('openToken', tokenId);
      }

      api.entities = {
        canImportXlsx: typeof api.ruleset?.importers?.xlsx?.importFile === 'function',
        openActor: (...args) => invoke('openActor', ...args),
        openToken: (...args) => invoke('openToken', ...args),
        placeActor: (...args) => invoke('placeActor', ...args),
        requestImport: (...args) => invoke('requestImport', ...args),
        closeSheet: (...args) => invoke('closeSheet', ...args),
      };
      actorTabbar?.addEventListener('click', handleActorTabClick, true);
      mapElement.addEventListener('dblclick', handleTokenDoubleClick, true);
      documentNode.addEventListener('keydown', handleCharacterSheetKey, true);
      api.on?.('app:destroy', () => {
        destroyed = true;
        abort.abort();
        actorTabbar?.removeEventListener('click', handleActorTabClick, true);
        mapElement.removeEventListener('dblclick', handleTokenDoubleClick, true);
        documentNode.removeEventListener('keydown', handleCharacterSheetKey, true);
      });
    },
  };
}
