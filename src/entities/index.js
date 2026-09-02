import { createSheetWindowBehavior } from './sheet-window-behavior.js';

export function createEntitySystem(options = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const actorTabbar = shell.querySelector?.('.sidebar .tabbar');
      let loading = null;
      let destroyed = false;

      createSheetWindowBehavior().register(api);

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
        const tokenNode = event.target?.closest?.('.rpg-token-v2');
        if (!tokenNode) return;
        const tokenId = tokenNode.querySelector?.('[data-token-id]')?.dataset?.tokenId
          || api.selection?.getPrimaryTokenId?.();
        if (tokenId) void invoke('openToken', tokenId);
      }

      function handleCharacterSheetKey(event) {
        if (event.defaultPrevented || event.repeat || event.isComposing
          || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
          || event.key?.toLowerCase() !== 'c'
          || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
        const tokenId = api.selection?.getPrimaryTokenId?.();
        const caps = api.multiplayer?.getCapabilities?.();
        const actorId = !tokenId && caps?.connected === true && caps.role !== 'gm'
          ? api.multiplayer?.getStatus?.()?.session?.defaultActorId || null
          : null;
        if (!tokenId && !actorId) return;
        event.preventDefault();
        const sheet = documentNode.querySelector?.('.entity-sheet');
        const same = tokenId
          ? String(sheet?.dataset?.tokenId || '') === String(tokenId)
          : !sheet?.dataset?.tokenId && String(sheet?.dataset?.actorId || '') === String(actorId);
        void invoke(same ? 'closeSheet' : tokenId ? 'openToken' : 'openActor', tokenId || actorId);
      }

      api.entities = {
        lazy: true,
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
        actorTabbar?.removeEventListener('click', handleActorTabClick, true);
        mapElement.removeEventListener('dblclick', handleTokenDoubleClick, true);
        documentNode.removeEventListener('keydown', handleCharacterSheetKey, true);
      });
    },
  };
}
