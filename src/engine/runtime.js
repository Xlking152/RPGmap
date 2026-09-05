import L from 'leaflet';
import { worldToLatLng, latLngToWorld } from './geometry.js';
import { featureBounds } from './feature-selection.js';
import {
  commitResetSceneEvent,
  commitRestoreEvent,
  undoLastSceneEvent,
} from './state.js';
import { createWorldStatePersistence } from '../app/world-storage.js';
import {
  exportRuntimeState,
  prepareRuntimeState,
  validateRuntimeState,
} from './runtime-state.js';
import { createMapPresentation } from '../render/map-presentation.js';
import { createSceneRenderer } from '../render/scene-renderer.js';
import { applyDocumentChanges, documentChangeSet } from '../documents/changes.js';

const MAX_SAVE_FILE_BYTES = 5 * 1024 * 1024;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseSvg(markup) {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(markup, 'image/svg+xml');
  const error = documentNode.querySelector('parsererror');
  if (error) throw new Error('地图 SVG 解析失败');
  return documentNode.documentElement;
}

function shellMarkup() {
  return `
    <div class="app-shell runtime-v2-shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">R</span>
          <span class="brand-copy">
            <h1 data-role="app-title"></h1>
            <p>场景地图 · 角色与战斗</p>
          </span>
        </div>
        <nav class="toolbar" aria-label="地图工具"></nav>
        <div class="toolbar-right"></div>
      </header>
      <main class="workspace">
        <section class="map-card">
          <div id="map"></div>
          <div class="map-status" data-role="map-status">浏览模式</div>
        </section>
        <aside class="sidebar">
          <div class="tabbar" role="tablist"></div>
          <div class="panel-stack">
            <section class="panel active" data-panel="actors" data-canonical-panel-owner="true"></section>
            <section class="panel" data-panel="current" data-canonical-panel-owner="true"></section>
            <section class="panel" data-panel="inspect" data-canonical-panel-owner="true"></section>
            <section class="panel" data-panel="areas" data-canonical-panel-owner="true"></section>
            <section class="panel" data-panel="markers" data-canonical-panel-owner="true"></section>
          </div>
        </aside>
      </main>
      <div class="toast-stack" data-role="toasts"></div>
      <div data-role="modal-root"></div>
    </div>
  `;
}

function inside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

