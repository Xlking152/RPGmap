import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { createTokenViewModel } from '../render/token-view-model.js';
import { currentCombatant } from './model.js';

const PANE = 'combatTurnOriginPane';

function originIcon(api, model) {
  const a = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
  const b = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
  const size = Math.max(18, Math.min(144, model.diameterMeters * (Math.hypot(b.x - a.x, b.y - a.y) || 1)));
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
      let pane = api.map.getPane?.(PANE);
      if (!pane) pane = api.map.createPane(PANE);
      pane.style.zIndex = '505';
      pane.style.pointerEvents = 'none';
      const layer = L.layerGroup().addTo(api.map);

      function render() {
        layer.clearLayers();
        const combat = api.getState?.()?.preferences?.combatSystem?.combat;
        const origin = combat?.turnOrigin;
        const current = origin ? currentCombatant(combat) : null;
        const token = current ? api.tokens.get(current.tokenId) : null;
        const x = Number(token?.x);
        const y = Number(token?.y);
        if (!origin || combat?.state !== 'active' || !token || token.hidden === true || token.placement !== 'map'
          || !Number.isFinite(x) || !Number.isFinite(y)
          || (Math.abs(x - origin.x) <= 1e-6 && Math.abs(y - origin.y) <= 1e-6)) return;
        let actor = null;
        try { actor = api.tokens.resolveActor(token.id)?.actor || null; } catch {}
        const model = actor ? createTokenViewModel({ token, actor, ruleset: api.ruleset }) : null;
        if (!model) return;
        L.marker(worldToLatLng(origin, api.mapPackage.height), {
          pane: PANE, icon: originIcon(api, model), opacity: 0.32, interactive: false, keyboard: false,
        }).bindTooltip(`起点 · ${origin.elevationFt} ft`, {
          permanent: true, direction: 'top', className: 'marker-tooltip',
        }).addTo(layer);
      }

      const off = ['state:import', 'state:commit'].map(eventName => api.on?.(eventName, render));
      api.map.on('zoomend', render);
      api.on?.('app:destroy', () => {
        api.map.off('zoomend', render);
        layer.clearLayers();
        api.map.removeLayer?.(layer);
        off.forEach(dispose => dispose?.());
      });
      render();
    },
  });
}
