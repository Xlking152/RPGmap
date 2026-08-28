import L from 'leaflet';
import { latLngToWorld, worldToLatLng, formatDistance } from '../engine/geometry.js';
import { snapMovementPoint } from './snap.js';

const DRAG_THRESHOLD_PX = 5;

function inside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

function createConfirmControls(documentNode, mapElement) {
  const controls = documentNode.createElement('div');
  controls.className = 'fvtt-move-confirm';
  Object.assign(controls.style, {
    position: 'absolute', left: '50%', bottom: '44px', transform: 'translateX(-50%)',
    display: 'none', gap: '8px', alignItems: 'center', zIndex: '1200', padding: '8px 10px',
    borderRadius: '10px', background: 'rgba(30,34,38,.9)', boxShadow: '0 6px 20px rgba(0,0,0,.24)',
  });
  const confirm = documentNode.createElement('button');
  confirm.type = 'button'; confirm.className = 'small-button primary'; confirm.textContent = '确认移动';
  const cancel = documentNode.createElement('button');
  cancel.type = 'button'; cancel.className = 'small-button'; cancel.textContent = '取消';
  const hint = documentNode.createElement('span');
  hint.style.cssText = 'color:#fff;font-size:12px;opacity:.78;'; hint.textContent = 'Enter 确认 · Esc 取消';
  controls.append(confirm, cancel, hint);
  const host = mapElement.parentElement;
  if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host?.append(controls);
  return { controls, confirm, cancel };
}

function tokenIdFromTarget(target) {
  const root = target?.closest?.('.rpg-token-v2');
  return root?.querySelector?.('[data-token-id]')?.dataset?.tokenId || null;
}

