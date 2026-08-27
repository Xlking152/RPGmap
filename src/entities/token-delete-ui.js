import {
  deleteCanonicalActor,
  deleteCanonicalToken,
  listWorldActorTokens,
} from './canonical-delete.js';

function id(value) {
  return String(value ?? '').trim();
}

function tokenIdFromCard(card) {
  const carrier = card?.querySelector?.(
    '[data-token-diameter], [data-sheet-action="reposition-token"], [data-sheet-action="edit-token-elevation"]',
  );
  return id(card?.dataset?.tokenId || carrier?.dataset?.tokenId || carrier?.dataset?.characterId) || null;
}

function canManageStructure(api) {
  return api.multiplayer?.getCapabilities?.()?.canManageStructure !== false;
}

function setStatus(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node) node.textContent = message;
}

function confirmWith(documentNode, message) {
  const confirmFn = documentNode?.defaultView?.confirm || globalThis.confirm;
  return typeof confirmFn === 'function' ? confirmFn(message) : true;
}

export function createEntityTokenDeleteUiSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.tokens?.remove || !api?.world?.get || !api?.world?.commit) {
        throw new Error('Entity Token Delete V2 requires canonical Token/World runtime');
      }

      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || document;
      const shell = mapElement?.closest?.('.app-shell') || documentNode;
      const legacyDeleteCharacter = api.deleteCharacter;
      let destroyed = false;
      let syncQueued = false;
      let deleteBusy = false;
      const off = [];

      function scheduleSync() {
        if (destroyed || syncQueued) return;
        syncQueued = true;
        queueMicrotask(syncDeleteControls);
      }

      function syncActorCards() {
        const actorIds = new Set((api.world.listActors?.() || api.world.get().actors || []).map(actor => id(actor?.id)));
        for (const card of documentNode.querySelectorAll?.('[data-entity-list] .entity-card[data-actor-id]') || []) {
          if (!actorIds.has(id(card.dataset.actorId))) card.remove();
        }
      }

      function syncTokenDeleteButtons() {
        const allowed = canManageStructure(api);
        for (const card of documentNode.querySelectorAll?.('.entity-sheet .entity-card') || []) {
          const tokenId = tokenIdFromCard(card);
          if (!tokenId) continue;
          if (!api.tokens.get(tokenId)) {
            card.remove();
            continue;
          }
          let button = card.querySelector?.('[data-entity-token-delete-v2]');
          if (!allowed) {
            button?.remove();
            continue;
          }
          if (!button) {
            button = documentNode.createElement('button');
            button.type = 'button';
            button.className = 'small-button danger';
            button.textContent = '删除 Token';
            button.dataset.entityTokenDeleteV2 = '';
            card.querySelector?.('.entity-card-actions')?.append(button);
          }
          button.dataset.tokenId = tokenId;
          button.dataset.deleteSource = 'api.tokens.remove';
        }
      }

      function syncDeleteControls() {
        syncQueued = false;
        if (destroyed) return;
        syncActorCards();
        syncTokenDeleteButtons();
      }

      async function canonicalDeleteCharacter(tokenId) {
        const target = id(tokenId);
        if (!target) return null;
        return deleteCanonicalToken(api, target);
      }

      // Public compatibility callers must not be able to bypass the canonical
      // Scene Token runtime by calling the old AppCore Character deletion API.
      // Interactive buttons are captured below so they can still show the GM
      // confirmation dialog before this no-UI compatibility facade runs.
      api.deleteCharacter = canonicalDeleteCharacter;

      async function removeToken(tokenId) {
        const token = api.tokens.get(tokenId);
        if (!token) return null;
        if (!canManageStructure(api)) {
          setStatus(shell, '只有 GM 可以删除 Token');
          return null;
        }
        let actorName = '';
        try { actorName = api.tokens.resolveActor?.(token.id)?.actor?.name || ''; } catch {}
        if (!confirmWith(documentNode, `删除 Token“${actorName || token.id}”？绑定到该 Token 的范围会转为自由锚点。`)) return null;
        const removed = await deleteCanonicalToken(api, token.id);
        setStatus(shell, `已删除 Token“${actorName || token.id}”`);
        api.entityTokenReads?.sync?.();
        scheduleSync();
        return removed;
      }

      async function removeActor(actorId) {
        if (!canManageStructure(api)) {
          setStatus(shell, '只有 GM 可以删除角色与关联 Token');
          return null;
        }
        const world = api.world.get();
        const actor = (world.actors || []).find(item => id(item?.id) === id(actorId));
        if (!actor) return null;
        const refs = listWorldActorTokens(world, actor.id);
        if (!confirmWith(documentNode, `删除角色“${actor.name || actor.id}”及其全部 ${refs.length} 个 Token（包含其他 Scene）？绑定范围会转为自由锚点，战斗中的缺失 Token 会自动移除。`)) return null;
        const result = await deleteCanonicalActor(api, actor.id);
        setStatus(shell, `已删除角色“${actor.name || actor.id}”及 ${result.tokens.length} 个 Token`);
        api.entityTokenReads?.sync?.();
        scheduleSync();
        return result;
      }

      async function captureDelete(event) {
        const tokenButton = event.target?.closest?.('[data-entity-token-delete-v2]');
        const legacyTokenButton = event.target?.closest?.('[data-action="delete-character"][data-id]');
        const actorButton = event.target?.closest?.('[data-entity-action="delete"][data-id]');
        if (!tokenButton && !legacyTokenButton && !actorButton) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        if (deleteBusy) return;
        deleteBusy = true;
        try {
          if (actorButton) await removeActor(actorButton.dataset.id);
          else await removeToken(tokenButton?.dataset?.tokenId || legacyTokenButton?.dataset?.id);
        } catch (error) {
          console.error('[RPGmap Entity Token Delete V2] delete failed', error);
          setStatus(shell, `删除失败：${error?.message || error}`);
        } finally {
          deleteBusy = false;
        }
      }

      documentNode.addEventListener('click', captureDelete, true);
      const observer = new MutationObserver(scheduleSync);
      observer.observe(documentNode.body, { childList: true, subtree: true });

      for (const eventName of [
        'state:commit', 'state:import', 'token:create', 'token:delete',
        'actor:delete', 'multiplayer:capabilities',
      ]) off.push(api.on?.(eventName, scheduleSync));

      api.entityTokenDelete = Object.freeze({
        canonicalSceneTokens: true,
        removeToken,
        removeActor,
        listActorTokens(actorId) { return listWorldActorTokens(api.world.get(), actorId); },
        sync: scheduleSync,
      });

      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        observer.disconnect();
        documentNode.removeEventListener('click', captureDelete, true);
        if (api.deleteCharacter === canonicalDeleteCharacter) api.deleteCharacter = legacyDeleteCharacter;
        off.splice(0).forEach(dispose => dispose?.());
      }));

      scheduleSync();
      api.emit?.('entity-token-delete:ready', { canonicalSceneTokens: true });
    },
  });
}
