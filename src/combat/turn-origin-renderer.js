import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { createTokenGhostDescriptor } from '../movement/ghost.js';
import { createTokenViewModel } from '../render/token-view-model.js';
import { combatTurnOriginMoved } from './model.js';

const PANE = 'combatTurnOriginPane';
const STYLE_ID = 'rpgmap-combat-turn-origin-style';

function ensureVisuals(map, documentNode) {
  let pane = map.getPane?.(PANE);
  if (!pane) pane = map.createPane(PANE);
  pane.style.zIndex = '505';
  pane.style.pointerEvents = 'none';
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = '.rpgmap-combat-turn-origin .rpgmap-token-movement-ghost-v2-core{opacity:.32;filter:grayscale(.55) saturate(.55)}.rpgmap-combat-turn-origin .rpgmap-token-movement-ghost-v2-core::before{border-style:dotted;animation:none;background:transparent;box-shadow:none}';
  documentNode.head.append(style);
}

function pixelsPerMeter(api) {
  const a = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
  const b = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
  return Math.hypot(b.x - a.x, b.y - a.y) || 1;
}

function originIcon(descriptor, elevationFt) {
  const face = descriptor.avatarDataUrl ? `<img src="${descriptor.avatarDataUrl}" alt="">` : '?';
  const size = Number(descriptor.sizePixels) || 42;
  return L.divIcon({
    className: 'rpgmap-token-movement-ghost-v2 rpgmap-combat-turn-origin',
    html: `<div class="rpgmap-token-movement-ghost-v2-core" style="--token-color:${descriptor.color};--token-size:${size}px"><span class="rpgmap-token-movement-ghost-v2-badge">起点 · ${elevationFt} ft</span><span class="rpgmap-token-movement-ghost-v2-face">${face}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function createCombatTurnOriginRenderer() {
  return Object.freeze({
    register(api) {
      if (!api.tokens?.get || !api.tokens?.resolveActor) throw new Error('Combat Turn Origin Renderer requires canonical Token Runtime');
      const documentNode = api.map.getContainer().ownerDocument || document;
      ensureVisuals(api.map, documentNode);
      const layer = L.layerGroup().addTo(api.map);
      let marker = null;
      let destroyed = false;
      const off = [];

      function hide() {
        if (marker) layer.removeLayer(marker);
        marker = null;
      }

      function render() {
        if (destroyed) return;
        const combat = api.getState?.()?.preferences?.combatSystem?.combat;
        const origin = combat?.turnOrigin;
        const token = origin ? api.tokens.get(origin.tokenId) : null;
        if (!origin || combat?.state !== 'active' || !token || token.hidden === true || token.placement !== 'map' || !combatTurnOriginMoved(combat, token)) return hide();
        let actor = null;
        try { actor = api.tokens.resolveActor(token.id)?.actor || null; } catch {}
        const model = actor ? createTokenViewModel({ token, actor, ruleset: api.ruleset }) : null;
        if (!model) return hide();
        const descriptor = createTokenGhostDescriptor(model, origin, {
          sizePixels: Math.max(18, Math.min(144, model.diameterMeters * pixelsPerMeter(api))),
        });
        const latLng = worldToLatLng(origin, api.mapPackage.height);
        const icon = originIcon(descriptor, origin.elevationFt);
        if (!marker) marker = L.marker(latLng, {
          pane: PANE, icon, interactive: false, keyboard: false, bubblingMouseEvents: false, zIndexOffset: -50,
        }).addTo(layer);
        else {
          marker.setLatLng(latLng);
          marker.setIcon(icon);
        }
      }

      for (const eventName of ['token:visual-move-start', 'token:visual-move-end', 'state:import', 'state:commit']) off.push(api.on?.(eventName, render));
      api.map.on('zoomend', render);
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        hide();
        api.map.off('zoomend', render);
        layer.clearLayers();
        api.map.removeLayer?.(layer);
        off.splice(0).forEach(dispose => dispose?.());
      }));
      render();
    },
  });
}