export function createMovementControllerV2({ settings } = {}) {
  return Object.freeze({
    register(api) {
      if (!settings) throw new Error('Movement V2 requires MovementSettings');
      if (!api.movement?.canonicalSceneTokens || !api.tokens?.get || !api.selection) {
        throw new Error('Movement V2 requires canonical Token Runtime');
      }
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const routeLayer = L.layerGroup([], { pane: 'measurePane' }).addTo(api.map);
      const controls = createConfirmControls(documentNode, mapElement);
      let selectedTokenId = api.selection.getPrimaryTokenId?.() || null;
      let activeTokenId = null;
      let pendingRoute = null;
      let pointerDrag = null;
      let destroyed = false;
      const off = [];

      const status = message => api.setStatus?.(message);
      const showControls = value => { controls.controls.style.display = value ? 'flex' : 'none'; };
      const token = tokenId => tokenId ? api.tokens.get(tokenId) : null;
      const mapToken = tokenId => {
        const value = token(tokenId);
        return value?.placement === 'map' ? value : null;
      };
      const worldPoint = event => latLngToWorld(api.map.mouseEventToLatLng(event), api.mapPackage.height);
      const snapPoint = point => {
        const snapped = snapMovementPoint(point, settings.step);
        return {
          x: Math.max(0, Math.min(api.mapPackage.width, snapped.x)),
          y: Math.max(0, Math.min(api.mapPackage.height, snapped.y)),
        };
      };

      function clearPreview(message = '') {
        pendingRoute = null;
        routeLayer.clearLayers();
        showControls(false);
        if (message) status(message);
      }

      function finish(message = '浏览模式') {
        activeTokenId = null;
        pointerDrag = null;
        clearPreview();
        if (api.getTool?.() === 'token-move') api.setTool?.('pan');
        if (message) status(message);
      }

      function drawRoute(route) {
        routeLayer.clearLayers();
        if (!route?.valid) return;
        const points = Array.isArray(route.points) && route.points.length > 1
          ? route.points
          : null;
        if (points) {
          L.polyline(points.map(point => worldToLatLng(point, api.mapPackage.height)), {
            pane: 'measurePane',
            color: '#176d76',
            weight: 4,
            dashArray: '10 7',
            interactive: false,
            className: 'token-route-preview',
          }).addTo(routeLayer);
        }
        const destination = route.destination || points?.at(-1);
        if (destination) {
          L.circleMarker(worldToLatLng(destination, api.mapPackage.height), {
            pane: 'measurePane', radius: 9, color: '#176d76', weight: 2,
            fillColor: '#176d76', fillOpacity: .18, interactive: false,
          }).addTo(routeLayer);
          L.tooltip({ permanent: true, direction: 'top', className: 'marker-tooltip', pane: 'measurePane' })
            .setLatLng(worldToLatLng(destination, api.mapPackage.height))
            .setContent(formatDistance(Number(route.distance) || 0))
            .addTo(routeLayer);
        }
      }

      async function plan(tokenId, rawPoint) {
        const current = mapToken(tokenId);
        if (!current || !inside(rawPoint, api.mapPackage)) {
          clearPreview('请先选择一个位于地图上的 Token');
          return null;
        }
        const destination = snapPoint(rawPoint);
        const route = await api.movement.planTokenMove(current.id, destination);
        if (!route) {
          clearPreview('目标不可达，或当前状态/权限禁止移动');
          return null;
        }
        pendingRoute = { tokenId: current.id, route };
        drawRoute(route);
        showControls(true);
        status(`路线已就绪 · ${formatDistance(Number(route.distance) || 0)} · 吸附 ${settings.step} m`);
        return route;
      }

      function begin(tokenId = selectedTokenId) {
        const current = mapToken(tokenId);
        if (!current) {
          status('请先选择一个位于地图上的 Token');
          return false;
        }
        activeTokenId = String(current.id);
        selectedTokenId = String(current.id);
        api.selection.replace?.([current.id], current.id);
        api.setTool?.('token-move');
        clearPreview(`移动 Token：点击或拖动到目标位置 · 当前吸附 ${settings.step} m`);
        return true;
      }

      function commit() {
        if (!pendingRoute || String(pendingRoute.tokenId) !== String(activeTokenId)) return false;
        if (!api.movement.commitTokenMove()) return false;
        status('正在等待服务器确认移动…');
        showControls(false);
        return true;
      }

      controls.confirm.addEventListener('click', commit);
      controls.cancel.addEventListener('click', () => finish('移动已取消'));

      const selectionOff = api.selection.subscribe?.(snapshot => {
        selectedTokenId = snapshot?.primaryId || null;
        if (activeTokenId && String(activeTokenId) !== String(selectedTokenId)) finish('已切换 Token，移动规划取消');
      });
      if (selectionOff) off.push(selectionOff);

      const pointerDown = event => {
        if (destroyed || event.button !== 0) return;
        const tokenId = tokenIdFromTarget(event.target);
        if (!tokenId) return;
        const current = mapToken(tokenId);
        if (!current) return;
        selectedTokenId = String(current.id);
        api.selection.replace?.([current.id], current.id);
        pointerDrag = {
          tokenId: String(current.id),
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
        };
      };

      const pointerUp = event => {
        if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
        const drag = pointerDrag;
        pointerDrag = null;
        const distance = Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY);
        if (distance < DRAG_THRESHOLD_PX) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!begin(drag.tokenId)) return;
        void plan(drag.tokenId, worldPoint(event));
      };

      const mapClick = event => {
        if (destroyed || api.getTool?.() !== 'token-move' || !activeTokenId) return;
        if (event.originalEvent?.target?.closest?.('.rpg-token-v2,.leaflet-control,.fvtt-move-confirm')) return;
        const point = latLngToWorld(event.latlng, api.mapPackage.height);
        if (!inside(point, api.mapPackage)) return;
        void plan(activeTokenId, point);
      };

      const keydown = event => {
        if (event.defaultPrevented || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
        if (event.key === 'Escape' && activeTokenId) {
          event.preventDefault();
          finish('移动已取消');
        } else if (event.key === 'Enter' && pendingRoute) {
          event.preventDefault();
          commit();
        }
      };

      mapElement.addEventListener('pointerdown', pointerDown, true);
      mapElement.addEventListener('pointerup', pointerUp, true);
      api.map.on('click', mapClick);
      documentNode.addEventListener('keydown', keydown, true);

      off.push(api.on?.('token:move', event => {
        if (!activeTokenId || String(event.detail?.tokenId || event.detail?.id) !== String(activeTokenId)) return;
        finish('Token 移动完成');
      }));
      off.push(api.on?.('token:move-cancelled', event => {
        if (!activeTokenId || String(event.detail?.tokenId || event.detail?.id) !== String(activeTokenId)) return;
        finish(`移动未提交：${event.detail?.reason || '服务器拒绝操作'}`);
      }));
      for (const name of ['state:import', 'scene:damage', 'scene:restore', 'status:change']) {
        off.push(api.on?.(name, () => { if (activeTokenId) finish('World 状态已变化，请重新规划移动'); }));
      }
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        mapElement.removeEventListener('pointerdown', pointerDown, true);
        mapElement.removeEventListener('pointerup', pointerUp, true);
        api.map.off('click', mapClick);
        documentNode.removeEventListener('keydown', keydown, true);
        controls.controls.remove();
        routeLayer.clearLayers();
        api.map.removeLayer?.(routeLayer);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.movementUi = Object.freeze({
        tokenFirst: true,
        begin,
        plan,
        commit,
        cancel: finish,
        get activeTokenId() { return activeTokenId; },
      });
    },
  });
}
