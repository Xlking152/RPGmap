import { latLngToWorld } from '../engine/geometry.js';
import { createActorTokenAtPoint } from './placement.js';

function actorId(value) {
  return String(value || '').trim();
}

function actorFingerprint(actor) {
  try { return JSON.stringify(actor); }
  catch { return String(actor?.id || ''); }
}

function setMapStatus(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node) node.textContent = message;
}

/**
 * Transitional bridge for the Character-era Entity UI.
 *
 * The existing panel/HUD still owns "which Actor is being placed", but the map
 * click is captured above Leaflet/AppCore so no legacy Character is created.
 * The write path is exclusively createActorTokenAtPoint() -> api.tokens.create().
 *
 * Delete this bridge once the Actor/Token editor itself is rewritten around
 * canonical Token APIs.
 */
export function createActorTokenPlacementUiSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.tokens?.create || !api?.world?.listActors) {
        throw new Error('Actor placement V2 requires World V2 + Token Runtime V2');
      }

      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      let pendingActorId = null;
      let activeSheetActorId = null;
      let placementBusy = false;
      let destroyed = false;
      let fingerprints = new Map();
      const off = [];

      function actors() {
        return api.world.listActors?.() || [];
      }

      function refreshActorFingerprints({ inferActive = true } = {}) {
        const nextActors = actors();
        const next = new Map(nextActors.map(actor => [actorId(actor?.id), actorFingerprint(actor)]));
        if (inferActive && fingerprints.size) {
          const changed = nextActors.filter(actor => fingerprints.get(actorId(actor?.id)) !== actorFingerprint(actor));
          if (changed.length === 1) activeSheetActorId = actorId(changed[0]?.id);
        }
        fingerprints = next;
      }

      function actorExists(id) {
        const target = actorId(id);
        return Boolean(target && actors().some(actor => actorId(actor?.id) === target));
      }

      function resolveSheetActorId() {
        if (actorExists(activeSheetActorId)) return activeSheetActorId;
        const input = documentNode.querySelector?.('.entity-sheet [data-actor-name]');
        const name = String(input?.value || '').trim();
        if (!name) return null;
        const matches = actors().filter(actor => String(actor?.name || '').trim() === name);
        return matches.length === 1 ? actorId(matches[0]?.id) : null;
      }

      function clearPending() {
        pendingActorId = null;
        placementBusy = false;
      }

      function captureEntityIntent(event) {
        const cancel = event.target?.closest?.('[data-entity-placement-cancel]');
        if (cancel) { clearPending(); return; }

        const panelAction = event.target?.closest?.('[data-entity-action]');
        if (panelAction) {
          const action = panelAction.dataset.entityAction;
          const id = actorId(panelAction.dataset.id);
          if (action === 'open' && id) activeSheetActorId = id;
          if (action === 'place' && id) {
            activeSheetActorId = id;
            pendingActorId = id;
          }
          return;
        }

        const sheetAction = event.target?.closest?.('[data-sheet-action]');
        if (sheetAction?.dataset.sheetAction === 'place-token') {
          const id = resolveSheetActorId();
          if (id) pendingActorId = id;
          else setMapStatus(shell, '无法确定当前角色；请从角色列表使用“放置 Token”');
        }
      }

      async function captureMapPlacement(event) {
        if (destroyed || !pendingActorId || placementBusy) return;
        if (!mapElement.contains(event.target)) return;
        if (!documentNode.querySelector?.('.entity-placement-hud')) return;
        if (event.target?.closest?.('.leaflet-control, .rpg-character, .rpg-character-core, .rpg-token-v2, .leaflet-marker-icon')) return;

        const latlng = api.map.mouseEventToLatLng?.(event);
        if (!latlng) return;
        event.preventDefault();
        event.stopImmediatePropagation();

        const id = pendingActorId;
        if (!actorExists(id)) {
          clearPending();
          setMapStatus(shell, '待放置 Actor 已不存在，已取消放置');
          documentNode.querySelector?.('[data-entity-placement-cancel]')?.click?.();
          return;
        }
        const capabilities = api.multiplayer?.getCapabilities?.();
        if (capabilities?.canPlaceActor && !capabilities.canPlaceActor(id)) {
          clearPending();
          setMapStatus(shell, '当前没有该 Actor 的 Token 放置权限');
          documentNode.querySelector?.('[data-entity-placement-cancel]')?.click?.();
          return;
        }

        placementBusy = true;
        setMapStatus(shell, '正在创建 Scene Token…');
        try {
          const point = latLngToWorld(latlng, api.mapPackage.height);
          const result = await createActorTokenAtPoint(api, id, point);
          if (!result.ok || !result.token) {
            setMapStatus(shell, '该位置不可放置 Token；请选择地图中的可通行位置，或点击取消');
            return;
          }

          const token = result.token;
          pendingActorId = null;
          // Let the old UI clear only its transient HUD/private pending flag.
          // This performs no data write.
          documentNode.querySelector?.('[data-entity-placement-cancel]')?.click?.();

          // World V2 has already projected this Scene Token into the temporary
          // Character/Entity compatibility view. Reuse the compatibility event
          // only to make the old panel reload that projection; it must not bind
          // or create the Token.
          api.emit?.('character:create', {
            id: token.id,
            tokenId: token.id,
            actorId: token.actorId,
            source: 'token-v2:compat-projection',
          });
          api.selection?.replace?.([token.id], token.id);
          api.selectCharacter?.(token.id);
          api.emit?.('token:create', {
            id: token.id,
            tokenId: token.id,
            actorId: token.actorId,
            token,
            source: 'actor-placement-v2',
          });
          setMapStatus(shell, `Token 已创建并加入当前 Scene：${token.id}`);
        } catch (error) {
          console.error('[RPGmap Actor Placement V2] create failed', error);
          setMapStatus(shell, `Token 创建失败：${error?.message || error}`);
        } finally {
          placementBusy = false;
        }
      }

      function handleKeydown(event) {
        if (event.key === 'Escape' && pendingActorId) clearPending();
      }

      documentNode.addEventListener('click', captureEntityIntent, true);
      // Document capture runs before Entity UI's mapElement capture listener and
      // before Leaflet/AppCore, so one click can never also call placeCharacter().
      documentNode.addEventListener('click', captureMapPlacement, true);
      documentNode.addEventListener('keydown', handleKeydown, true);

      off.push(api.on('character:select', event => {
        const token = api.tokens.get?.(event.detail?.id);
        if (token?.actorId) activeSheetActorId = actorId(token.actorId);
      }));
      off.push(api.on('state:commit', () => refreshActorFingerprints()));
      off.push(api.on('state:import', () => {
        clearPending();
        refreshActorFingerprints({ inferActive: false });
      }));
      off.push(api.on('app:destroy', () => {
        destroyed = true;
        documentNode.removeEventListener('click', captureEntityIntent, true);
        documentNode.removeEventListener('click', captureMapPlacement, true);
        documentNode.removeEventListener('keydown', handleKeydown, true);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      refreshActorFingerprints({ inferActive: false });
      api.actorPlacement = Object.freeze({
        canonicalTokenCreate: true,
        getPendingActorId() { return pendingActorId; },
        cancel() {
          clearPending();
          documentNode.querySelector?.('[data-entity-placement-cancel]')?.click?.();
        },
      });
    },
  });
}
