import L from 'leaflet';
import { attackAreaToPolygon, latLngToWorld, worldToLatLng } from '../engine/geometry.js';
import { applyAreaHandleDrag, areaHandlePoints } from './area-handle-geometry.js';

const STYLE_ID = 'rpgmap-scene-area-handle-style';
const MAX_AREA_SCALE = 4;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpgmap-area-handle-marker { background:transparent !important; border:0 !important; }
    .rpgmap-area-handle {
      min-width:30px; height:22px; padding:0 6px; box-sizing:border-box;
      display:grid; place-items:center; border:2px solid rgba(255,255,255,.96);
      border-radius:11px; background:rgba(32,43,47,.92); color:#fff;
      font:600 11px/1 sans-serif; white-space:nowrap; cursor:grab;
      box-shadow:0 2px 7px rgba(0,0,0,.36); transform:translate(-50%,-50%);
      user-select:none;
    }
    .rpgmap-area-handle.secondary { background:rgba(23,109,118,.94); }
    .rpgmap-area-handle-marker.leaflet-drag-target .rpgmap-area-handle { cursor:grabbing; }
  `;
  documentNode.head.append(style);
}

function handleIcon(label, secondary = false) {
  const text = String(label || '●').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  return L.divIcon({
    className: 'rpgmap-area-handle-marker',
    html: `<span class="rpgmap-area-handle${secondary ? ' secondary' : ''}">${text}</span>`,
    iconSize: [1, 1],
    iconAnchor: [0, 0],
  });
}

function resolvedOrigin(api, area) {
  if (area?.anchor?.type === 'marker') {
    const marker = (api.getState?.()?.markers || []).find(item => String(item.id) === String(area.anchor.markerId));
    if (marker) return { x: Number(marker.x), y: Number(marker.y) };
  }
  if (area?.anchor?.type === 'token') {
    const token = api.tokens?.get?.(area.anchor.tokenId);
    if (token?.placement === 'map') return { x: Number(token.x), y: Number(token.y) };
    if (token?.placement === 'feature' && token.featureId) {
      const feature = (api.mapPackage?.features || []).find(item => String(item.id) === String(token.featureId));
      const anchor = feature?.center || feature?.entrance;
      if (Array.isArray(anchor)) return { x: Number(anchor[0]), y: Number(anchor[1]) };
    }
  }
  return { x: Number(area?.origin?.x) || 0, y: Number(area?.origin?.y) || 0 };
}

function resolvedArea(api, area) {
  return { ...clone(area), origin: resolvedOrigin(api, area) };
}

export function createSceneAreaHandleSystem() {
  return Object.freeze({
    register(api) {
      if (!api.sceneAreas?.getSelected || !api.commitState) {
        throw new Error('Scene area handles require SceneAreaSystem');
      }
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      installStyles(documentNode);
      const handleLayer = L.layerGroup([], { pane: 'handlePane' }).addTo(api.map);
      let aoePane = api.map.getPane?.('aoePane');
      if (!aoePane) aoePane = api.map.createPane('aoePane');
      aoePane.style.zIndex = '390';
      const previewLayer = L.layerGroup([], { pane: 'aoePane' }).addTo(api.map);
      const handles = new Map();
      const off = [];
      let draft = null;
      let selectedAreaId = null;
      let dragging = false;
      let destroyed = false;
      let renderTimer = null;

      const maxSize = Math.max(Number(api.mapPackage.width) || 1, Number(api.mapPackage.height) || 1) * MAX_AREA_SCALE;

      function clearRenderTimer() {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = null;
      }

      function drawPreview(area) {
        previewLayer.clearLayers();
        if (!area) return;
        let points;
        try { points = attackAreaToPolygon(area); }
        catch { return; }
        L.polygon(points.map(([x, y]) => worldToLatLng({ x, y }, api.mapPackage.height)), {
          pane: 'aoePane',
          color: '#176d76',
          weight: 3,
          opacity: .98,
          fillColor: '#176d76',
          fillOpacity: .14,
          dashArray: '7 5',
          interactive: false,
          className: 'scene-area-drag-preview',
        }).addTo(previewLayer);
      }

      function setHandlePositions(area) {
        const descriptors = new Map(areaHandlePoints(area).map(item => [item.kind, item]));
        for (const [kind, marker] of handles) {
          const descriptor = descriptors.get(kind);
          if (!descriptor) continue;
          marker.setLatLng(worldToLatLng(descriptor.point, api.mapPackage.height));
        }
      }

      async function commitDraft() {
        if (!draft || !selectedAreaId) return false;
        const current = api.getState();
        const index = (current.attackAreas || []).findIndex(area => String(area.id) === String(selectedAreaId));
        if (index < 0) return false;
        current.attackAreas[index] = clone(draft);
        await Promise.resolve(api.commitState(current, { source: 'scene-area:drag', render: true }));
        api.sceneAreas.select?.(selectedAreaId);
        return true;
      }

      function beginDrag(kind) {
        const selected = api.sceneAreas.getSelected();
        if (!selected) return false;
        selectedAreaId = String(selected.id);
        draft = resolvedArea(api, selected);
        if (kind === 'origin') draft.anchor = clone(selected.anchor || { type: 'free', markerId: null });
        dragging = true;
        drawPreview(draft);
        api.setStatus?.('拖动范围控制点 · 松开后保存');
        return true;
      }

      function dragHandle(kind, marker) {
        if (!dragging || !draft) return;
        const point = latLngToWorld(marker.getLatLng(), api.mapPackage.height);
        draft = applyAreaHandleDrag(draft, kind, point, { maxSize });
        setHandlePositions(draft);
        drawPreview(draft);
      }

      async function endDrag(kind, marker) {
        if (!dragging || !draft) return;
        dragHandle(kind, marker);
        dragging = false;
        try {
          await commitDraft();
          api.setStatus?.('范围已更新');
        } catch (error) {
          api.showToast?.(`范围保存失败：${error.message || error}`, 'error');
        } finally {
          previewLayer.clearLayers();
          draft = null;
          render();
        }
      }

      function addHandle(descriptor) {
        const marker = L.marker(worldToLatLng(descriptor.point, api.mapPackage.height), {
          pane: 'handlePane',
          draggable: true,
          keyboard: true,
          icon: handleIcon(descriptor.label, descriptor.secondary),
          title: descriptor.title,
          riseOnHover: true,
        }).addTo(handleLayer);
        marker.on('dragstart', () => beginDrag(descriptor.kind));
        marker.on('drag', () => dragHandle(descriptor.kind, marker));
        marker.on('dragend', () => { void endDrag(descriptor.kind, marker); });
        handles.set(descriptor.kind, marker);
      }

      function render() {
        if (destroyed || dragging) return;
        handleLayer.clearLayers();
        handles.clear();
        previewLayer.clearLayers();
        const selected = api.sceneAreas.getSelected();
        if (!selected || selected.visible === false) {
          selectedAreaId = null;
          return;
        }
        selectedAreaId = String(selected.id);
        const area = resolvedArea(api, selected);
        for (const descriptor of areaHandlePoints(area)) addHandle(descriptor);
      }

      function renderSoon() {
        clearRenderTimer();
        renderTimer = setTimeout(() => {
          renderTimer = null;
          render();
        }, 0);
      }

      mapElement.addEventListener('click', renderSoon, true);
      const panel = api.uiPanels?.get?.('areas');
      panel?.addEventListener('click', renderSoon, true);
      for (const name of ['state:commit', 'state:import', 'area:create', 'token:move', 'token:delete', 'marker:move', 'marker:delete']) {
        off.push(api.on?.(name, renderSoon));
      }
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        clearRenderTimer();
        mapElement.removeEventListener('click', renderSoon, true);
        panel?.removeEventListener('click', renderSoon, true);
        handleLayer.clearLayers();
        previewLayer.clearLayers();
        api.map.removeLayer?.(handleLayer);
        api.map.removeLayer?.(previewLayer);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.sceneAreaHandles = Object.freeze({
        draggable: true,
        render,
        get selectedAreaId() { return selectedAreaId; },
      });
      render();
    },
  });
}
