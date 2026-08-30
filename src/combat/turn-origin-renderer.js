import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { tokenIcon } from '../render/token-layer.js';
import { createTokenViewModel } from '../render/token-view-model.js';

const PANE = 'combatTurnOriginPane';

export function createCombatTurnOriginRenderer() {
  return Object.freeze({
    register(api) {
      const pane = api.map.getPane?.(PANE) || api.map.createPane(PANE);
      pane.style.zIndex = '505';
      pane.style.pointerEvents = 'none';
      const layer = L.layerGroup().addTo(api.map);

      function render() {
        layer.clearLayers();
        const combat = api.getState?.()?.preferences?.combatSystem?.combat;
        const origin = combat?.turnOrigin;
        const current = origin && combat?.state === 'active' ? combat.combatants?.[combat.turnIndex] : null;
        const token = current ? api.tokens.get(current.tokenId) : null;
        if (!token || token.hidden === true || token.placement !== 'map') return;
        let model = null;
        try {
          const actor = api.tokens.resolveActor(token.id)?.actor;
          if (actor) model = createTokenViewModel({ token, actor, ruleset: api.ruleset });
        } catch {}
        if (!model || (Math.abs(model.x - origin.x) <= 1e-6 && Math.abs(model.y - origin.y) <= 1e-6)) return;
        L.marker(worldToLatLng(origin, api.mapPackage.height), {
          pane: PANE, icon: tokenIcon(api, model), opacity: 0.32, interactive: false, keyboard: false,
        }).bindTooltip(`起点 · ${origin.elevationFt} ft`, {
          permanent: true, direction: 'top', className: 'marker-tooltip',
        }).addTo(layer);
      }

      const off = ['state:import', 'state:commit'].map(eventName => api.on?.(eventName, render));
      api.map.on('zoomend', render);
      api.on?.('app:destroy', () => {
        api.map.off('zoomend', render);
        api.map.removeLayer?.(layer);
        off.forEach(dispose => dispose?.());
      });
      render();
    },
  });
}
