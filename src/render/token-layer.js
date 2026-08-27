import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { formatFt } from '../elevation/model.js';
import { resolveStatusUiSnapshot, renderTokenStatusBadges } from '../status/ui.js';
import { createTokenViewModel } from './token-view-model.js';

const TOKEN_PANE = 'tokenV2Pane';
const STATUS_PANE = 'tokenStatusV2Pane';
const STYLE_ID = 'rpgmap-token-v2-renderer-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function ensurePane(map, name, zIndex, { pointerEvents = null } = {}) {
  let pane = map.getPane?.(name);
  if (!pane) pane = map.createPane(name);
  if (pane) {
    pane.style.zIndex = String(zIndex);
    if (pointerEvents) pane.style.pointerEvents = pointerEvents;
  }
  return pane;
}

function hideLegacyPane(map, name) {
  const pane = map.getPane?.(name);
  if (!pane) return;
  pane.style.visibility = 'hidden';
  pane.style.pointerEvents = 'none';
}

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Leaflet removes the trailing "Pane" from custom pane DOM class names. */
    .leaflet-character-pane { visibility:hidden !important; pointer-events:none !important; }
    .leaflet-tooltip.character-tooltip { display:none !important; }
    .leaflet-statusBadge-pane { visibility:hidden !important; pointer-events:none !important; }
    .rpg-token-v2 { background:transparent !important; border:0 !important; overflow:visible !important; }
    .rpg-token-v2 .rpg-character-core { border-radius:50%; overflow:hidden; }
    .rpg-token-v2 .rpg-token-v2-portrait { width:100%; height:100%; display:grid; place-items:center; border-radius:inherit; overflow:hidden; }
    .rpg-token-v2 .rpg-token-v2-portrait img { width:100%; height:100%; object-fit:cover; }
    .rpgmap-token-status-v2-marker { background:transparent !important; border:0 !important; pointer-events:none !important; overflow:visible !important; }
  `;
  documentNode.head.append(style);
}

function pixelsPerMeter(api) {
  const origin = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
  const unit = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
  const value = Math.hypot(unit.x - origin.x, unit.y - origin.y);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function renderSize(api, model) {
  const base = Math.max(18, Math.min(144, model.diameterMeters * pixelsPerMeter(api)));
  return base * (model.selected ? 1.16 : 1);
}

function tokenIcon(api, model) {
  const size = renderSize(api, model);
  const portrait = model.avatarDataUrl
    ? `<img src="${escapeHtml(model.avatarDataUrl)}" alt="">`
    : `<span>${escapeHtml((Array.from(model.name)[0] || '?').toUpperCase())}</span>`;
  const elevation = `<div class="token-elevation-label">${escapeHtml(formatFt(model.elevationFt))} ft</div>`;
  return L.divIcon({
    className: 'rpg-token-v2',
    html: `<div class="rpg-character-core rpg-token-v2-core${model.selected ? ' selected' : ''}" data-token-id="${escapeHtml(model.id)}" style="--character-color:${model.color};--token-size:${size}px"><div class="rpg-token-v2-portrait" style="transform:rotate(${model.rotation}deg)">${portrait}</div></div>${elevation}`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function setTooltip(documentNode, view, model) {
  if (!model.showName) {
    if (view.getTooltip?.()) view.unbindTooltip();
    return;
  }
  const node = documentNode.createElement('span');
  node.textContent = model.name;
  if (!view.getTooltip?.()) {
    view.bindTooltip(node, {
      permanent: true,
      direction: 'bottom',
      offset: [0, 12],
      className: 'marker-tooltip token-v2-tooltip',
    });
  } else {
    view.getTooltip().setContent(node);
  }
}

export function createTokenRendererSystem() {
  return Object.freeze({
    register(api) {
      if (!api.tokens?.list || !api.tokens?.resolveActor) {
        throw new Error('Token Renderer V2 requires canonical Token Runtime V2');
      }

      const documentNode = api.map.getContainer().ownerDocument || document;
      installStyles(documentNode);
      // The legacy Character layer remains in AppCore only for sidebar/editor
      // compatibility. It must never compete with the canonical visible layer.
      hideLegacyPane(api.map, 'characterPane');
      hideLegacyPane(api.map, 'statusBadgePane');
      ensurePane(api.map, TOKEN_PANE, 515);
      ensurePane(api.map, STATUS_PANE, 540, { pointerEvents: 'none' });

      const tokenLayer = L.layerGroup([], { pane: TOKEN_PANE }).addTo(api.map);
      const statusLayer = L.layerGroup([], { pane: STATUS_PANE }).addTo(api.map);
      const views = new Map();
      let selectedIds = new Set(api.selection?.getSelectedTokenIds?.() || []);
      let destroyed = false;
      const off = [];

      function resolveModel(token) {
        try {
          const resolved = api.tokens.resolveActor(token.id);
          return createTokenViewModel({
            token,
            actor: resolved.actor,
            selected: selectedIds.has(String(token.id)),
          });
        } catch (error) {
          console.warn('[RPGmap Token Renderer] cannot resolve Token Actor', token?.id, error);
          return null;
        }
      }

      function renderStatuses(models, tokensById) {
        statusLayer.clearLayers();
        for (const model of models) {
          const token = tokensById.get(model.id);
          if (!token) continue;
          const snapshot = resolveStatusUiSnapshot(api, {
            actorId: token.actorId,
            tokenId: token.id,
          });
          const html = renderTokenStatusBadges(snapshot.statuses, { limit: 4 });
          if (!html) continue;
          const tokenPixels = renderSize(api, { ...model, selected: false });
          L.marker(worldToLatLng({ x: model.x, y: model.y }, api.mapPackage.height), {
            pane: STATUS_PANE,
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'rpgmap-token-status-v2-marker',
              html,
              iconSize: [1, 1],
              iconAnchor: [-(tokenPixels / 2 + 3), tokenPixels / 2],
            }),
          }).addTo(statusLayer);
        }
      }

      function render() {
        if (destroyed) return;
        const tokens = api.tokens.list();
        const tokensById = new Map(tokens.map(token => [String(token.id), token]));
        const models = tokens.map(resolveModel).filter(Boolean);
        const visibleIds = new Set(models.map(model => model.id));

        for (const [id, view] of views) {
          if (visibleIds.has(id)) continue;
          tokenLayer.removeLayer(view);
          views.delete(id);
        }

        for (const model of models) {
          let view = views.get(model.id);
          if (!view) {
            view = L.marker(worldToLatLng({ x: model.x, y: model.y }, api.mapPackage.height), {
              icon: tokenIcon(api, model),
              keyboard: true,
              pane: TOKEN_PANE,
              title: model.showName ? model.name : 'Token',
              rpgTokenId: model.id,
            }).addTo(tokenLayer);
            view.on('click', event => {
              L.DomEvent.stopPropagation(event);
              const token = api.tokens.get(model.id);
              if (!token) return;
              // Token Selection is canonical. The Character call only keeps the
              // not-yet-migrated sidebar editor focused on the same Token id.
              api.selection?.replace?.([token.id], token.id);
              api.emit?.('token:select', { id: token.id, tokenId: token.id, actorId: token.actorId });
              api.selectCharacter?.(token.id);
            });
            views.set(model.id, view);
          }
          view.setLatLng(worldToLatLng({ x: model.x, y: model.y }, api.mapPackage.height));
          view.setIcon(tokenIcon(api, model));
          view.options.title = model.showName ? model.name : 'Token';
          setTooltip(documentNode, view, model);
        }
        renderStatuses(models, tokensById);
      }

      const selectionOff = api.selection?.subscribe?.(snapshot => {
        selectedIds = new Set((snapshot?.ids || []).map(String));
        render();
      });
      if (selectionOff) off.push(selectionOff);

      for (const eventName of [
        'token:create', 'token:delete', 'token:move', 'token:size-change',
        'token:property-change', 'status:change', 'state:import', 'state:saved',
      ]) off.push(api.on(eventName, render));
      off.push(api.on('state:commit', render));

      api.map.on('zoomend', render);
      api.map.on('resize', render);
      off.push(api.on('app:destroy', () => {
        destroyed = true;
        api.map.off('zoomend', render);
        api.map.off('resize', render);
        tokenLayer.clearLayers();
        statusLayer.clearLayers();
        api.map.removeLayer?.(tokenLayer);
        api.map.removeLayer?.(statusLayer);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.renderer = Object.freeze({
        canonicalSceneTokens: true,
        renderTokens: render,
        getVisibleTokenIds() { return [...views.keys()]; },
      });
      render();
      api.emit?.('renderer:ready', { canonicalSceneTokens: true, count: views.size });
    },
  });
}
