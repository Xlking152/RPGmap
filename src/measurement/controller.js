import L from 'leaflet';
import { latLngToWorld, worldToLatLng } from '../engine/geometry.js';
import { ensurePathLabelPane, installPathLabelStyles, addPathDistanceLabel } from '../path/labels.js';
import { formatRulerDistance, summarizeRulerPath } from './distance.js';
import { RulerSession } from './session.js';

function inside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

function button(documentNode, label, className) {
  const node = documentNode.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

export function createRulerController() {
  return Object.freeze({
    register(api) {
      if (!api.tokens?.get || !api.selection) throw new Error('Ruler V2 requires canonical Token Runtime');
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      ensurePathLabelPane(api.map);
      installPathLabelStyles(documentNode);
      const routeLayer = L.layerGroup([], { pane: 'measurePane' }).addTo(api.map);
      const labelLayer = L.layerGroup([]).addTo(api.map);
      const session = new RulerSession();
      let enabled = false;
      let restoreDragging = false;
      const off = [];

      const status = message => api.setStatus?.(message);
      const pointFromEvent = event => latLngToWorld(api.map.mouseEventToLatLng(event), api.mapPackage.height);
      const mapToken = tokenId => {
        const token = tokenId ? api.tokens.get(tokenId) : null;
        return token?.placement === 'map' && token.hidden !== true ? token : null;
      };

      function render() {
        routeLayer.clearLayers();
        labelLayer.clearLayers();
        if (!session.active) return;
        const summary = summarizeRulerPath(session.points, api.mapPackage.metersPerUnit || 1);
        if (summary.points.length > 1) {
          L.polyline(summary.points.map(point => worldToLatLng(point, api.mapPackage.height)), {
            pane: 'measurePane', color: '#176d76', weight: 3, opacity: .92,
            dashArray: '8 6', interactive: false, className: 'rpgmap-ruler-route',
          }).addTo(routeLayer);
        }
        session.waypoints.forEach((point, index) => {
          L.circleMarker(worldToLatLng(point, api.mapPackage.height), {
            pane: 'measurePane', radius: 5, color: '#176d76', weight: 2,
            fillColor: '#fff', fillOpacity: 1, interactive: false,
          }).bindTooltip(`拐点 ${index + 1}`, { direction: 'top', pane: 'pathLabelPane' }).addTo(routeLayer);
        });
        summary.segments.forEach(segment => addPathDistanceLabel(
          labelLayer, api.mapPackage, segment.midpoint, formatRulerDistance(segment.distance),
        ));
        if (summary.points.length > 1) addPathDistanceLabel(
          labelLayer, api.mapPackage, summary.points.at(-1), `总 ${formatRulerDistance(summary.total)}`, { total: true },
        );
      }

      function clear(message = '测量已清除') {
        session.reset();
        render();
        if (message) status(message);
      }

      function activate() {
        if (enabled) return true;
        enabled = true;
        api.setTool?.('ruler');
        restoreDragging = api.map.dragging.enabled();
        if (restoreDragging) api.map.dragging.disable();
        rulerButton.classList.add('active');
        status('距离尺：左键设起点/终点 · Ctrl/Cmd+左键添加拐点 · 右键撤销 · Esc 清除 · R 退出');
        return true;
      }

      function deactivate({ clearRuler = false } = {}) {
        if (!enabled) return false;
        enabled = false;
        if (restoreDragging) api.map.dragging.enable();
        restoreDragging = false;
        rulerButton.classList.remove('active');
        if (clearRuler) clear('');
        api.setTool?.('pan');
        status('浏览模式');
        return true;
      }

      function toggle() {
        return enabled ? deactivate({ clearRuler: true }) : activate();
      }

      function startFromToken(tokenId) {
        const token = mapToken(tokenId);
        if (!token) {
          status('无法从该 Token 测距：Token 当前不在地图上');
          return false;
        }
        activate();
        session.begin({ x: Number(token.x), y: Number(token.y) });
        render();
        let name = '所选 Token';
        try { name = api.tokens.resolveActor?.(token.id)?.actor?.name || name; } catch {}
        status(`从 ${name} 开始测距 · 移动鼠标预览；Ctrl/Cmd+左键添加拐点，普通左键结束`);
        return true;
      }

      function startFromPrimarySelection() {
        const tokenId = api.selection.getPrimaryTokenId?.();
        if (!tokenId) {
          status('请先选择一个 Token，再使用 Token 测距');
          return false;
        }
        return startFromToken(tokenId);
      }

      const toolbar = shell.querySelector('.toolbar');
      const rulerButton = button(documentNode, '测量', 'ui-primary-tool ui-ruler-tool');
      rulerButton.title = '距离尺 · R';
      const tokenRulerButton = button(documentNode, 'Token测距', 'ui-primary-tool ui-token-ruler-tool');
      tokenRulerButton.title = '从当前主选择 Token 开始测距 · Shift+R';
      rulerButton.addEventListener('click', toggle);
      tokenRulerButton.addEventListener('click', startFromPrimarySelection);
      toolbar?.append(rulerButton, tokenRulerButton);

      function syncTokenButton() {
        const tokenId = api.selection.getPrimaryTokenId?.();
        tokenRulerButton.disabled = !mapToken(tokenId);
      }
      const selectionOff = api.selection.subscribe?.(syncTokenButton);
      if (selectionOff) off.push(selectionOff);
      off.push(api.on?.('token:move', syncTokenButton));
      off.push(api.on?.('token:delete', syncTokenButton));
      off.push(api.on?.('state:import', () => { clear(''); syncTokenButton(); }));
      syncTokenButton();

      const pointerDown = event => {
        if (!enabled || event.button !== 0) return;
        if (event.target.closest?.('.leaflet-control,.ui-primary-tool,.fvtt-move-confirm')) return;
        const point = pointFromEvent(event);
        if (!inside(point, api.mapPackage)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!session.active || session.finished) {
          session.begin(point);
          render();
          status('距离尺已开始 · 移动鼠标预览；Ctrl/Cmd+左键添加拐点，普通左键结束');
          return;
        }
        session.update(point);
        if (event.ctrlKey || event.metaKey) {
          session.addWaypoint(point);
          status(`已添加拐点 ${session.waypoints.length}`);
        } else {
          session.finish(point);
          status(`测量完成 · ${formatRulerDistance(summarizeRulerPath(session.points, api.mapPackage.metersPerUnit || 1).total)}`);
        }
        render();
      };
      const pointerMove = event => {
        if (!enabled || !session.active || session.finished) return;
        const point = pointFromEvent(event);
        if (!inside(point, api.mapPackage)) return;
        session.update(point);
        render();
      };
      const contextMenu = event => {
        if (!enabled || !session.active) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (session.waypoints.length) session.removeWaypoint(); else session.reset();
        render();
      };
      const keydown = event => {
        if (event.defaultPrevented || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        if (key === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          if (event.shiftKey) startFromPrimarySelection(); else toggle();
          return;
        }
        if (!enabled) return;
        if (event.key === 'Escape') { event.preventDefault(); clear(); }
      };

      mapElement.addEventListener('pointerdown', pointerDown, true);
      mapElement.addEventListener('pointermove', pointerMove, true);
      mapElement.addEventListener('contextmenu', contextMenu, true);
      documentNode.addEventListener('keydown', keydown, true);
      api.map.on('zoomend', render);
      off.push(api.on?.('app:destroy', () => {
        mapElement.removeEventListener('pointerdown', pointerDown, true);
        mapElement.removeEventListener('pointermove', pointerMove, true);
        mapElement.removeEventListener('contextmenu', contextMenu, true);
        documentNode.removeEventListener('keydown', keydown, true);
        api.map.off('zoomend', render);
        rulerButton.remove(); tokenRulerButton.remove();
        routeLayer.clearLayers(); labelLayer.clearLayers();
        api.map.removeLayer?.(routeLayer); api.map.removeLayer?.(labelLayer);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.measurement = Object.freeze({
        tokenFirst: true,
        activate,
        toggle,
        clear,
        startFromToken,
        startFromPrimarySelection,
        isActive: () => enabled,
      });
    },
  });
}
