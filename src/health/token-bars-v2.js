import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { tokenDiameterMeters } from '../elevation/model.js';
import { describeHealth } from './model.js';

const PANE = 'healthBarPane';
const STYLE_ID = 'rpgmap-token-healthbar-v2-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

function ensurePane(map) {
  let pane = map.getPane?.(PANE);
  if (!pane) pane = map.createPane(PANE);
  if (pane) {
    pane.style.zIndex = '525';
    pane.style.pointerEvents = 'none';
  }
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpgmap-healthbar-marker { background:transparent !important; border:0 !important; pointer-events:none !important; }
    .rpgmap-token-healthbar { width:46px; height:7px; display:flex; overflow:hidden; border:1px solid rgba(20,28,28,.72); border-radius:4px; background:rgba(25,30,30,.5); box-shadow:0 1px 3px rgba(0,0,0,.45); }
    .rpgmap-token-healthbar > span { height:100%; min-width:0; }
  `;
  documentNode.head.append(style);
}

function segment(width, color, label) {
  return width > 0
    ? `<span style="width:${Math.max(0, width)}%;background:${escapeHtml(color || '#4b9f69')}" title="${escapeHtml(label || '')}"></span>`
    : '';
}

function barHtml(health, ruleset) {
  const max = Math.max(0, Number(health?.max) || 0);
  if (!max) return '';
  const view = describeHealth(health, { ruleset });
  const pct = value => Math.max(0, Math.min(100, (Number(value) || 0) / max * 100));
  const segments = (view.segments || []).map(item => segment(pct(item.value), item.color, item.label)).join('');
  return segments ? `<div class="rpgmap-token-healthbar" title="${escapeHtml(view.summary)}">${segments}</div>` : '';
}

export function createHealthTokenBarsV2() {
  return {
    register(api) {
      if (!api.tokens?.list) throw new Error('Token health bars require canonical Token Runtime V2');
      const documentNode = api.map.getContainer().ownerDocument || document;
      const windowNode = documentNode.defaultView || globalThis;
      const requestFrame = callback => windowNode.requestAnimationFrame
        ? windowNode.requestAnimationFrame(callback)
        : windowNode.setTimeout(callback, 16);
      const cancelFrame = id => windowNode.cancelAnimationFrame
        ? windowNode.cancelAnimationFrame(id)
        : windowNode.clearTimeout(id);
      ensurePane(api.map);
      installStyles(documentNode);
      const layer = L.layerGroup([], { pane: PANE }).addTo(api.map);
      const markers = new Map();
      const movingTokenIds = new Set();
      let fullRenderFrame = null;
      let destroyed = false;
      const off = [];

      function pixelsPerMeter() {
        const origin = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
        const unit = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
        return Math.hypot(unit.x - origin.x, unit.y - origin.y) || 1;
      }

      function removeToken(tokenId) {
        const id = String(tokenId || '');
        const marker = markers.get(id);
        if (marker) layer.removeLayer(marker);
        markers.delete(id);
      }

      function upsertToken(tokenId) {
        if (destroyed) return;
        const id = String(tokenId || '');
        if (!id) return;
        removeToken(id);
        const token = api.tokens.get?.(id);
        if (!token || token.hidden === true || token.placement !== 'map') return;
        if (movingTokenIds.has(id) || api.renderer?.isTokenMoving?.(id)) return;
        const x = Number(token.x);
        const y = Number(token.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const health = api.health?.resolveToken?.(id);
        const html = barHtml(health, api.ruleset);
        if (!html) return;
        const tokenPixels = Math.max(18, Math.min(144, tokenDiameterMeters(token) * pixelsPerMeter()));
        const barWidth = Math.max(28, Math.min(160, tokenPixels * 1.1));
        const marker = L.marker(worldToLatLng({ x, y }, api.mapPackage.height), {
          pane: PANE,
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'rpgmap-healthbar-marker',
            html: html.replace('class="rpgmap-token-healthbar"', `class="rpgmap-token-healthbar" style="width:${barWidth}px"`),
            iconSize: [barWidth, 7],
            iconAnchor: [barWidth / 2, -(tokenPixels / 2 + 6)],
          }),
        }).addTo(layer);
        markers.set(id, marker);
      }

      function renderAll() {
        fullRenderFrame = null;
        if (destroyed) return;
        const live = new Set();
        for (const token of api.tokens.list()) {
          const id = String(token?.id || '');
          if (!id) continue;
          live.add(id);
          upsertToken(id);
        }
        for (const id of [...markers.keys()]) if (!live.has(id)) removeToken(id);
      }

      function scheduleFullRender() {
        if (destroyed || fullRenderFrame !== null) return;
        fullRenderFrame = requestFrame(renderAll);
      }

      function tokenIdFromEvent(event) {
        return String(event?.detail?.tokenId || event?.detail?.id || '');
      }

      off.push(api.on('token:create', event => upsertToken(tokenIdFromEvent(event))));
      off.push(api.on('token:move', event => upsertToken(tokenIdFromEvent(event))));
      off.push(api.on('token:delete', event => removeToken(tokenIdFromEvent(event))));
      off.push(api.on('token:size-change', event => upsertToken(tokenIdFromEvent(event))));
      off.push(api.on('health:change', event => {
        const ids = event?.detail?.tokenIds || [];
        if (ids.length) ids.forEach(upsertToken);
        else scheduleFullRender();
      }));
      off.push(api.on('state:import', scheduleFullRender));
      off.push(api.on('state:commit', event => {
        const source = String(event?.detail?.source || '');
        if (source.startsWith('movement:')) return;
        scheduleFullRender();
      }));
      off.push(api.on('token:visual-move-start', event => {
        const id = tokenIdFromEvent(event);
        if (!id) return;
        movingTokenIds.add(id);
        removeToken(id);
      }));
      off.push(api.on('token:visual-move-end', event => {
        const id = tokenIdFromEvent(event);
        if (!id) return;
        movingTokenIds.delete(id);
        upsertToken(id);
      }));
      api.map.on('zoomend', scheduleFullRender);
      api.map.on('resize', scheduleFullRender);
      off.push(api.on('app:destroy', () => {
        destroyed = true;
        if (fullRenderFrame !== null) cancelFrame(fullRenderFrame);
        fullRenderFrame = null;
        movingTokenIds.clear();
        markers.clear();
        api.map.off('zoomend', scheduleFullRender);
        api.map.off('resize', scheduleFullRender);
        layer.clearLayers();
        api.map.removeLayer?.(layer);
        off.splice(0).forEach(dispose => dispose?.());
      }));
      renderAll();
    },
  };
}
