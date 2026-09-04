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
    .rpg-token-v2 .rpg-token-v2-core { position:relative; border-radius:50%; overflow:visible; transform:scale(1); transition:transform 140ms ease,filter 140ms ease; transform-origin:center; }
    .rpg-token-v2 .rpg-token-v2-core.selected { transform:scale(1.16); filter:drop-shadow(0 4px 8px rgba(0,0,0,.34)); }
    .rpg-token-v2 .rpg-token-v2-portrait { width:100%; height:100%; display:grid; place-items:center; border-radius:inherit; overflow:hidden; }
    .rpg-token-v2,.rpg-token-v2 * { user-select:none; -webkit-user-select:none; -webkit-user-drag:none; touch-action:none; }
    .rpg-token-v2 .rpg-token-v2-portrait img { width:100%; height:100%; object-fit:cover; -webkit-user-drag:none; pointer-events:none; }
    .rpg-token-v2-core[data-audience-visibility="allied-invisible"] { opacity:.48; filter:saturate(.55); }
    .rpg-token-v2-core[data-audience-visibility="vague"] .rpg-token-v2-portrait { opacity:.62; border:2px dashed #d9e0df; background:#7b8587; filter:grayscale(1); }
    .rpg-token-v2-core[data-gm-private="true"] .rpg-token-v2-portrait { opacity:.48; filter:saturate(.55); }
    .rpg-token-v2-flags { position:absolute; z-index:3; left:50%; bottom:calc(100% + 3px); transform:translateX(-50%); display:flex; gap:3px; white-space:nowrap; pointer-events:none; }
    .rpg-token-v2-flag { padding:2px 4px; border-radius:4px; color:#fff; background:rgba(39,52,55,.92); font:700 9px/1.2 "Microsoft YaHei",sans-serif; }
    .rpg-token-v2-flag.invisible { background:rgba(75,92,112,.92); }
    .token-v2-label-row { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
    .token-v2-elevation-label { display:inline-flex; align-items:center; min-height:17px; padding:1px 4px; border-radius:4px; color:#eaf6f7; background:rgba(42,67,72,.92); font-size:9px; font-weight:800; line-height:1.2; }
    .token-v2-name-label { font-weight:750; }
    .rpgmap-token-status-v2-marker { background:transparent !important; border:0 !important; pointer-events:auto !important; overflow:visible !important; cursor:pointer; }
    .selected-token-summary { position:absolute; right:12px; bottom:max(12px,env(safe-area-inset-bottom)); z-index:1600; width:210px; min-height:92px; box-sizing:border-box; display:flex; align-items:center; gap:11px; padding:10px; border:1px solid rgba(38,60,62,.28); border-radius:8px; background:rgba(248,250,247,.96); box-shadow:0 10px 28px rgba(18,27,29,.24); pointer-events:none; }
    .selected-token-summary[hidden] { display:none !important; }
    .selected-token-summary-portrait { flex:0 0 72px; width:72px; height:72px; display:grid; place-items:center; overflow:hidden; border:3px solid var(--token-color,#3d9b63); border-radius:50%; background:var(--token-color,#3d9b63); color:white; font:800 28px/1 sans-serif; }
    .selected-token-summary-portrait img { width:100%; height:100%; object-fit:cover; -webkit-user-drag:none; }
    .selected-token-summary-body { min-width:0; display:grid; gap:4px; }
    .selected-token-summary-body strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; color:#263638; }
    .selected-token-summary-body span { font-size:11px; color:#647174; }
    @media(max-width:650px){ .selected-token-summary{right:8px;bottom:76px;width:176px;min-height:76px;padding:8px}.selected-token-summary-portrait{flex-basis:56px;width:56px;height:56px;font-size:22px} }
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
  return Math.max(18, Math.min(144, model.diameterMeters * pixelsPerMeter(api)));
}

export function tokenIcon(api, model) {
  const size = renderSize(api, model);
  const portrait = model.avatarDataUrl
    ? `<img src="${escapeHtml(model.avatarDataUrl)}" alt="" draggable="false">`
    : `<span>${escapeHtml((Array.from(model.name)[0] || '?').toUpperCase())}</span>`;
  const flags = model.gmViewer ? [
    ...(model.gmOnly ? ['<span class="rpg-token-v2-flag gm-only">GM 专属</span>'] : []),
    ...(model.invisible ? ['<span class="rpg-token-v2-flag invisible">隐身</span>'] : []),
  ].join('') : '';
  const gmPrivate = model.gmViewer && (model.gmOnly || model.invisible);
  return L.divIcon({
    className: 'rpg-token-v2',
    html: `<div class="rpg-token-v2-core${model.selected ? ' selected' : ''}" data-token-id="${escapeHtml(model.id)}" data-audience-visibility="${escapeHtml(model.audienceVisibility || '')}" data-gm-private="${gmPrivate}" style="--token-color:${model.color};--token-size:${size}px">${flags ? `<span class="rpg-token-v2-flags">${flags}</span>` : ''}<div class="rpg-token-v2-portrait" style="transform:rotate(${model.rotation}deg)">${portrait}</div></div>`,
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
      ensurePane(api.map, STATUS_PANE, 540, { pointerEvents: 'auto' });

      const tokenLayer = L.layerGroup([], { pane: TOKEN_PANE }).addTo(api.map);
      const statusLayer = L.layerGroup([], { pane: STATUS_PANE }).addTo(api.map);
      const views = new Map();
      const statusViews = new Map();
      const models = new Map();
      const visualPoints = new Map();
      const animations = new Map();
      const preparedRoutes = new Map();
      let eventRenderFrame = null;
      const pendingRenderIds = new Set();
      let pendingFullRender = false;
      let selectedIds = new Set(api.selection?.getSelectedTokenIds?.() || []);
      let destroyed = false;
      const off = [];
      const summary = documentNode.createElement('aside');
      summary.className = 'selected-token-summary';
      summary.hidden = true;
      const summaryHost = api.map.getContainer().parentElement || documentNode.body;
      if (summaryHost && windowNode.getComputedStyle?.(summaryHost).position === 'static') summaryHost.style.position = 'relative';
      summaryHost.append(summary);

      function resolveModel(token) {
        try {
          const resolved = api.tokens.resolveActor(token.id);
          const statusSnapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
          const multiplayer = api.multiplayer?.getStatus?.() || {};
          const gmViewer = !multiplayer.connected || multiplayer.session?.role === 'gm' || multiplayer.role === 'gm';
          return createTokenViewModel({
            token,
            actor: resolved.actor,
            selected: selectedIds.has(String(token.id)),
            ruleset: api.ruleset,
            gmViewer,
            invisible: statusSnapshot.capabilities?.visibility === 'invisible',
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

      function removeStatus(tokenId) {
        const id = String(tokenId || '');
        const view = statusViews.get(id);
        if (view) statusLayer.removeLayer(view);
        statusViews.delete(id);
      }

      function renderStatus(model, token) {
        if (!model || !token || model.audienceRestricted || animations.has(model.id)) {
          removeStatus(model?.id || token?.id);
          return;
        }
        const snapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
        const badgeHtml = renderTokenStatusBadges(snapshot.statuses, { limit: 4 });
        if (!badgeHtml) {
          removeStatus(model.id);
          return;
        }
        const tokenPixels = renderSize(api, { ...model, selected: false });
        const icon = L.divIcon({
          className: 'rpgmap-token-status-v2-marker',
          html: `<span data-token-id="${escapeHtml(token.id)}">${badgeHtml}</span>`,
          iconSize: [1, 1],
          iconAnchor: [-(tokenPixels / 2 + 3), tokenPixels / 2],
        });
        let view = statusViews.get(model.id);
        if (!view) {
          view = L.marker(worldToLatLng(model, api.mapPackage.height), {
            pane: STATUS_PANE, interactive: true, keyboard: false, icon, rpgTokenId: model.id,
          }).on('click', event => {
            L.DomEvent.stopPropagation(event);
            const tokenId = event.target?.options?.rpgTokenId;
            if (tokenId) void api.statusUi?.openQuickHud?.(tokenId, event.originalEvent || null);
          }).addTo(statusLayer);
          statusViews.set(model.id, view);
        } else {
          view.setLatLng(worldToLatLng(model, api.mapPackage.height));
          view.setIcon(icon);
        }
      }

      function renderSummary() {
        const primaryId = String(api.selection?.getPrimaryTokenId?.() || '');
        const model = models.get(primaryId) || [...models.values()].find(item => item.selected) || null;
        if (!model) {
          summary.hidden = true;
          summary.replaceChildren();
          return;
        }
        if (model.audienceVisibility === 'vague') {
          summary.hidden = true;
          summary.replaceChildren();
          return;
        }
        const portrait = model.avatarDataUrl
          ? `<img src="${escapeHtml(model.avatarDataUrl)}" alt="" draggable="false">`
          : escapeHtml((Array.from(model.name)[0] || '?').toUpperCase());
        let healthText = '';
        if (!model.audienceRestricted) {
          const health = api.health?.resolveToken?.(model.id);
          if (health && Number.isFinite(Number(health.current)) && Number.isFinite(Number(health.max))) {
            healthText = `<span>生命 ${Number(health.current)} / ${Number(health.max)}</span>`;
          }
        }
        summary.style.setProperty('--token-color', model.color);
        summary.innerHTML = `<div class="selected-token-summary-portrait">${portrait}</div><div class="selected-token-summary-body"><strong>${escapeHtml(model.name)}</strong><span>${model.audienceRestricted ? '公开摘要' : model.actorLink ? '共享角色' : '独立实例'}</span>${healthText}</div>`;
        summary.hidden = false;
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
          api.emit?.('token:visual-position', { id: motion.id, tokenId: motion.id, point, predicted: motion.prediction === true });
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
          const canonical = normalizeTokenPoint(api.tokens.get?.(motion.id));
          if (!motion.prediction || sameTokenPoint(canonical, motion.target)) renderToken(motion.id);
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
          preparedRoutes.delete(id);
          visualPoints.set(id, target);
          view.setLatLng(worldToLatLng(target, api.mapPackage.height));
          return;
        }
        let path = preparedRoutes.get(id) || [];
        preparedRoutes.delete(id);
        if (!path.length || !sameTokenPoint(path.at(-1), target)) path = [target];
        path = path.map(normalizeTokenPoint).filter(Boolean).filter((point, index, values) => {
          const previous = index ? values[index - 1] : current;
          return !sameTokenPoint(previous, point);
        });
        if (!path.length) path = [target];
        const [first, ...queue] = path;
        const motion = { id, view, from: current, target: first, queue, frame: null, startedAt: null, duration: 0, prediction: false };
        animations.set(id, motion);
        api.emit?.('token:visual-move-start', { id, tokenId: id, from: current, to: target });
        beginSegment(motion, first);
      }

      function removeToken(tokenId) {
        const id = String(tokenId || '');
        cancelMotion(id, { emitEnd: true });
        const view = views.get(id);
        if (view) tokenLayer.removeLayer(view);
        views.delete(id);
        models.delete(id);
        visualPoints.delete(id);
        preparedRoutes.delete(id);
        removeStatus(id);
      }

      function renderToken(tokenId, { summary: updateSummary = true } = {}) {
        if (destroyed) return;
        const id = String(tokenId || '');
        const token = api.tokens.get?.(id);
        const model = token ? resolveModel(token) : null;
        if (!model) {
          removeToken(id);
          if (updateSummary) renderSummary();
          return;
        }
        models.set(id, model);
        let view = views.get(id);
        if (!view) {
          const point = normalizeTokenPoint(model);
          view = L.marker(worldToLatLng(point, api.mapPackage.height), {
            icon: tokenIcon(api, model), keyboard: true, pane: TOKEN_PANE,
            title: model.showName ? model.name : 'Token', rpgTokenId: id,
          }).addTo(tokenLayer);
          visualPoints.set(id, point);
          view.on('click', event => {
            L.DomEvent.stopPropagation(event);
            const current = models.get(id);
            if (current?.audienceVisibility === 'vague') return;
            const selected = api.tokens.get(id);
            if (!selected) return;
            api.selection?.replace?.([id], id);
            api.emit?.('token:select', { id, tokenId: id, actorId: selected.actorId });
          });
          view.on('contextmenu', event => {
            L.DomEvent.preventDefault(event);
            L.DomEvent.stopPropagation(event);
            if (event.originalEvent?.shiftKey) return api.elevation?.openTokenElevationEditor?.(id, event.originalEvent);
            void api.statusUi?.openQuickHud?.(id, event.originalEvent || null);
          });
          views.set(id, view);
        }
        moveView(model, view);
        view.setIcon(tokenIcon(api, model));
        view.options.title = model.showName ? model.name : 'Token';
        setTooltip(api, documentNode, view, model);
        renderStatus(model, token);
        if (updateSummary) renderSummary();
      }

      function render() {
        if (destroyed) return;
        const tokens = api.tokens.list();
        const live = new Set(tokens.map(token => String(token.id)));
        for (const id of [...views.keys()]) if (!live.has(id)) removeToken(id);
        for (const token of tokens) renderToken(token.id, { summary: false });
        renderSummary();
      }

      function flushEventRender() {
        eventRenderFrame = null;
        if (pendingFullRender) render();
        else {
          for (const id of pendingRenderIds) renderToken(id, { summary: false });
          renderSummary();
        }
        pendingRenderIds.clear();
        pendingFullRender = false;
      }

      function renderEventTokens(event) {
        const detail = event?.detail || {};
        const address = detail.document || {};
        const ids = new Set([
          detail.tokenId, detail.id, ...(detail.tokenIds || []),
          address.type === 'Token' ? address.id : null,
        ].filter(Boolean).map(String));
        const actorIds = new Set([
          detail.actorId, ...(detail.actorIds || []),
          address.type === 'Actor' ? address.id : null,
        ].filter(Boolean).map(String));
        if (actorIds.size) {
          for (const token of api.tokens.list()) if (actorIds.has(String(token.actorId))) ids.add(String(token.id));
        }
        if (!ids.size) pendingFullRender = true;
        else for (const id of ids) pendingRenderIds.add(id);
        if (eventRenderFrame === null) eventRenderFrame = requestFrame(flushEventRender);
      }

      const selectionOff = api.selection?.subscribe?.(snapshot => {
        const previous = selectedIds;
        selectedIds = new Set((snapshot?.ids || []).map(String));
        const changed = new Set([...previous, ...selectedIds]);
        for (const id of changed) renderToken(id, { summary: false });
        renderSummary();
      });
      if (selectionOff) off.push(selectionOff);

      for (const eventName of [
        'token:create', 'token:delete', 'token:move', 'token:size-change',
        'token:property-change', 'actor:change', 'health:change', 'status:change',
      ]) off.push(api.on(eventName, renderEventTokens));
      for (const eventName of ['document:create', 'document:update', 'document:delete', 'document:move']) {
        off.push(api.on(eventName, renderEventTokens));
      }
      for (const eventName of ['state:import', 'scene:activate']) off.push(api.on(eventName, render));

      api.map.on('zoomend', render);
      api.map.on('resize', render);
      off.push(api.on('app:destroy', () => {
        destroyed = true;
        api.map.off('zoomend', render);
        api.map.off('resize', render);
        for (const id of [...animations.keys()]) cancelMotion(id);
        if (eventRenderFrame !== null) cancelFrame(eventRenderFrame);
        eventRenderFrame = null;
        preparedRoutes.clear();
        tokenLayer.clearLayers();
        statusLayer.clearLayers();
        statusViews.clear();
        api.map.removeLayer?.(tokenLayer);
        api.map.removeLayer?.(statusLayer);
        summary.remove();
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.renderer = Object.freeze({
        canonicalSceneTokens: true,
        renderTokens: render,
        getVisibleTokenIds() { return [...views.keys()]; },
        getVisualTokenPoint(tokenId) { return normalizeTokenPoint(visualPoints.get(String(tokenId))); },
        isTokenMoving(tokenId) { return animations.has(String(tokenId)); },
        prepareTokenVisualRoute(tokenId, points = []) {
          const id = String(tokenId || '');
          if (!id) return false;
          const route = points.map(normalizeTokenPoint).filter(Boolean);
          if (route.length) preparedRoutes.set(id, route);
          else preparedRoutes.delete(id);
          return true;
        },
        predictTokenVisualRoute(tokenId, points = []) {
          const id = String(tokenId || '');
          const view = views.get(id);
          const route = points.map(normalizeTokenPoint).filter(Boolean);
          const current = normalizeTokenPoint(visualPoints.get(id));
          if (!id || !view || !current || !route.length) return false;
          cancelMotion(id);
          const filtered = route.filter((point, index, values) => {
            const previous = index ? values[index - 1] : current;
            return !sameTokenPoint(previous, point);
          });
          if (!filtered.length) return true;
          const [first, ...queue] = filtered;
          const motion = { id, view, from: current, target: first, queue, frame: null, startedAt: null, duration: 0, prediction: true };
          animations.set(id, motion);
          api.emit?.('token:visual-move-start', { id, tokenId: id, from: current, to: filtered.at(-1), predicted: true });
          beginSegment(motion, first);
          return true;
        },
        rollbackTokenVisual(tokenId) {
          const id = String(tokenId || '');
          cancelMotion(id);
          const canonical = normalizeTokenPoint(api.tokens.get?.(id));
          if (!canonical) return false;
          preparedRoutes.set(id, [canonical]);
          renderToken(id);
          return true;
        },
      });
      render();
      api.emit?.('renderer:ready', { canonicalSceneTokens: true, count: views.size });
    },
  });
}
