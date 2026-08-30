import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { createTokenViewModel } from '../render/token-view-model.js';
import { combatTurnOriginMoved, currentCombatant } from './model.js';

const PANE = 'combatTurnOriginPane';

function pixelsPerMeter(api) {
  const a = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
  const b = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
  return Math.hypot(b.x - a.x, b.y - a.y) || 1;
}

function originIcon(api, model) {
  const size = Math.max(18, Math.min(144, model.diameterMeters * pixelsPerMeter(api)));
  const face = model.avatarDataUrl ? `<img src="${model.avatarDataUrl}" alt="">` : '?';
  return L.divIcon({
    className: 'rpg-token-v2',
    html: `<div class="rpg-token-v2-core" style="--token-color:${model.color};--token-size:${size}px"><div class="rpg-token-v2-portrait" style="transform:rotate(${model.rotation}deg)">${face}</div></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
}

export function createCombatTurnOriginRenderer() {
  return Object.freeze({
    register(api) {
      if (!api.tokens?.get || !api.tokens?.resolveActor) throw new Error('Combat Turn Origin Renderer requires canonical Token Runtime');
      let pane = api.map.getPane?.(PANE);
      if (!pane) pane = api.map.createPane(PANE);
      pane.style.zIndex = '505';
      pane.style.pointerEvents = 'none';
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
        hide();
        const combat = api.getState?.()?.preferences?.combatSystem?.combat;
        const origin = combat?.turnOrigin;
        const current = origin ? currentCombatant(combat) : null;
        const token = current ? api.tokens.get(current.tokenId) : null;
        if (!origin || combat?.state !== 'active' || !token || token.hidden === true || token.placement !== 'map' || !combatTurnOriginMoved(combat, token)) return;
        let actor = null;
        try { actor = api.tokens.resolveActor(token.id)?.actor || null; } catch {}
        const model = actor ? createTokenViewModel({ token, actor, ruleset: api.ruleset }) : null;
        if (!model) return;
        marker = L.marker(worldToLatLng(origin, api.mapPackage.height), {
          pane: PANE,
          icon: originIcon(api, model),
          opacity: 0.32,
          interactive: false,
          keyboard: false,
          bubblingMouseEvents: false,
          zIndexOffset: -50,
        }).bindTooltip(`起点 · ${origin.elevationFt} ft`, {
          permanent: true, direction: 'top', className: 'marker-tooltip',
        }).addTo(layer);
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
