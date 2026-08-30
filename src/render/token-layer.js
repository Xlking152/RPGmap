import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { formatFt } from '../elevation/model.js';
import { resolveStatusUiSnapshot, renderTokenStatusBadges } from '../status/ui.js';
import { interpolateTokenPoint, normalizeTokenPoint, sameTokenPoint, tokenMoveDuration } from './token-motion.js';
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

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpg-token-v2 { background:transparent !important; border:0 !important; overflow:visible !important; }
    .rpg-token-v2 .rpg-token-v2-core { border-radius:50%; overflow:hidden; }
    .rpg-token-v2 .rpg-token-v2-portrait { width:100%; height:100%; display:grid; place-items:center; border-radius:inherit; overflow:hidden; }
    .rpg-token-v2 .rpg-token-v2-portrait img { width:100%; height:100%; object-fit:cover; }
    .token-v2-label-row { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
    .token-v2-elevation-label { display:inline-flex; align-items:center; min-height:17px; padding:1px 4px; border-radius:4px; color:#eaf6f7; background:rgba(42,67,72,.92); font-size:9px; font-weight:800; line-height:1.2; }
    .token-v2-name-label { font-weight:750; }
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

export function tokenIcon(api, model) {
  const size = renderSize(api, model);
  const portrait = model.avatarDataUrl
    ? `<img src="${escapeHtml(model.avatarDataUrl)}" alt="">`
    : `<span>${escapeHtml((Array.from(model.name)[0] || '?').toUpperCase())}</span>`;
  return L.divIcon({
    className: 'rpg-token-v2',
    html: `<div class="rpg-token-v2-core${model.selected ? ' selected' : ''}" data-token-id="${escapeHtml(model.id)}" style="--token-color:${model.color};--token-size:${size}px"><div class="rpg-token-v2-portrait" style="transform:rotate(${model.rotation}deg)">${portrait}</div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function setTooltip(api, documentNode, view, model) {
  if (!model.showName) {
    if (view.getTooltip?.()) view.unbindTooltip();
    return;
  }
  const row = documentNode.createElement('span');
  row.className = 'token-v2-label-row';
  const elevation = documentNode.createElement('span');
  elevation.className = 'token-v2-elevation-label';
  elevation.textContent = `${formatFt(model.elevationFt)} ft`;
  const name = documentNode.createElement('span');
  name.className = 'token-v2-name-label';
  name.textContent = model.name;
  row.append(elevation, name);
  const options = {
    permanent: true,
    direction: 'top',
    offset: [0, -(renderSize(api, model) / 2 + 8)],
    className: 'marker-tooltip token-v2-tooltip',
  };
  if (view.getTooltip?.()) view.unbindTooltip();
  view.bindTooltip(row, options);
}

export function createTokenRendererSystem() {
  return Object.freeze({
    register(api) {
      if (!api.tokens?.list || !api.tokens?.resolveActor) {
        throw new Error('Token Renderer V2 requires canonical Token Runtime V2');
      }

      const documentNode = api.map.getContainer().ownerDocument || document;
      const windowNode = documentNode.defaultView || globalThis;
      const reducedMotion = windowNode.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      const requestFrame = callback => windowNode.requestAnimationFrame
        ? windowNode.requestAnimationFrame(callback)
        : windowNode.setTimeout(() => callback(windowNode.performance?.now?.() || Date.now()), 16);
      const cancelFrame = id => windowNode.cancelAnimationFrame
        ? windowNode.cancelAnimationFrame(id)
        : windowNode.clearTimeout(id);
      installStyles(documentNode);
      ensurePane(api.map, TOKEN_PANE, 515);
      ensurePane(api.map, STATUS_PANE, 540, { pointerEvents: 'none' });

      const tokenLayer = L.layerGroup([], { pane: TOKEN_PANE }).addTo(api.map);
      const statusLayer = L.layerGroup([], { pane: STATUS_PANE }).addTo(api.map);
      const views = new Map();
      const visualPoints = new Map();
      const animations = new Map();
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
            ruleset: api.ruleset,
          });
        } catch (error) {
          console.warn('[RPGmap Token Renderer] cannot resolve Token Actor', token?.id, error);
          return null;
        }
      }

      function cancelMotion(id, { emitEnd = false } = {}) {
        const motion = animations.get(id);
        if (!motion) return;
        if (motion.frame !== null) cancelFrame(motion.frame);
        animations.delete(id);
        if (emitEnd) api.emit?.('token:visual-move-end', { id, tokenId: id, point: visualPoints.get(id) || null });
      }

      function renderStatuses(models, tokensById) {
        statusLayer.clearLayers();
        for (const model of models) {
          if (animations.has(model.id)) continue;
          const token = tokensById.get(model.id);
          if (!token) continue;
          const snapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
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

      function beginSegment(motion, target) {
        motion.from = normalizeTokenPoint(visualPoints.get(motion.id) || motion.from || target);
        motion.target = normalizeTokenPoint(target);
        motion.startedAt = null;
        motion.duration = tokenMoveDuration(motion.from, motion.target);
        const step = timestamp => {
          if (destroyed || animations.get(motion.id) !== motion) return;
          if (motion.startedAt === null) motion.startedAt = Number(timestamp) || 0;
          const elapsed = Math.max(0, (Number(timestamp) || 0) - motion.startedAt);
          const progress = motion.duration > 0 ? Math.min(1, elapsed / motion.duration) : 1;
          const point = interpolateTokenPoint(motion.from, motion.target, progress) || motion.target;
          visualPoints.set(motion.id, point);
          motion.view.setLatLng(worldToLatLng(point, api.mapPackage.height));
          if (progress < 1) {
            motion.frame = requestFrame(step);
            return;
          }
          visualPoints.set(motion.id, motion.target);
          motion.view.setLatLng(worldToLatLng(motion.target, api.mapPackage.height));
          if (motion.queue.length) {
            const next = motion.queue.shift();
            beginSegment(motion, next);
            return;
          }
          animations.delete(motion.id);
          motion.frame = null;
          api.emit?.('token:visual-move-end', { id: motion.id, tokenId: motion.id, point: motion.target });
          render();
        };
        motion.frame = requestFrame(step);
      }

      function moveView(model, view) {
        const id = model.id;
        const target = normalizeTokenPoint(model);
        if (!target) return;
        const current = visualPoints.get(id);
        if (!current) {
          visualPoints.set(id, target);
          view.setLatLng(worldToLatLng(target, api.mapPackage.height));
          return;
        }
        const active = animations.get(id);
        if (active) {
          active.view = view;
          if (sameTokenPoint(active.target, target) || active.queue.some(point => sameTokenPoint(point, target))) return;
          active.queue.push(target);
          return;
        }
        if (sameTokenPoint(current, target) || reducedMotion) {
          visualPoints.set(id, target);
          view.setLatLng(worldToLatLng(target, api.mapPackage.height));
          return;
        }
        const motion = { id, view, from: current, target, queue: [], frame: null, startedAt: null, duration: 0 };
        animations.set(id, motion);
        api.emit?.('token:visual-move-start', { id, tokenId: id, from: current, to: target });
        beginSegment(motion, target);
      }

      function render() {
        if (destroyed) return;
        const tokens = api.tokens.list();
        const tokensById = new Map(tokens.map(token => [String(token.id), token]));
        const models = tokens.map(resolveModel).filter(Boolean);
        const visibleIds = new Set(models.map(model => model.id));

        for (const [id, view] of views) {
          if (visibleIds.has(id)) continue;
          cancelMotion(id, { emitEnd: true });
          tokenLayer.removeLayer(view);
          views.delete(id);
          visualPoints.delete(id);
        }

        for (const model of models) {
          let view = views.get(model.id);
          if (!view) {
            const point = normalizeTokenPoint(model);
            view = L.marker(worldToLatLng(point, api.mapPackage.height), {
              icon: tokenIcon(api, model),
              keyboard: true,
              pane: TOKEN_PANE,
              title: model.showName ? model.name : 'Token',
              rpgTokenId: model.id,
            }).addTo(tokenLayer);
            visualPoints.set(model.id, point);
            view.on('click', event => {
              L.DomEvent.stopPropagation(event);
              const token = api.tokens.get(model.id);
              if (!token) return;
              api.selection?.replace?.([token.id], token.id);
              api.emit?.('token:select', { id: token.id, tokenId: token.id, actorId: token.actorId });
            });
            views.set(model.id, view);
          }
          moveView(model, view);
          view.setIcon(tokenIcon(api, model));
          view.options.title = model.showName ? model.name : 'Token';
          setTooltip(api, documentNode, view, model);
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
        for (const id of [...animations.keys()]) cancelMotion(id);
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
        getVisualTokenPoint(tokenId) { return normalizeTokenPoint(visualPoints.get(String(tokenId))); },
        isTokenMoving(tokenId) { return animations.has(String(tokenId)); },
      });
      render();
      api.emit?.('renderer:ready', { canonicalSceneTokens: true, count: views.size });
    },
  });
}
