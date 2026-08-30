import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { formatFt } from '../elevation/model.js';
import { createTokenGhostDescriptor } from '../movement/ghost.js';
import { createTokenViewModel } from '../render/token-view-model.js';
import { combatTurnOriginMoved, normalizeCombatState } from './model.js';

const PANE = 'combatTurnOriginPane';
const STYLE_ID = 'rpgmap-combat-turn-origin-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function ensurePane(map) {
  let pane = map.getPane?.(PANE);
  if (!pane) pane = map.createPane(PANE);
  if (pane) {
    pane.style.zIndex = '505';
    pane.style.pointerEvents = 'none';
  }
}

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpgmap-combat-turn-origin { background:transparent !important; border:0 !important; pointer-events:none !important; overflow:visible !important; }
    .rpgmap-combat-turn-origin-core { position:relative; width:var(--token-size,42px); height:var(--token-size,42px); display:grid; place-items:center; border-radius:50%; opacity:.32; filter:grayscale(.45) saturate(.58) brightness(1.08); }
    .rpgmap-combat-turn-origin-core::before { content:''; position:absolute; inset:-5px; border-radius:50%; border:2px dotted rgba(77,111,120,.94); background:rgba(77,111,120,.06); box-shadow:0 0 0 2px rgba(255,255,255,.58); }
    .rpgmap-combat-turn-origin-face { position:relative; z-index:1; width:100%; height:100%; display:grid; place-items:center; overflow:hidden; border-radius:50%; border:2px solid rgba(255,255,255,.86); color:#fff; background:var(--token-color,#3d9b63); box-shadow:0 2px 7px rgba(0,0,0,.24); font-size:12px; font-weight:750; }
    .rpgmap-combat-turn-origin-face img { width:100%; height:100%; display:block; object-fit:cover; }
    .rpgmap-combat-turn-origin-badge { position:absolute; z-index:2; left:50%; top:-23px; transform:translateX(-50%); padding:2px 6px; border-radius:5px; white-space:nowrap; color:#eef7f8; background:rgba(48,70,76,.86); box-shadow:0 2px 7px rgba(0,0,0,.18); font:700 9px/1.35 "Microsoft YaHei","PingFang SC",system-ui,sans-serif; }
  `;
  documentNode.head.append(style);
}

function pixelsPerMeter(api) {
  const origin = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
  const unit = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
  const value = Math.hypot(unit.x - origin.x, unit.y - origin.y);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function originIcon(descriptor, elevationFt) {
  const portrait = descriptor.avatarDataUrl
    ? `<img src="${escapeHtml(descriptor.avatarDataUrl)}" alt="">`
    : `<span>${escapeHtml(descriptor.initial)}</span>`;
  const size = Number(descriptor.sizePixels) || 42;
  return L.divIcon({
    className: 'rpgmap-combat-turn-origin',
    html: `<div class="rpgmap-combat-turn-origin-core" style="--token-color:${descriptor.color};--token-size:${size}px"><span class="rpgmap-combat-turn-origin-badge">起点 · ${escapeHtml(formatFt(elevationFt))} ft</span><span class="rpgmap-combat-turn-origin-face">${portrait}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function createCombatTurnOriginRenderer() {
  return Object.freeze({
    register(api) {
      if (!api.tokens?.get || !api.tokens?.resolveActor) {
        throw new Error('Combat Turn Origin Renderer requires canonical Token Runtime');
      }
      const documentNode = api.map.getContainer().ownerDocument || document;
      installStyles(documentNode);
      ensurePane(api.map);
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
        const combatState = normalizeCombatState(api.getState?.()?.preferences?.combatSystem);
        const combat = combatState.combat;
        const origin = combat?.turnOrigin;
        if (!origin || combat?.state !== 'active') return hide();
        const token = api.tokens.get(origin.tokenId);
        if (!token || token.hidden === true || token.placement !== 'map' || !combatTurnOriginMoved(combat, token)) return hide();

        let actor = null;
        try { actor = api.tokens.resolveActor(token.id)?.actor || null; } catch {}
        const model = actor ? createTokenViewModel({ token, actor, selected: false, ruleset: api.ruleset }) : null;
        if (!model) return hide();
        const sizePixels = Math.max(18, Math.min(144, model.diameterMeters * pixelsPerMeter(api)));
        const descriptor = createTokenGhostDescriptor(model, origin, { sizePixels });
        if (!descriptor) return hide();
        const latLng = worldToLatLng(origin, api.mapPackage.height);
        const icon = originIcon(descriptor, origin.elevationFt);
        if (!marker) {
          marker = L.marker(latLng, {
            pane: PANE,
            icon,
            interactive: false,
            keyboard: false,
            bubblingMouseEvents: false,
            zIndexOffset: -50,
            title: `本回合起点：${model.name}`,
          }).addTo(layer);
        } else {
          marker.setLatLng(latLng);
          marker.setIcon(icon);
          marker.options.title = `本回合起点：${model.name}`;
        }
      }

      for (const eventName of [
        'token:move', 'token:delete', 'token:size-change', 'token:property-change',
        'token:visual-move-start', 'token:visual-move-end', 'state:import', 'state:commit',
      ]) off.push(api.on?.(eventName, render));
      api.map.on('zoomend', render);
      api.map.on('resize', render);
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        hide();
        api.map.off('zoomend', render);
        api.map.off('resize', render);
        layer.clearLayers();
        api.map.removeLayer?.(layer);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.combatTurnOriginRenderer = Object.freeze({ render, hide });
      render();
    },
  });
}
