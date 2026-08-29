import L from 'leaflet';
import { latLngToWorld, worldToLatLng } from '../engine/geometry.js';
import { createTokenViewModel } from '../render/token-view-model.js';
import { createTokenGhostDescriptor, isMovementEndpointLayer } from './ghost.js';

const PANE = 'movementGhostV2Pane';
const STYLE_ID = 'rpgmap-token-movement-ghost-v2-style';
const BLOCKED_ROUTE_COLOR = '#b52f2a';
const HIDE_DELAY_MS = 90;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function ensurePane(map) {
  let pane = map.getPane?.(PANE);
  if (!pane) pane = map.createPane(PANE);
  if (pane) {
    pane.style.zIndex = '535';
    pane.style.pointerEvents = 'none';
  }
}

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpgmap-token-movement-ghost-v2 { background:transparent !important; border:0 !important; pointer-events:none !important; overflow:visible !important; }
    .rpgmap-token-movement-ghost-v2-core { position:relative; width:var(--token-size,42px); height:var(--token-size,42px); display:grid; place-items:center; border-radius:50%; opacity:.62; transform:scale(1.04); filter:saturate(.82) brightness(1.08); }
    .rpgmap-token-movement-ghost-v2-core::before { content:''; position:absolute; inset:-6px; border-radius:50%; border:2px dashed rgba(23,109,118,.92); background:rgba(23,109,118,.08); box-shadow:0 0 0 2px rgba(255,255,255,.72),0 0 18px 6px rgba(23,109,118,.34); animation:rpgmap-token-ghost-pulse 1.15s ease-in-out infinite alternate; }
    .rpgmap-token-movement-ghost-v2-core.blocked { opacity:.5; filter:grayscale(.28) saturate(.72); }
    .rpgmap-token-movement-ghost-v2-core.blocked::before { border-color:rgba(181,47,42,.96); background:rgba(181,47,42,.1); box-shadow:0 0 0 2px rgba(255,255,255,.72),0 0 18px 6px rgba(181,47,42,.38); }
    .rpgmap-token-movement-ghost-v2-face { position:relative; z-index:1; width:100%; height:100%; display:grid; place-items:center; overflow:hidden; border-radius:50%; border:3px solid rgba(255,255,255,.9); color:#fff; background:var(--token-color,#3d9b63); box-shadow:0 2px 8px rgba(0,0,0,.34),0 0 0 2px var(--token-color,#3d9b63); font-size:12px; font-weight:750; }
    .rpgmap-token-movement-ghost-v2-face img { width:100%; height:100%; display:block; object-fit:cover; }
    .rpgmap-token-movement-ghost-v2-badge { position:absolute; z-index:2; left:50%; top:-22px; transform:translateX(-50%); padding:2px 6px; border-radius:5px; white-space:nowrap; color:#fff; background:rgba(27,38,41,.84); box-shadow:0 2px 7px rgba(0,0,0,.2); font:700 10px/1.35 "Microsoft YaHei","PingFang SC",system-ui,sans-serif; }
    .rpgmap-token-movement-ghost-v2-core.blocked .rpgmap-token-movement-ghost-v2-badge { background:rgba(130,35,31,.9); }
    @keyframes rpgmap-token-ghost-pulse { from { transform:scale(.96); opacity:.78; } to { transform:scale(1.06); opacity:1; } }
    @media (prefers-reduced-motion:reduce) { .rpgmap-token-movement-ghost-v2-core::before { animation:none; } }
  `;
  documentNode.head.append(style);
}

function sameColor(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function ghostIcon(descriptor) {
  const portrait = descriptor.avatarDataUrl
    ? `<img src="${escapeHtml(descriptor.avatarDataUrl)}" alt="">`
    : `<span>${escapeHtml(descriptor.initial)}</span>`;
  const size = Number(descriptor.sizePixels) || 42;
  const blocked = descriptor.blocked ? ' blocked' : '';
  return L.divIcon({
    className: 'rpgmap-token-movement-ghost-v2',
    html: `<div class="rpgmap-token-movement-ghost-v2-core${blocked}" style="--token-color:${descriptor.color};--token-size:${size}px"><span class="rpgmap-token-movement-ghost-v2-badge">${descriptor.blocked ? '受阻' : '预览'}</span><span class="rpgmap-token-movement-ghost-v2-face">${portrait}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function createMovementGhostRendererV2() {
  return Object.freeze({
    register(api) {
      if (!api.tokens?.get || !api.tokens?.resolveActor || !api.selection) {
        throw new Error('Movement Ghost V2 requires canonical Token Runtime and Selection');
      }
      const documentNode = api.map.getContainer().ownerDocument || document;
      installStyles(documentNode);
      ensurePane(api.map);
      const layer = L.layerGroup().addTo(api.map);
      let selectedTokenId = api.selection.getPrimaryTokenId?.() || null;
      let ghostMarker = null;
      let endpointLayer = null;
      let hideTimer = null;
      let destroyed = false;
      const off = [];

      const cancelHide = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = null;
      };
      const hide = () => {
        cancelHide();
        endpointLayer = null;
        if (ghostMarker) layer.removeLayer(ghostMarker);
        ghostMarker = null;
      };
      const scheduleHide = () => {
        cancelHide();
        hideTimer = setTimeout(hide, HIDE_DELAY_MS);
      };

      function selectedModel() {
        const token = selectedTokenId ? api.tokens.get(selectedTokenId) : null;
        if (!token || token.placement !== 'map') return null;
        try {
          const resolved = api.tokens.resolveActor(token.id);
          return createTokenViewModel({ token, actor: resolved.actor, selected: false, ruleset: api.ruleset });
        } catch {
          return null;
        }
      }

      function pixelsPerMeter() {
        const origin = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
        const unit = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
        return Math.hypot(unit.x - origin.x, unit.y - origin.y) || 1;
      }

      function show(endpoint) {
        const model = selectedModel();
        if (!model || typeof endpoint?.getLatLng !== 'function') return;
        cancelHide();
        endpointLayer = endpoint;
        const sizePixels = Math.max(18, Math.min(144, model.diameterMeters * pixelsPerMeter()));
        const descriptor = createTokenGhostDescriptor(
          model,
          latLngToWorld(endpoint.getLatLng(), api.mapPackage.height),
          { blocked: sameColor(endpoint.options?.color, BLOCKED_ROUTE_COLOR), sizePixels },
        );
        if (!descriptor) return;
        if (!ghostMarker) {
          ghostMarker = L.marker(endpoint.getLatLng(), {
            pane: PANE,
            icon: ghostIcon(descriptor),
            interactive: false,
            keyboard: false,
            bubblingMouseEvents: false,
            zIndexOffset: 900,
          }).addTo(layer);
        } else {
          ghostMarker.setLatLng(endpoint.getLatLng());
          ghostMarker.setIcon(ghostIcon(descriptor));
        }
      }

      const selectionOff = api.selection.subscribe?.(snapshot => {
        selectedTokenId = snapshot?.primaryId || api.selection.getPrimaryTokenId?.() || null;
        if (!selectedTokenId) hide();
        else if (endpointLayer) show(endpointLayer);
      });
      if (selectionOff) off.push(selectionOff);

      api.map.on('layeradd', event => {
        if (destroyed || !isMovementEndpointLayer(event.layer?.options)) return;
        show(event.layer);
      });
      api.map.on('layerremove', event => {
        if (event.layer === endpointLayer) scheduleHide();
      });
      for (const eventName of ['token:delete', 'state:import', 'scene:activate']) {
        off.push(api.on?.(eventName, hide));
      }
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        hide();
        api.map.off('layeradd');
        api.map.off('layerremove');
        layer.clearLayers();
        api.map.removeLayer?.(layer);
        off.splice(0).forEach(dispose => dispose?.());
      }));
    },
  });
}