export function createRpgMapRuntime({
  container,
  worldId = null,
  worldName = '',
  mapPackage,
  ruleset,
  storageAdapter,
  initialLoad = null,
  tools = [],
} = {}) {
  if (!container) throw new Error('缺少应用容器');
  if (!mapPackage?.createSvg) throw new Error('地图包缺少 createSvg()');
  if (!ruleset?.id) throw new Error('Runtime 缺少 Ruleset');
  if (!storageAdapter) throw new Error('Runtime 缺少 storageAdapter');

  container.innerHTML = shellMarkup();
  const documentNode = container.ownerDocument || document;
  container.querySelector('[data-role="app-title"]').textContent = mapPackage.title || mapPackage.name || 'RPGmap';
  const elements = {
    map: container.querySelector('#map'),
    status: container.querySelector('[data-role="map-status"]'),
    toasts: container.querySelector('[data-role="toasts"]'),
    modalRoot: container.querySelector('[data-role="modal-root"]'),
    panels: Object.fromEntries([...container.querySelectorAll('[data-panel]')].map(node => [node.dataset.panel, node])),
  };

  const bus = new EventTarget();
  let state = null;
  let currentTool = 'pan';
  let activePanel = 'actors';
  let selectedFeatureId = null;
  let destroyed = false;
  let gridFrame = null;

  const persistence = createWorldStatePersistence({
    worldId,
    worldName,
    mapPackage,
    ruleset,
    storageAdapter,
    getState: () => state,
    onSaved: () => bus.dispatchEvent(new CustomEvent('state:saved')),
    onError: error => showToast(`自动保存失败，已暂停后续写入：${error.message}`, 'error'),
    initialLoad,
  });
  const loaded = persistence.load();
  state = loaded.state;

  const map = L.map(elements.map, {
    crs: L.CRS.Simple,
    minZoom: -4,
    maxZoom: 5,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    doubleClickZoom: false,
    attributionControl: false,
    preferCanvas: false,
  });

  const paneSpecs = [
    ['basePane', 200, 'none'],
    ['gridPane', 280, 'none'],
    ['damagePane', 340, 'none'],
    ['measurePane', 440, null],
    ['selectionPane', 530, 'none'],
    ['handlePane', 560, null],
  ];
  for (const [name, zIndex, pointerEvents] of paneSpecs) {
    const pane = map.createPane(name);
    pane.style.zIndex = String(zIndex);
    if (pointerEvents) pane.style.pointerEvents = pointerEvents;
  }

  const baseSvg = parseSvg(mapPackage.createSvg());
  const baseBounds = L.latLngBounds(
    worldToLatLng({ x: 0, y: mapPackage.height }, mapPackage.height),
    worldToLatLng({ x: mapPackage.width, y: 0 }, mapPackage.height),
  );
  L.svgOverlay(baseSvg, baseBounds, { pane: 'basePane', interactive: false }).addTo(map);
  const gridLayer = L.layerGroup([], { pane: 'gridPane' }).addTo(map);
  const sceneRenderer = createSceneRenderer({
    baseSvg,
    mapPackage,
    getSceneEvents: () => state?.sceneEvents || [],
    getDamagePreview: () => api.sceneAreas?.getPreview?.() || null,
  });
  const mapPresentation = createMapPresentation({ map, baseSvg, mapPackage });

  function emit(type, detail) {
    bus.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function on(type, listener) {
    bus.addEventListener(type, listener);
    return () => bus.removeEventListener(type, listener);
  }

  function setStatus(message) {
    if (elements.status) elements.status.textContent = String(message || '');
  }

  function showToast(message, type = '') {
    const toast = documentNode.createElement('div');
    toast.className = `toast${type ? ` ${type}` : ''}`;
    toast.textContent = String(message || '');
    elements.toasts?.append(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function fitInitialView(animate = true) {
    const configured = mapPackage.initialView?.bounds || mapPackage.initialView;
    const bounds = Array.isArray(configured) && configured.length === 4
      ? configured
      : [0, 0, mapPackage.width, mapPackage.height];
    const southWest = worldToLatLng({ x: Number(bounds[0]), y: Number(bounds[3]) }, mapPackage.height);
    const northEast = worldToLatLng({ x: Number(bounds[2]), y: Number(bounds[1]) }, mapPackage.height);
    map.fitBounds([southWest, northEast], { padding: [24, 24], animate });
    return true;
  }

  function gridSpacing() {
    const zoom = map.getZoom();
    if (zoom >= 2.5) return 1;
    if (zoom >= 1.2) return 5;
    if (zoom >= 0) return 20;
    if (zoom >= -1.5) return 100;
    return 500;
  }

  function renderGrid() {
    gridLayer.clearLayers();
    const spacing = gridSpacing();
    const bounds = map.getBounds();
    const northWest = latLngToWorld({ lat: bounds.getNorth(), lng: bounds.getWest() }, mapPackage.height);
    const southEast = latLngToWorld({ lat: bounds.getSouth(), lng: bounds.getEast() }, mapPackage.height);
    const minX = clamp(Math.min(northWest.x, southEast.x), 0, mapPackage.width);
    const maxX = clamp(Math.max(northWest.x, southEast.x), 0, mapPackage.width);
    const minY = clamp(Math.min(northWest.y, southEast.y), 0, mapPackage.height);
    const maxY = clamp(Math.max(northWest.y, southEast.y), 0, mapPackage.height);
    const firstX = Math.floor(minX / spacing) * spacing;
    const firstY = Math.floor(minY / spacing) * spacing;
    for (let x = firstX; x <= maxX + spacing; x += spacing) {
      L.polyline([
        worldToLatLng({ x, y: minY }, mapPackage.height),
        worldToLatLng({ x, y: maxY }, mapPackage.height),
      ], { pane: 'gridPane', interactive: false, weight: 0.7, className: 'grid-minor' }).addTo(gridLayer);
    }
    for (let y = firstY; y <= maxY + spacing; y += spacing) {
      L.polyline([
        worldToLatLng({ x: minX, y }, mapPackage.height),
        worldToLatLng({ x: maxX, y }, mapPackage.height),
      ], { pane: 'gridPane', interactive: false, weight: 0.7, className: 'grid-minor' }).addTo(gridLayer);
    }
  }

  function renderScene() {
    if (destroyed) return;
    sceneRenderer.render();
    mapPresentation.schedule();
    if (gridFrame) cancelAnimationFrame(gridFrame);
    gridFrame = requestAnimationFrame(() => {
      gridFrame = null;
      renderGrid();
    });
  }

  function setActivePanel(name) {
    const target = String(name || '');
    if (!elements.panels[target]) return false;
    activePanel = target;
    for (const panel of Object.values(elements.panels)) panel.classList.toggle('active', panel === elements.panels[target]);
    container.querySelectorAll('[data-ui-panel]').forEach(node => node.classList.toggle('active', node.dataset.uiPanel === target));
    emit('ui:panel-change', { panel: target });
    return true;
  }

  function setTool(tool) {
    currentTool = String(tool || 'pan');
    container.dataset.tool = currentTool;
    elements.map.style.cursor = ['inspect', 'aoe'].includes(currentTool) ? 'crosshair' : '';
    emit('tool:change', { tool: currentTool });
    return currentTool;
  }

  function getTool() {
    return currentTool;
  }

  function normalizeState(nextState) {
    return validateRuntimeState(nextState, { mapPackage, ruleset });
  }

  function commitState(nextState, { source = 'local', render = true } = {}) {
    state = normalizeState(nextState);
    if (render) renderScene();
    persistence.schedule();
    emit('state:commit', { source, state: clone(state) });
    return true;
  }

  function emitAuthoritativeChanges({ source, changeSet = {}, revision = null } = {}) {
    const actorIds = Array.isArray(changeSet.actors)
      ? changeSet.actors.map(String)
      : [...(changeSet.actors?.upsertIds || []), ...(changeSet.actors?.removeIds || [])].map(String);
    const tokenChanges = Array.isArray(changeSet.tokens) ? changeSet.tokens : [];
    const changedTokenIds = [];
    for (const entry of tokenChanges) {
      if (entry.sceneId && String(entry.sceneId) !== String(state.preferences?.worldV2?.activeSceneId)) continue;
      for (const tokenId of entry?.removeIds || []) {
        emit('token:delete', { id: String(tokenId), tokenId: String(tokenId), source, canonical: true });
      }
      for (const tokenId of entry?.upsertIds || []) {
        const id = String(tokenId);
        const fields = entry.fields?.[id];
        const positionOnly = fields?.length && fields.every(field => ['x', 'y', 'elevationFt', 'elevationMeters'].includes(field));
        if (!positionOnly) changedTokenIds.push(id);
        emit(positionOnly ? 'token:move' : 'token:property-change', { id, tokenId: id, fields, sceneId: entry.sceneId, source, canonical: true });
      }
    }
    if (actorIds.length) emit('actor:change', { actorIds, canonical: true });
    if (actorIds.length || changedTokenIds.length) {
      emit('health:change', { actorIds, tokenIds: changedTokenIds, canonical: true });
      emit('status:change', { actorIds, tokenIds: changedTokenIds, source, canonical: true });
    }
    if (changeSet.statusDefinitionsChanged) emit('status:definitions-change', { canonical: true });
    if (changeSet.combatChanged) emit('combat:change', { canonical: true });
    if (changeSet.chat?.appendedIds?.length || changeSet.chat?.cleared) {
      emit('chat:change', { ...clone(changeSet.chat), canonical: true });
    }
    for (const entry of changeSet.featureStates || []) {
      emit('feature:state-change', { sceneId: entry.sceneId, featureIds: clone(entry.featureIds || []), canonical: true });
    }
    for (const entry of changeSet.fog || []) {
      emit('fog:change', { sceneId: entry.sceneId, dirtyBounds: clone(entry.dirtyBounds || null), canonical: true });
    }
    for (const entry of changeSet.sceneContent || []) {
      if (String(entry.sceneId) !== String(state.preferences?.worldV2?.activeSceneId)) continue;
      if (entry.types.includes('SceneEvent')) renderScene();
      emit('scene:content-change', { ...entry, canonical: true });
    }
    if (changeSet.scenes?.activeSceneChanged) {
      renderScene();
      emit('scene:activate', { sceneId: state.preferences?.worldV2?.activeSceneId || null, source, canonical: true });
    } else if (changeSet.scenes?.upsertIds?.length || changeSet.scenes?.removeIds?.length) {
      if (changeSet.scenes.upsertIds?.includes(String(state.preferences?.worldV2?.activeSceneId))) renderScene();
      emit('scene:update', { sceneIds: [...(changeSet.scenes.upsertIds || []), ...(changeSet.scenes.removeIds || [])], source, canonical: true });
    }
    const detail = { source, revision, changeSet: clone(changeSet) };
    if (!String(source || '').startsWith('document.')) detail.state = clone(state);
    emit('state:patch', detail);
    return true;
  }

  function applyAuthoritativePatchState(nextState, {
    source = 'world.operation', changeSet = {}, revision = null,
  } = {}) {
    state = normalizeState(nextState);
    return emitAuthoritativeChanges({ source, changeSet, revision });
  }

  function applyAuthoritativeDocumentChanges(changes, {
    source = 'document.batch', revision = null, updatedAt = null, operationId = null,
  } = {}) {
    state = applyDocumentChanges(state, changes, { updatedAt });
    const changeSet = documentChangeSet(changes);
    api.documents?.applyCommitted?.(changes, { revision, operationId });
    return emitAuthoritativeChanges({ source, changeSet, revision });
  }

  async function commitAuthoritativeState(nextState, { source = 'authoritative-world', reason = source, render = true } = {}) {
    const normalized = normalizeState(nextState);
    const multiplayer = api.multiplayer?.getStatus?.();
    if (multiplayer?.connected) {
      if (typeof api.multiplayer?.performStateOperation === 'function') {
        return api.multiplayer.performStateOperation(normalized, { reason });
      }
      if (typeof api.multiplayer?.performWorldOperation !== 'function') {
        throw new Error('当前局域网控制器不支持服务器确认提交');
      }
      return api.multiplayer.performWorldOperation(normalized, { reason });
    }
    commitState(normalized, { source, render });
    return { offline: true };
  }

  async function importState(raw, { source = 'file-import', persist = true } = {}) {
    const prepared = prepareRuntimeState(raw, { mapPackage, ruleset });
    const normalized = normalizeState(prepared.state);
    if (persist) persistence.replace(normalized);
    state = normalized;
    selectedFeatureId = null;
    renderScene();
    emit('state:import', { source, state: clone(state), migrated: prepared.migrated === true });
    if (prepared.migrated) {
      emit('state:migrate', {
        fromVersion: prepared.fromVersion,
        toVersion: prepared.toVersion,
        migratedCharacters: prepared.migratedCharacters || 0,
        warnings: [...(prepared.warnings || [])],
      });
    }
    return true;
  }

  function exportState() {
    return exportRuntimeState(state, { mapPackage, ruleset });
  }

  function downloadState() {
    const payload = exportState();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = documentNode.createElement('a');
    link.href = url;
    link.download = `${worldId || mapPackage.id}-world-${new Date().toISOString().slice(0, 10)}.json`;
    documentNode.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast('World 存档已导出', 'success');
    return true;
  }

  async function importFile(file) {
    if (!file) return false;
    if (file.size > MAX_SAVE_FILE_BYTES) throw new Error('存档文件超过 5 MB 上限');
    const text = await file.text();
    return importState(JSON.parse(text), { source: 'file-import', persist: true });
  }

  function focusFeatureIds(ids) {
    const bounds = featureBounds(ids, mapPackage.features || []);
    if (!bounds) return false;
    const leafletBounds = L.latLngBounds(
      worldToLatLng({ x: bounds.minX, y: bounds.minY }, mapPackage.height),
      worldToLatLng({ x: bounds.maxX, y: bounds.maxY }, mapPackage.height),
    );
    map.fitBounds(leafletBounds, { padding: [64, 64], maxZoom: 2.5, animate: true });
    return true;
  }

  function focusFeature(featureId) {
    return focusFeatureIds([featureId]);
  }

  function selectFeature(featureId, options = {}) {
    const feature = (mapPackage.features || []).find(item => String(item.id) === String(featureId));
    if (!feature) return false;
    selectedFeatureId = String(feature.id);
    if (options.switchTab !== false) setActivePanel('inspect');
    if (options.focus === true) focusFeature(feature.id);
    emit('feature:select', { id: feature.id, featureId: feature.id });
    return true;
  }

  function restoreFeatures(featureIds) {
    const before = state;
    const next = commitRestoreEvent(before, [...new Set(featureIds || [])]);
    if (next === before) return false;
    commitState(next, { source: 'scene:restore', render: true });
    emit('scene:restore', clone(state.sceneEvents?.at?.(-1) || null));
    return true;
  }

  function undoScene() {
    const before = state;
    const next = undoLastSceneEvent(before);
    if (next === before) return false;
    commitState(next, { source: 'scene:undo', render: true });
    emit('scene:undo', null);
    return true;
  }

  function resetScene() {
    const before = state;
    const next = commitResetSceneEvent(before);
    if (next === before) return false;
    commitState(next, { source: 'scene:reset', render: true });
    emit('scene:reset', null);
    return true;
  }

  function persistNow() {
    return persistence.persistNow();
  }

  const uiPanels = Object.freeze({
    canonical: true,
    actors: elements.panels.actors,
    inspect: elements.panels.inspect,
    get(name) { return elements.panels[String(name)] || null; },
  });

  const api = {
    map,
    mapPackage,
    ruleset,
    uiPanels,
    getState: () => clone(state),
    getTool,
    setTool,
    setActivePanel,
    getActivePanel: () => activePanel,
    getSelectedFeatureId: () => selectedFeatureId,
    commitState,
    applyAuthoritativePatchState,
    applyAuthoritativeDocumentChanges,
    commitAuthoritativeState,
    persistNow,
    exportState,
    importState,
    downloadState,
    importFile,
    resetView: fitInitialView,
    selectFeature,
    focusFeature,
    focusFeatureIds,
    restoreFeatures,
    undoScene,
    resetScene,
    setStatus,
    showToast,
    on,
    emit,
    registerTool(tool) { tool?.register?.(api); },
    destroy() {
      if (destroyed) return false;
      destroyed = true;
      persistence.cancel();
      persistNow();
      if (gridFrame) cancelAnimationFrame(gridFrame);
      mapPresentation.destroy();
      map.remove();
      container.replaceChildren();
      return true;
    },
  };

  container.rpgMapApp = api;
  fitInitialView(false);
  for (const tool of tools) tool?.register?.(api);
  renderScene();
  if (loaded.notice) showToast(loaded.notice.message, loaded.notice.type);
  emit('runtime:ready', { worldAuthority: 'World.scenes[].tokens[]' });
  return api;
}
