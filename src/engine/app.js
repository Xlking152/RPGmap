import L from 'leaflet';
import {
  Bomb,
  Download,
  Hand,
  Landmark,
  LogIn,
  LogOut,
  LocateFixed,
  MapPin,
  MousePointer2,
  RotateCcw,
  Route,
  Ruler,
  Scan,
  Trash2,
  Upload,
  UserRound,
  createIcons
} from 'lucide';
import {
  worldToLatLng,
  latLngToWorld,
  distanceMeters,
  formatDistance,
  snapPoint,
  attackAreaToPolygon,
  routeSegments,
  markerIdsInBounds
} from './geometry.js';
import {
  migrateSave,
  validateAndNormalizeSave,
  exportSave,
  createDamagePreview,
  commitDamageEvent,
  commitRestoreEvent,
  commitResetSceneEvent,
  undoLastSceneEvent,
  removeMarkers,
  deriveSceneState
} from './state.js';
import {
  createNavigationBase,
  createNavigationGrid,
  findNavigationPath,
  nearestWalkablePoint
} from './navigation.js';
import { createBrowserStorage, createStatePersistence } from '../app/storage.js';
import { createMapPresentation } from '../render/map-presentation.js';
import { createSceneRenderer } from '../render/scene-renderer.js';
import {
  featureBounds,
  featureIdsForEvent,
  featureSceneStatus,
  inspectableFeaturesAtPoint
} from './feature-selection.js';

const MAX_SAVE_FILE_BYTES = 5 * 1024 * 1024;
const MARKER_COLORS = [
  { name: '重要', value: '#d84a3a' },
  { name: '普通', value: '#3c7ec9' },
  { name: '友方', value: '#3d9b63' },
  { name: '警示', value: '#d99729' },
  { name: '特殊', value: '#8555a5' }
];
const AREA_COLORS = ['#d63d32', '#e48a28', '#7652a8', '#258a83', '#3f70c5'];
const APP_ICONS = {
  Bomb,
  Download,
  Hand,
  Landmark,
  LogIn,
  LogOut,
  LocateFixed,
  MapPin,
  MousePointer2,
  RotateCcw,
  Route,
  Ruler,
  Scan,
  Trash2,
  Upload,
  UserRound
};
const CATEGORY_LABELS = {
  building: '建筑',
  wall: '城墙',
  vegetation: '植被',
  bridge: '桥梁',
  terrain: '地表',
  road: '道路',
  water: '水体'
};
const SUBTYPE_LABELS = {
  yamen: '州衙',
  barracks: '营房',
  granary: '仓廪',
  stable: '马厩',
  workshop: '工坊',
  'market-office': '市易务',
  market: '市肆',
  temple: '神祠',
  residence: '民居',
  wall: '城墙',
  'wall-tower': '角楼',
  gate: '城门',
  'pass-wall': '关墙',
  'pass-gate': '关楼',
  vegetation: '树木',
  bridge: '浮桥'
};
const FEATURE_STATUS_LABELS = {
  intact: '完整',
  partial: '局部破坏',
  destroyed: '整毁'
};

function uid(prefix) {
  const id = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + '-' + id;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isEditableTarget(target) {
  return target instanceof HTMLElement && (
    target.matches('input,textarea,select,[contenteditable="true"]') ||
    Boolean(target.closest('input,textarea,select,[contenteditable="true"]'))
  );
}

function parseSvg(markup) {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(markup, 'image/svg+xml');
  const error = documentNode.querySelector('parsererror');
  if (error) throw new Error('地图 SVG 解析失败');
  return documentNode.documentElement;
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function worldInside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

function normalizeHeading(degrees) {
  return ((Number(degrees) % 360) + 360) % 360;
}

function forwardPoint(origin, distance, headingDeg) {
  const radians = normalizeHeading(headingDeg) * Math.PI / 180;
  return {
    x: origin.x + Math.sin(radians) * distance,
    y: origin.y - Math.cos(radians) * distance
  };
}

function headingBetween(origin, point) {
  return normalizeHeading(Math.atan2(point.x - origin.x, -(point.y - origin.y)) * 180 / Math.PI);
}

function angularDelta(a, b) {
  let delta = normalizeHeading(a) - normalizeHeading(b);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function resolveAreaOrigin(area, state, mapPackage = null) {
  if (area.anchor?.type === 'marker' && area.anchor.markerId) {
    const marker = state.markers.find(item => item.id === area.anchor.markerId);
    if (marker) return { x: marker.x, y: marker.y };
  }
  if (area.anchor?.type === 'character' && area.anchor.characterId) {
    const character = state.characters?.find(item => item.id === area.anchor.characterId);
    if (character?.location?.type === 'map') return { x: character.location.x, y: character.location.y };
    if (character?.location?.type === 'building') {
      const feature = mapPackage?.features?.find(item => item.id === character.location.featureId);
      if (feature?.center) return { x: feature.center[0], y: feature.center[1] };
    }
  }
  return { x: area.origin.x, y: area.origin.y };
}

function makeDefaultArea(shape, origin, color = AREA_COLORS[0]) {
  return {
    id: uid('area'),
    name: shape === 'circle' ? '圆形范围' : shape === 'sector' ? '扇形范围' : '矩形范围',
    shape,
    origin: { ...origin },
    anchor: { type: 'free', markerId: null },
    radius: 100,
    range: 200,
    angleDeg: 60,
    length: 300,
    width: 80,
    headingDeg: 0,
    color,
    opacity: 0.18,
    visible: true,
    destructionEnabled: false,
    severeDamage: false,
    craterEnabled: false,
    destructionTargets: ['building', 'wall', 'vegetation', 'bridge', 'terrain']
  };
}

function shellMarkup() {
  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"><i data-lucide="landmark"></i></span>
          <span class="brand-copy">
            <h1 data-role="app-title"></h1>
            <p>离线矢量 RPG 战术地图</p>
          </span>
        </div>
        <nav class="toolbar" aria-label="地图工具">
          <button class="tool-button active" data-tool="pan"><i data-lucide="hand"></i><span>浏览</span></button>
          <button class="tool-button" data-tool="marker"><i data-lucide="map-pin"></i><span>标记</span></button>
          <button class="tool-button" data-tool="marker-select"><i data-lucide="scan"></i><span>框选标记</span></button>
          <button class="tool-button" data-tool="inspect"><i data-lucide="mouse-pointer-2"></i><span>检查地物</span></button>
          <button class="tool-button" data-tool="character-move"><i data-lucide="user-round"></i><span>移动角色</span></button>
          <button class="tool-button" data-tool="distance"><i data-lucide="ruler"></i><span>两点测距</span></button>
          <button class="tool-button" data-tool="route"><i data-lucide="route"></i><span>路线测距</span></button>
          <button class="tool-button" data-tool="aoe"><i data-lucide="bomb"></i><span>范围攻击</span></button>
        </nav>
        <div class="toolbar-right">
          <button class="tool-button danger" data-action="clear-markers"><i data-lucide="trash-2"></i><span>清空标记</span></button>
          <button class="tool-button" data-action="focus-selected"><i data-lucide="locate-fixed"></i><span>定位所选</span></button>
          <button class="tool-button" data-action="reset-view"><i data-lucide="rotate-ccw"></i><span>回到底图</span></button>
          <button class="tool-button" data-action="export"><i data-lucide="download"></i><span>导出</span></button>
          <button class="tool-button" data-action="import"><i data-lucide="upload"></i><span>导入</span></button>
          <input type="file" accept="application/json,.json" data-role="import-file" hidden />
        </div>
      </header>
      <main class="workspace">
        <section class="map-card">
          <div id="map"></div>
          <div class="map-status" data-role="map-status">浏览模式：拖动地图，滚轮无损缩放</div>
        </section>
        <aside class="sidebar">
          <div class="tabbar" role="tablist">
            <button class="tab-button active" data-tab="markers">标记</button>
            <button class="tab-button" data-tab="characters">角色</button>
            <button class="tab-button" data-tab="inspect">地物</button>
            <button class="tab-button" data-tab="measure">测距</button>
            <button class="tab-button" data-tab="areas">范围</button>
            <button class="tab-button" data-tab="layers">图层</button>
          </div>
          <div class="panel-stack">
            <section class="panel active" data-panel="markers"></section>
            <section class="panel" data-panel="characters"></section>
            <section class="panel" data-panel="inspect"></section>
            <section class="panel" data-panel="measure"></section>
            <section class="panel" data-panel="areas"></section>
            <section class="panel" data-panel="layers"></section>
          </div>
        </aside>
      </main>
      <div class="toast-stack" data-role="toasts"></div>
      <div data-role="modal-root"></div>
    </div>
  `;
}

export function createRpgMapApp({
  container,
  mapPackage,
  storageAdapter = createBrowserStorage(),
  tools = []
}) {
  if (!container) throw new Error('缺少应用容器');
  if (!mapPackage?.createSvg) throw new Error('地图包缺少 createSvg()');

  container.innerHTML = shellMarkup();
  createIcons({
    icons: APP_ICONS,
    root: container,
    attrs: { width: 17, height: 17, 'stroke-width': 1.9, 'aria-hidden': 'true' }
  });
  container.querySelector('[data-role="app-title"]').textContent =
    mapPackage.title || mapPackage.name || 'RPG 矢量地图';
  const elements = {
    map: container.querySelector('#map'),
    status: container.querySelector('[data-role="map-status"]'),
    toasts: container.querySelector('[data-role="toasts"]'),
    modalRoot: container.querySelector('[data-role="modal-root"]'),
    importFile: container.querySelector('[data-role="import-file"]'),
    panels: Object.fromEntries([...container.querySelectorAll('[data-panel]')].map(node => [node.dataset.panel, node]))
  };

  const bus = new EventTarget();
  let state = null;
  const persistence = createStatePersistence({
    mapPackage,
    storageAdapter,
    getState: () => state,
    onSaved: () => bus.dispatchEvent(new CustomEvent('state:saved')),
    onError: error => showToast('自动保存失败，已暂停后续写入：' + error.message, 'error')
  });
  const loadedState = persistence.load();
  state = loadedState.state;
  const stateLoadNotice = loadedState.notice;
  const runtime = {
    tool: 'pan',
    activeTab: 'markers',
    currentMarkerColor: MARKER_COLORS[1].value,
    currentCharacterColor: MARKER_COLORS[2].value,
    selectedMarkerId: null,
    selectedCharacterId: null,
    characterMovePreview: null,
    characterMoveRequest: 0,
    navigationBase: null,
    navigationGrid: null,
    navigationRevision: null,
    measureA: null,
    measureB: null,
    routePoints: [],
    routeFinished: false,
    selectedAreaId: state.attackAreas[0]?.id || null,
    placingArea: false,
    pendingShape: 'circle',
    damagePreview: null,
    selectedFeatureId: null,
    highlightedFeatureIds: new Set(),
    featureHighlightSource: null,
    lastDeletedMarker: null,
    selectedMarkerIds: new Set(),
    markerSelectionDrag: null,
    gridVisible: state.preferences.gridVisible !== false
  };

  const map = L.map(elements.map, {
    crs: L.CRS.Simple,
    minZoom: -4,
    maxZoom: 5,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    doubleClickZoom: false,
    attributionControl: false,
    preferCanvas: false
  });

  createPanes();
  const baseSvg = parseSvg(mapPackage.createSvg());
  const baseBounds = L.latLngBounds(
    worldToLatLng({ x: 0, y: mapPackage.height }, mapPackage.height),
    worldToLatLng({ x: mapPackage.width, y: 0 }, mapPackage.height)
  );
  const baseOverlay = L.svgOverlay(baseSvg, baseBounds, {
    pane: 'basePane',
    interactive: false
  }).addTo(map);

  const layers = {
    grid: L.layerGroup([], { pane: 'gridPane' }).addTo(map),
    areas: L.layerGroup([], { pane: 'aoePane' }).addTo(map),
    areaHandles: L.layerGroup([], { pane: 'handlePane' }).addTo(map),
    markers: L.layerGroup([], { pane: 'markerPane' }).addTo(map),
    characters: L.layerGroup([], { pane: 'characterPane' }).addTo(map),
    characterRoute: L.layerGroup([], { pane: 'measurePane' }).addTo(map),
    markerSelection: L.layerGroup([], { pane: 'selectionPane' }).addTo(map),
    measure: L.layerGroup([], { pane: 'measurePane' }).addTo(map),
    route: L.layerGroup([], { pane: 'measurePane' }).addTo(map)
  };
  const markerViews = new Map();
  const characterViews = new Map();
  const areaViews = new Map();
  const featureById = new Map((mapPackage.features || []).map(feature => [feature.id, feature]));
  const sceneRenderer = createSceneRenderer({
    baseSvg,
    mapPackage,
    getSceneEvents: () => state.sceneEvents,
    getDamagePreview: () => runtime.damagePreview
  });
  const mapPresentation = createMapPresentation({ map, baseSvg, mapPackage });
  let gridFrame = null;

  addScaleControl();
  fitInitialView(false);
  invalidateNavigation();
  if (ejectDestroyedBuildingOccupants(deriveSceneState(state.sceneEvents).destroyedObjectIds).length) scheduleSave();
  renderAll();
  bindUi();
  bindMap();
  if (stateLoadNotice) showToast(stateLoadNotice.message, stateLoadNotice.type);

  const api = {
    map,
    mapPackage,
    getState: () => structuredClone(state),
    setTool,
    exportState: () => exportSave(state, mapPackage),
    importState: importSaveObject,
    on(type, listener) { bus.addEventListener(type, listener); return () => bus.removeEventListener(type, listener); },
    emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); },
    registerTool(tool) { tool?.register?.(api); },
    previewDamage,
    applyDamage,
    restoreFeatures,
    selectFeature,
    selectCharacter,
    planCharacterMove,
    commitCharacterMove,
    enterBuilding,
    exitBuilding,
    undoScene,
    destroy() {
      persistNow();
      if (gridFrame) cancelAnimationFrame(gridFrame);
      mapPresentation.destroy();
      map.remove();
      container.removeEventListener('click', handleClick);
      container.removeEventListener('change', handleChange);
      container.removeEventListener('input', handleInput);
      elements.map.removeEventListener('pointerdown', handleMarkerSelectionPointerDown, true);
      elements.map.removeEventListener('pointermove', handleMarkerSelectionPointerMove, true);
      elements.map.removeEventListener('pointerup', handleMarkerSelectionPointerUp, true);
      elements.map.removeEventListener('pointercancel', handleMarkerSelectionPointerCancel, true);
      elements.importFile.removeEventListener('change', handleImportFile);
      document.removeEventListener('keydown', handleKeydown);
    }
  };
  container.rpgMapApp = api;
  tools.forEach(tool => tool?.register?.(api));
  return api;

  function createPanes() {
    [
      ['basePane', 200],
      ['gridPane', 280],
      ['damagePane', 340],
      ['aoePane', 390],
      ['measurePane', 440],
      ['markerPane', 500],
      ['characterPane', 515],
      ['selectionPane', 530],
      ['handlePane', 560]
    ].forEach(([name, zIndex]) => {
      const pane = map.createPane(name);
      pane.style.zIndex = String(zIndex);
      if (name === 'basePane' || name === 'gridPane' || name === 'damagePane' || name === 'selectionPane') pane.style.pointerEvents = 'none';
    });
  }

  function scheduleSave() {
    persistence.schedule();
  }

  function persistNow() {
    persistence.persistNow();
  }

  function fitInitialView(animate = true) {
    const configured = mapPackage.initialView?.bounds || mapPackage.initialView;
    const bounds = Array.isArray(configured) && configured.length === 4 ? configured : [900, 300, 5100, 4550];
    const southWest = worldToLatLng({ x: bounds[0], y: bounds[3] }, mapPackage.height);
    const northEast = worldToLatLng({ x: bounds[2], y: bounds[1] }, mapPackage.height);
    map.fitBounds([southWest, northEast], { padding: [24, 24], animate });
  }

  function addScaleControl() {
    const control = L.control({ position: 'bottomleft' });
    control.onAdd = () => {
      const node = L.DomUtil.create('div', 'actual-scale-control');
      node.innerHTML = '<span data-scale-label>—</span><div class="scale-line" data-scale-line></div><small data-grid-label>网格 —</small>';
      L.DomEvent.disableClickPropagation(node);
      return node;
    };
    control.addTo(map);
  }

  function updateScale() {
    const label = elements.map.querySelector('[data-scale-label]');
    const line = elements.map.querySelector('[data-scale-line]');
    if (!label || !line) return;
    const center = map.getCenter();
    const point = map.latLngToContainerPoint(center);
    const other = map.containerPointToLatLng([point.x + 100, point.y]);
    const metersPerPixel = Math.abs(other.lng - center.lng) * (mapPackage.metersPerUnit || 1) / 100;
    const target = Math.max(0.01, metersPerPixel * 110);
    const exponent = Math.floor(Math.log10(target));
    const base = 10 ** exponent;
    const normalized = target / base;
    const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
    const meters = factor * base;
    const pixels = clamp(meters / metersPerPixel, 45, 150);
    label.textContent = meters >= 1000 ? (meters / 1000).toFixed(meters % 1000 ? 1 : 0) + '公里' : Math.round(meters) + '米';
    line.style.width = pixels + 'px';
  }

  function renderAll() {
    pruneFeatureHighlights();
    renderMarkers();
    renderCharacters();
    renderInspection();
    renderMeasurement();
    renderAreas();
    renderLayers();
    renderMarkerLayers();
    renderCharacterLayers();
    renderCharacterRoute();
    renderAreaLayers();
    renderMeasurementLayers();
    renderRouteLayers();
    renderScene();
    updateGrid();
    updateScale();
    syncToolUi();
  }

  function renderInspection() {
    const panel = elements.panels.inspect;
    panel.replaceChildren();

    const section = createElement('div', 'section');
    section.append(createElement('h2', '', '地物检查'));
    const feature = selectedFeature();
    if (!feature) {
      section.append(createElement('p', '', '启用检查工具后，点击建筑、城墙、城门、树木或桥梁。重叠时会优先选择更重要、更精确的对象。'));
      section.append(buttonNode('启用检查工具', 'primary', 'tool-inspect'));
      panel.append(section);
      return;
    }

    const status = featureSceneStatus(feature.id, state.sceneEvents);
    const heading = createElement('div', 'feature-heading');
    heading.append(
      createElement('div', 'feature-name', feature.name || feature.id),
      createElement('span', 'feature-status ' + status, FEATURE_STATUS_LABELS[status])
    );
    section.append(heading);

    const details = createElement('dl', 'feature-details');
    const center = Array.isArray(feature.center) ? feature.center : [0, 0];
    [
      ['类别', CATEGORY_LABELS[feature.category] || feature.category],
      ['地物类型', SUBTYPE_LABELS[feature.subtype] || feature.subtype || '未分类'],
      ['对象 ID', feature.id],
      ['中心坐标', 'x ' + Number(center[0]).toFixed(1) + ' · y ' + Number(center[1]).toFixed(1)]
    ].forEach(([term, value]) => {
      details.append(createElement('dt', '', term), createElement('dd', '', value));
    });
    section.append(details);

    if (feature.category === 'building' && feature.details) {
      const narrative = createElement('div', 'building-narrative');
      narrative.append(createElement('h3', '', '建筑详情'));
      [
        ['用途', feature.details.use],
        ['构造', feature.details.structure],
        ['说明', feature.details.description],
        ['入口', feature.enterable && feature.entrance
          ? 'x ' + Number(feature.entrance[0]).toFixed(1) + ' · y ' + Number(feature.entrance[1]).toFixed(1)
          : '通道建筑，不作为室内空间']
      ].forEach(([label, value]) => {
        const row = createElement('div', 'building-detail-row');
        row.append(createElement('strong', '', label), createElement('span', '', value));
        narrative.append(row);
      });
      section.append(narrative);

      const occupants = charactersInBuilding(feature.id);
      const occupantSection = createElement('div', 'building-occupants');
      occupantSection.append(createElement('h3', '', '内部角色 · ' + occupants.length));
      if (!occupants.length) occupantSection.append(createElement('div', 'empty-state compact', '当前无人'));
      occupants.forEach(character => {
        const button = createElement('button', 'occupant-button');
        button.type = 'button';
        button.dataset.action = 'select-character';
        button.dataset.id = character.id;
        button.append(characterPortraitNode(character, 'small'), createElement('span', '', character.name));
        occupantSection.append(button);
      });
      section.append(occupantSection);
    }

    const actions = createElement('div', 'button-row');
    actions.append(buttonNode('定位对象', 'primary', 'focus-feature', feature.id));
    const restore = buttonNode('恢复所选对象', status === 'intact' ? '' : 'danger', 'restore-feature', feature.id);
    restore.disabled = status === 'intact';
    actions.append(restore);
    if (feature.category === 'building' && feature.enterable) {
      const character = selectedCharacter();
      const enter = buttonNode('进入建筑', 'primary', 'enter-building', feature.id);
      enter.disabled = status === 'destroyed' || !character || character.location.type !== 'map';
      enter.title = !character
        ? '请先在角色面板选择角色'
        : character.location.type !== 'map' ? '角色需要先离开当前建筑' : '';
      actions.append(enter);
    }
    section.append(actions);
    panel.append(section);

    if (runtime.highlightedFeatureIds.size) {
      const highlightSection = createElement('div', 'section');
      highlightSection.append(createElement('h2', '', '当前高亮 · ' + runtime.highlightedFeatureIds.size));
      highlightSection.append(createElement('p', '', runtime.featureHighlightSource?.startsWith('event:')
        ? '来自场景记录，地图上已标出该次操作涉及的对象。'
        : '地图上已标出当前预览或选择涉及的对象。'));
      highlightSection.append(buttonNode('清除高亮', '', 'clear-feature-highlight'));
      panel.append(highlightSection);
    }
  }

  function renderMarkers() {
    const panel = elements.panels.markers;
    panel.replaceChildren();

    const createSection = createElement('div', 'section');
    createSection.append(createElement('h2', '', '放置标记'));
    createSection.append(createElement('p', '', '先选颜色，再在地图内点击。标记可拖动，名称和颜色可随时修改。'));
    const palette = createElement('div', 'palette');
    MARKER_COLORS.forEach(color => {
      const button = createElement('button', 'color-swatch' + (runtime.currentMarkerColor === color.value ? ' selected' : ''));
      button.type = 'button';
      button.title = color.name;
      button.setAttribute('aria-label', color.name);
      button.style.background = color.value;
      button.dataset.action = 'marker-color';
      button.dataset.color = color.value;
      palette.append(button);
    });
    createSection.append(palette);
    const markerButtons = createElement('div', 'button-row');
    markerButtons.append(buttonNode('启用标记工具', 'primary', 'tool-marker'));
    markerButtons.append(buttonNode('框选删除', '', 'tool-marker-select'));
    markerButtons.append(buttonNode('清空全部标记', 'danger', 'clear-markers'));
    createSection.append(markerButtons);
    panel.append(createSection);

    const listSection = createElement('div', 'section');
    const selectionCount = runtime.selectedMarkerIds.size;
    listSection.append(createElement('h2', '', '标记列表 · ' + state.markers.length + (selectionCount ? ' · 已框选 ' + selectionCount : '')));
    const list = createElement('div', 'item-list');
    if (!state.markers.length) {
      list.append(createElement('div', 'empty-state', '暂无标记'));
    } else {
      state.markers.forEach(marker => list.append(markerListItem(marker)));
    }
    listSection.append(list);
    panel.append(listSection);
  }

  function characterPortraitNode(character, size = '') {
    const portrait = createElement('span', 'character-portrait' + (size ? ' ' + size : ''));
    portrait.style.setProperty('--character-color', safeColor(character.color, '#3d9b63'));
    if (character.avatarDataUrl) {
      const image = document.createElement('img');
      image.src = character.avatarDataUrl;
      image.alt = '';
      portrait.append(image);
    } else {
      portrait.textContent = (character.name.trim()[0] || '?').toUpperCase();
    }
    return portrait;
  }

  function characterLocationLabel(character) {
    if (character.location.type === 'building') {
      return '位于：' + (featureById.get(character.location.featureId)?.name || character.location.featureId);
    }
    return 'x ' + character.location.x.toFixed(1) + ' · y ' + character.location.y.toFixed(1);
  }

  function renderCharacters() {
    const panel = elements.panels.characters;
    panel.replaceChildren();
    const createSection = createElement('div', 'section');
    createSection.append(createElement('h2', '', '角色'));
    const buttons = createElement('div', 'button-row');
    buttons.append(buttonNode('放置角色', 'primary', 'place-character'));
    const move = buttonNode('移动所选', '', 'tool-character-move');
    move.disabled = !selectedCharacter() || selectedCharacter().location.type !== 'map';
    buttons.append(move);
    createSection.append(buttons);
    panel.append(createSection);

    if (runtime.characterMovePreview) {
      const preview = createElement('div', 'section move-preview-card');
      const character = state.characters.find(item => item.id === runtime.characterMovePreview.characterId);
      preview.append(createElement('h2', '', runtime.characterMovePreview.calculating
        ? '正在计算路线'
        : runtime.characterMovePreview.committing ? '正在移动' : '移动预览'));
      preview.append(createElement('p', '', runtime.characterMovePreview.calculating
        ? '正在避开建筑、城墙、水域与弹坑。'
        : (character?.name || '角色') + ' · ' + formatDistance(runtime.characterMovePreview.distance)));
      if (!runtime.characterMovePreview.calculating && !runtime.characterMovePreview.committing) {
        const previewButtons = createElement('div', 'button-row');
        previewButtons.append(buttonNode('开始移动', 'primary', 'confirm-character-move'));
        previewButtons.append(buttonNode('取消', '', 'cancel-character-move'));
        preview.append(previewButtons);
      }
      panel.append(preview);
    }

    const selected = selectedCharacter();
    if (selected?.location.type === 'building') {
      const inside = createElement('div', 'section');
      inside.append(createElement('h2', '', '建筑内'));
      inside.append(createElement('p', '', characterLocationLabel(selected)));
      inside.append(buttonNode('离开建筑', 'primary', 'exit-building', selected.id));
      panel.append(inside);
    }

    const listSection = createElement('div', 'section');
    listSection.append(createElement('h2', '', '角色列表 · ' + state.characters.length));
    const list = createElement('div', 'item-list character-list');
    if (!state.characters.length) list.append(createElement('div', 'empty-state', '暂无角色'));
    state.characters.forEach(character => {
      const item = createElement('div', 'list-item character-list-item' + (runtime.selectedCharacterId === character.id ? ' selected' : ''));
      item.dataset.characterId = character.id;
      const main = createElement('button', 'item-main item-main-button');
      main.type = 'button';
      main.dataset.action = 'select-character';
      main.dataset.id = character.id;
      main.append(createElement('div', 'item-name', character.name), createElement('div', 'item-meta', characterLocationLabel(character)));
      const actions = createElement('div', 'item-actions');
      actions.append(iconButton('✎', '编辑角色', 'edit-character', character.id));
      actions.append(iconButton('⌖', '定位角色', 'focus-character', character.id));
      actions.append(iconButton('×', '删除角色', 'delete-character', character.id));
      item.append(characterPortraitNode(character, 'list'), main, actions);
      list.append(item);
    });
    listSection.append(list);
    panel.append(listSection);
  }

  function markerListItem(marker) {
    const selected = runtime.selectedMarkerId === marker.id || runtime.selectedMarkerIds.has(marker.id);
    const item = createElement('div', 'list-item' + (selected ? ' selected' : ''));
    item.dataset.markerId = marker.id;
    const dot = createElement('span', 'marker-dot');
    dot.style.background = marker.color;
    const main = createElement('div', 'item-main');
    main.dataset.action = 'select-marker';
    const name = createElement('div', 'item-name', marker.name);
    const tags = [];
    if (runtime.measureA === marker.id) tags.push('A');
    if (runtime.measureB === marker.id) tags.push('B');
    const meta = createElement(
      'div',
      'item-meta',
      'x ' + marker.x.toFixed(1) + ' · y ' + marker.y.toFixed(1) + (tags.length ? ' · ' + tags.join('/') : '')
    );
    main.append(name, meta);
    const actions = createElement('div', 'item-actions');
    actions.append(iconButton('✎', '编辑', 'edit-marker', marker.id));
    actions.append(iconButton('⌖', '定位', 'focus-marker', marker.id));
    actions.append(iconButton('×', '删除', 'delete-marker', marker.id));
    item.append(dot, main, actions);
    return item;
  }

  function renderMeasurement() {
    const panel = elements.panels.measure;
    panel.replaceChildren();
    const distanceSection = createElement('div', 'section');
    distanceSection.append(createElement('h2', '', '两点直线距离'));
    const card = createElement('div', 'distance-card');
    const markerA = state.markers.find(marker => marker.id === runtime.measureA);
    const markerB = state.markers.find(marker => marker.id === runtime.measureB);
    if (markerA && markerB) {
      const distance = distanceMeters(markerA, markerB);
      const wrap = createElement('div');
      wrap.append(createElement('div', '', markerA.name + ' ↔ ' + markerB.name));
      wrap.append(createElement('strong', '', formatDistance(distance)));
      card.append(wrap);
    } else {
      card.textContent = markerA ? '已选择 A：' + markerA.name + '，请选择 B' : '选择两个标记计算直线距离';
    }
    distanceSection.append(card);
    const distanceButtons = createElement('div', 'button-row');
    distanceButtons.append(buttonNode('启用两点测距', 'primary', 'tool-distance'));
    distanceButtons.append(buttonNode('清除 A/B', '', 'clear-distance'));
    distanceSection.append(distanceButtons);
    panel.append(distanceSection);

    const routeSection = createElement('div', 'section');
    routeSection.append(createElement('h2', '', '多点路线'));
    const summary = routeSegments(runtime.routePoints);
    const routeCard = createElement('div', 'distance-card');
    const routeWrap = createElement('div');
    routeWrap.append(createElement('div', '', runtime.routeFinished ? '路线已完成' : '点击地图依次添加路线节点'));
    routeWrap.append(createElement('strong', '', formatDistance(summary.total || 0)));
    routeCard.append(routeWrap);
    routeSection.append(routeCard);
    if (summary.segments?.length) {
      const segments = createElement('ol', 'route-segments');
      summary.segments.forEach((segment, index) => {
        segments.append(createElement('li', '', '第' + (index + 1) + '段 ' + formatDistance(segment.length)));
      });
      routeSection.append(segments);
    }
    const routeButtons = createElement('div', 'button-row');
    routeButtons.append(buttonNode('启用路线工具', 'primary', 'tool-route'));
    routeButtons.append(buttonNode('完成路线', '', 'finish-route'));
    routeButtons.append(buttonNode('撤销节点', '', 'undo-route'));
    routeButtons.append(buttonNode('清空路线', 'danger', 'clear-route'));
    routeSection.append(routeButtons);
    panel.append(routeSection);
  }

  function renderAreas() {
    const panel = elements.panels.areas;
    panel.replaceChildren();
    const selected = selectedArea();

    const createSection = createElement('div', 'section');
    createSection.append(createElement('h2', '', '范围攻击'));
    const shapeRow = createElement('div', 'button-row');
    [
      ['circle', '圆形'],
      ['sector', '扇形'],
      ['rectangle', '矩形']
    ].forEach(([shape, label]) => {
      const button = buttonNode(label, runtime.pendingShape === shape ? 'primary' : '', 'new-area');
      button.dataset.shape = shape;
      shapeRow.append(button);
    });
    createSection.append(createElement('p', '', '选择形状后，在底图或图外工作区点击放置中心/起点。'));
    createSection.append(shapeRow);
    panel.append(createSection);

    if (selected) panel.append(areaEditor(selected));

    const listSection = createElement('div', 'section');
    listSection.append(createElement('h2', '', '已保存范围 · ' + state.attackAreas.length));
    const list = createElement('div', 'item-list');
    if (!state.attackAreas.length) list.append(createElement('div', 'empty-state', '暂无攻击范围'));
    state.attackAreas.forEach(area => list.append(areaListItem(area)));
    listSection.append(list);
    panel.append(listSection);

    const destruction = createElement('div', 'section');
    destruction.append(createElement('h2', '', '场景破坏'));
    if (!mapPackage.features?.length) {
      destruction.append(createElement('p', '', '当前地图包未提供可破坏对象。'));
    } else if (!selected) {
      destruction.append(createElement('p', '', '请先选择一个攻击范围。'));
    } else {
      const enabled = checkChip('启用场景破坏', 'destructionEnabled', selected.destructionEnabled);
      enabled.querySelector('input').dataset.areaId = selected.id;
      destruction.append(enabled);
      const severe = checkChip('严重破坏（连基础地表一起破坏）', 'severeDamage', selected.severeDamage);
      severe.querySelector('input').dataset.areaId = selected.id;
      destruction.append(severe);
      const crater = checkChip('形成弹坑', 'craterEnabled', selected.craterEnabled);
      crater.querySelector('input').dataset.areaId = selected.id;
      destruction.append(crater);
      const grid = createElement('div', 'category-grid');
      const categories = mapPackage.destructibleCategories || [...new Set(mapPackage.features.map(feature => feature.category))];
      categories.forEach(category => {
        const checked = selected.destructionTargets?.includes(category);
        const chip = checkChip(CATEGORY_LABELS[category] || category, 'damage-category', checked);
        const input = chip.querySelector('input');
        input.value = category;
        input.dataset.areaId = selected.id;
        grid.append(chip);
      });
      destruction.append(grid);
      const actions = createElement('div', 'button-row');
      const previewButton = buttonNode('预览影响', '', 'preview-damage');
      const applyButton = buttonNode('应用破坏', 'danger', 'apply-damage');
      previewButton.disabled = !selected.destructionEnabled && !selected.craterEnabled;
      applyButton.disabled = (!selected.destructionEnabled && !selected.craterEnabled) || !runtime.damagePreview;
      actions.append(previewButton, applyButton);
      destruction.append(actions);
      if (runtime.damagePreview) {
        destruction.append(createElement('div', 'preview-summary', previewSummary(runtime.damagePreview)));
        destruction.append(previewTargetList(runtime.damagePreview));
      }
    }
    panel.append(destruction);

    const history = createElement('div', 'section');
    history.append(createElement('h2', '', '场景记录 · ' + state.sceneEvents.length));
    history.append(createElement('p', '', '撤销会删除最后一步记录；彻底重置会清空全部场景记录，且不可撤销。'));
    const historyButtons = createElement('div', 'button-row');
    const undoButton = buttonNode('撤销上一步', '', 'undo-scene');
    const resetButton = buttonNode('彻底重置', 'danger', 'reset-scene');
    undoButton.disabled = state.sceneEvents.length === 0;
    resetButton.disabled = state.sceneEvents.length === 0;
    historyButtons.append(undoButton, resetButton);
    history.append(historyButtons);
    const historyList = createElement('div', 'item-list');
    [...state.sceneEvents].reverse().slice(0, 12).forEach(event => {
      const selected = runtime.featureHighlightSource === 'event:' + event.id;
      const item = createElement('div', 'list-item' + (selected ? ' selected' : ''));
      const icon = createElement('span', 'marker-dot');
      icon.style.background = event.type === 'damage' ? '#a83232' : '#37734c';
      const main = createElement('button', 'item-main item-main-button');
      main.type = 'button';
      main.dataset.action = 'focus-event';
      main.dataset.id = event.id;
      const ids = featureIdsForEvent(event);
      const categorySummary = featureCategorySummary(ids);
      main.append(
        createElement('div', 'item-name', eventLabel(event)),
        createElement('div', 'item-meta', (categorySummary ? categorySummary + ' · ' : '') + new Date(event.createdAt || Date.now()).toLocaleString())
      );
      const actions = createElement('div', 'item-actions');
      if (event.type === 'damage' && ((event.objectIds?.length || 0) + (event.clipHits?.length || 0))) {
        const restore = iconButton('↥', '恢复本次对象', 'restore-event', event.id);
        actions.append(restore);
      }
      item.append(icon, main, actions);
      historyList.append(item);
    });
    if (!state.sceneEvents.length) historyList.append(createElement('div', 'empty-state', '场景完整，暂无破坏或恢复记录'));
    history.append(historyList);
    panel.append(history);
  }

  function areaEditor(area) {
    const section = createElement('div', 'section');
    section.append(createElement('h2', '', '编辑：' + area.name));
    const fields = createElement('div', 'field-grid');
    fields.append(fieldNode('名称', 'text', 'area-name', area.name, area.id, 'full'));
    fields.append(selectField('形状', 'area-shape', area.shape, [
      ['circle', '圆形'], ['sector', '扇形'], ['rectangle', '矩形']
    ], area.id));
    const anchorValue = area.anchor?.type === 'marker'
      ? 'marker:' + area.anchor.markerId
      : area.anchor?.type === 'character' ? 'character:' + area.anchor.characterId : '';
    fields.append(selectField('绑定对象', 'area-anchor', anchorValue, [
      ['', '自由放置'],
      ...state.markers.map(marker => ['marker:' + marker.id, '标记 · ' + marker.name]),
      ...state.characters.map(character => ['character:' + character.id, '角色 · ' + character.name])
    ], area.id));
    if (area.shape === 'circle') {
      fields.append(fieldNode('半径（米）', 'number', 'area-radius', area.radius, area.id));
    }
    if (area.shape === 'sector') {
      fields.append(fieldNode('距离（米）', 'number', 'area-range', area.range, area.id));
      fields.append(fieldNode('夹角（度）', 'number', 'area-angle', area.angleDeg, area.id));
      fields.append(fieldNode('朝向（度）', 'number', 'area-heading', area.headingDeg, area.id));
    }
    if (area.shape === 'rectangle') {
      fields.append(fieldNode('长度（米）', 'number', 'area-length', area.length, area.id));
      fields.append(fieldNode('宽度（米）', 'number', 'area-width', area.width, area.id));
      fields.append(fieldNode('朝向（度）', 'number', 'area-heading', area.headingDeg, area.id));
    }
    fields.append(fieldNode('透明度', 'range', 'area-opacity', area.opacity, area.id, '', { min: 0.05, max: 0.55, step: 0.01 }));
    section.append(fields);
    const palette = createElement('div', 'palette');
    AREA_COLORS.forEach(color => {
      const swatch = createElement('button', 'color-swatch' + (area.color === color ? ' selected' : ''));
      swatch.type = 'button';
      swatch.style.background = color;
      swatch.dataset.action = 'area-color';
      swatch.dataset.areaId = area.id;
      swatch.dataset.color = color;
      palette.append(swatch);
    });
    section.append(palette);
    const buttons = createElement('div', 'button-row');
    buttons.append(buttonNode(area.visible ? '隐藏' : '显示', '', 'toggle-area', area.id));
    buttons.append(buttonNode('复制', '', 'duplicate-area', area.id));
    buttons.append(buttonNode('重新放置', '', 'replace-area', area.id));
    buttons.append(buttonNode('删除', 'danger', 'delete-area', area.id));
    section.append(buttons);
    return section;
  }

  function areaListItem(area) {
    const item = createElement('div', 'list-item' + (runtime.selectedAreaId === area.id ? ' selected' : ''));
    item.dataset.areaId = area.id;
    const dot = createElement('span', 'marker-dot');
    dot.style.background = area.color;
    const main = createElement('div', 'item-main');
    main.dataset.action = 'select-area';
    const shapeLabel = area.shape === 'circle' ? '圆' : area.shape === 'sector' ? '扇形' : '矩形';
    const meta = createElement('div', 'item-meta', shapeLabel + ' · ' + areaDimensions(area) + (area.visible ? '' : ' · 已隐藏'));
    meta.dataset.areaSummaryId = area.id;
    main.append(createElement('div', 'item-name', area.name), meta);
    const actions = createElement('div', 'item-actions');
    actions.append(iconButton('⌖', '定位', 'focus-area', area.id));
    item.append(dot, main, actions);
    return item;
  }

  function renderLayers() {
    const panel = elements.panels.layers;
    panel.replaceChildren();
    const layersSection = createElement('div', 'section');
    layersSection.append(createElement('h2', '', '地图图层'));
    const layerList = createElement('div', 'item-list');
    layerList.append(checkChip('动态网格', 'gridVisible', runtime.gridVisible));
    layersSection.append(layerList);
    const snapValue = state.preferences.snapMeters === null ? 'free' : String(state.preferences.snapMeters ?? 5);
    const snap = selectField('网格吸附', 'snap-setting', snapValue, [
      ['1', '1米'], ['5', '5米（默认）'], ['10', '10米'], ['20', '20米'], ['free', '自由拖动']
    ]);
    layersSection.append(snap);
    layersSection.append(createElement('p', '', '吸附步长与当前显示网格相互独立；显示网格会随缩放自动切换 500 / 100 / 20 / 5 / 1 米。'));
    panel.append(layersSection);
  }

  function buttonNode(label, extraClass, action, id) {
    const button = createElement('button', 'small-button' + (extraClass ? ' ' + extraClass : ''), label);
    button.type = 'button';
    button.dataset.action = action;
    if (id) button.dataset.id = id;
    return button;
  }

  function iconButton(label, title, action, id) {
    const button = createElement('button', 'icon-button', label);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.dataset.action = action;
    button.dataset.id = id;
    return button;
  }

  function fieldNode(label, type, role, value, areaId, extraClass = '', options = {}) {
    const field = createElement('div', 'field' + (extraClass ? ' ' + extraClass : ''));
    const labelNode = createElement('label', '', label);
    const input = document.createElement('input');
    input.type = type;
    input.dataset.role = role;
    if (areaId) input.dataset.areaId = areaId;
    Object.entries(options).forEach(([key, optionValue]) => { input[key] = optionValue; });
    if (type === 'number') {
      const headingField = role === 'area-heading';
      const angleField = role === 'area-angle';
      input.min = headingField ? '0' : '1';
      input.max = headingField || angleField ? '359' : String(Math.max(mapPackage.width, mapPackage.height) * 4);
      input.step = '1';
    }
    input.value = value;
    field.append(labelNode, input);
    return field;
  }

  function selectField(label, role, value, options, areaId) {
    const field = createElement('div', 'field');
    const labelNode = createElement('label', '', label);
    const select = document.createElement('select');
    select.dataset.role = role;
    if (areaId) select.dataset.areaId = areaId;
    options.forEach(([optionValue, optionLabel]) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionLabel;
      option.selected = String(optionValue) === String(value);
      select.append(option);
    });
    field.append(labelNode, select);
    return field;
  }

  function checkChip(label, role, checked) {
    const chip = createElement('label', 'check-chip');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.dataset.role = role;
    chip.append(input, document.createTextNode(label));
    return chip;
  }

  function previewSummary(preview) {
    const counts = preview.counts || preview.hits?.reduce((acc, hit) => {
      acc[hit.category] = (acc[hit.category] || 0) + 1;
      return acc;
    }, {}) || {};
    const parts = Object.entries(counts).map(([category, count]) => (CATEGORY_LABELS[category] || category) + ' ' + count);
    if (preview.craterPolygon) parts.push('弹坑 1');
    if (preview.ejectedCharacterIds?.length) parts.push('疏散角色 ' + preview.ejectedCharacterIds.length);
    return parts.length ? '预计影响：' + parts.join('、') : '没有命中可破坏对象';
  }

  function previewTargetList(preview) {
    const wrap = createElement('div', 'preview-targets');
    const ids = featureIdsForEvent({
      type: 'damage',
      objectIds: preview.objectIds,
      clipHits: preview.clipHits
    });
    if (!ids.length) return wrap;
    wrap.append(createElement('div', 'preview-targets-title', '具体目标 · ' + ids.length));
    const list = createElement('div', 'preview-target-list');
    ids.map(id => featureById.get(id)).filter(Boolean).forEach(feature => {
      const button = createElement('button', 'preview-target-button');
      button.type = 'button';
      button.dataset.action = 'focus-preview-feature';
      button.dataset.id = feature.id;
      button.append(
        createElement('span', 'preview-target-name', feature.name || feature.id),
        createElement('span', 'preview-target-meta', CATEGORY_LABELS[feature.category] || feature.category)
      );
      list.append(button);
    });
    wrap.append(list);
    return wrap;
  }

  function featureCategorySummary(ids) {
    const counts = {};
    ids.forEach(id => {
      const category = featureById.get(id)?.category;
      if (category) counts[category] = (counts[category] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([category, count]) => (CATEGORY_LABELS[category] || category) + ' ' + count)
      .join('、');
  }

  function eventLabel(event) {
    if (event.type === 'restore') return '恢复对象 · ' + featureIdsForEvent(event).length;
    if (event.type === 'damage') return '范围破坏 · ' + featureIdsForEvent(event).length + ' 项';
    return '场景操作';
  }

  function areaDimensions(area) {
    if (area.shape === 'circle') return '半径 ' + formatDistance(area.radius);
    if (area.shape === 'sector') return formatDistance(area.range) + ' / ' + area.angleDeg + '°';
    return formatDistance(area.length) + ' × ' + formatDistance(area.width);
  }

  function selectedArea() {
    return state.attackAreas.find(area => area.id === runtime.selectedAreaId) || null;
  }

  function selectedCharacter() {
    return state.characters.find(character => character.id === runtime.selectedCharacterId) || null;
  }

  function charactersInBuilding(featureId) {
    return state.characters.filter(character => (
      character.location.type === 'building' && character.location.featureId === featureId
    ));
  }

  function characterWorldPosition(character) {
    if (character?.location?.type === 'map') {
      return { x: character.location.x, y: character.location.y };
    }
    if (character?.location?.type === 'building') {
      const feature = featureById.get(character.location.featureId);
      if (feature?.center) return { x: feature.center[0], y: feature.center[1] };
    }
    return null;
  }

  function selectedFeature() {
    return featureById.get(runtime.selectedFeatureId) || null;
  }

  function pruneFeatureHighlights() {
    if (runtime.selectedFeatureId && !featureById.has(runtime.selectedFeatureId)) {
      runtime.selectedFeatureId = null;
    }
    runtime.highlightedFeatureIds = new Set(
      [...runtime.highlightedFeatureIds].filter(id => featureById.has(id))
    );
    if (runtime.featureHighlightSource?.startsWith('event:')) {
      const eventId = runtime.featureHighlightSource.slice('event:'.length);
      if (!state.sceneEvents.some(event => event.id === eventId)) {
        runtime.highlightedFeatureIds.clear();
        runtime.featureHighlightSource = null;
      }
    } else if (runtime.featureHighlightSource === 'preview' && !runtime.damagePreview) {
      runtime.highlightedFeatureIds.clear();
      runtime.featureHighlightSource = null;
    }
  }

  function clearFeatureHighlight(render = true) {
    runtime.highlightedFeatureIds.clear();
    runtime.featureHighlightSource = null;
    if (render) {
      renderInspection();
      renderAreas();
      renderScene();
    }
  }

  function selectFeature(id, options = {}) {
    const feature = featureById.get(id);
    if (!feature) return false;
    runtime.selectedFeatureId = id;
    if (options.clearHighlight !== false) {
      runtime.highlightedFeatureIds.clear();
      runtime.featureHighlightSource = null;
    }
    if (options.switchTab !== false) setTab('inspect');
    if (options.focus) focusFeatureIds([id]);
    renderInspection();
    renderAreas();
    renderScene();
    emit('feature:select', { id });
    return true;
  }

  function selectFeatureAtPoint(point) {
    const feature = inspectableFeaturesAtPoint(point, mapPackage.features || [])[0];
    if (!feature) {
      runtime.selectedFeatureId = null;
      clearFeatureHighlight(false);
      renderInspection();
      renderAreas();
      renderScene();
      showToast('当前位置没有可检查地物');
      return false;
    }
    selectFeature(feature.id);
    setStatus('已选中：' + (feature.name || feature.id) + ' · 可在右侧定位或恢复');
    return true;
  }

  function focusFeatureIds(ids) {
    const bounds = featureBounds(ids, mapPackage.features || []);
    if (!bounds) return false;
    const latLngBounds = L.latLngBounds(
      worldToLatLng({ x: bounds.minX, y: bounds.minY }, mapPackage.height),
      worldToLatLng({ x: bounds.maxX, y: bounds.maxY }, mapPackage.height)
    );
    map.fitBounds(latLngBounds, { padding: [64, 64], maxZoom: 2.5, animate: true });
    return true;
  }

  function focusSceneEvent(id) {
    const event = state.sceneEvents.find(item => item.id === id);
    if (!event) return false;
    if (runtime.featureHighlightSource === 'event:' + id) {
      clearFeatureHighlight();
      return true;
    }
    const ids = featureIdsForEvent(event).filter(featureId => featureById.has(featureId));
    runtime.highlightedFeatureIds = new Set(ids);
    runtime.featureHighlightSource = 'event:' + id;
    if (ids.length === 1) runtime.selectedFeatureId = ids[0];
    renderInspection();
    renderAreas();
    renderScene();
    if (ids.length) focusFeatureIds(ids);
    else showToast('这条记录没有可定位对象');
    return true;
  }

  function focusPreviewFeature(id) {
    if (!runtime.damagePreview || !featureById.has(id)) return false;
    runtime.selectedFeatureId = id;
    runtime.highlightedFeatureIds = new Set([id]);
    runtime.featureHighlightSource = 'preview';
    renderInspection();
    renderAreas();
    renderScene();
    focusFeatureIds([id]);
    return true;
  }

  function invalidateDamagePreview() {
    if (!runtime.damagePreview) return;
    runtime.damagePreview = null;
    const applyButton = container.querySelector('[data-action="apply-damage"]');
    if (applyButton) applyButton.disabled = true;
    const summary = container.querySelector('.preview-summary');
    if (summary) summary.textContent = '参数已变化，请重新预览影响';
  }

  function bindUi() {
    container.addEventListener('click', handleClick);
    container.addEventListener('change', handleChange);
    container.addEventListener('input', handleInput);
    elements.map.addEventListener('pointerdown', handleMarkerSelectionPointerDown, true);
    elements.map.addEventListener('pointermove', handleMarkerSelectionPointerMove, true);
    elements.map.addEventListener('pointerup', handleMarkerSelectionPointerUp, true);
    elements.map.addEventListener('pointercancel', handleMarkerSelectionPointerCancel, true);
    elements.importFile.addEventListener('change', handleImportFile);
    document.addEventListener('keydown', handleKeydown);
  }

  function markerSelectionWorldPoint(event) {
    const bounds = elements.map.getBoundingClientRect();
    const point = L.point(
      clamp(event.clientX - bounds.left, 0, bounds.width),
      clamp(event.clientY - bounds.top, 0, bounds.height)
    );
    return latLngToWorld(map.containerPointToLatLng(point), mapPackage.height);
  }

  function drawMarkerSelection(start, end) {
    layers.markerSelection.clearLayers();
    L.rectangle(L.latLngBounds(
      worldToLatLng(start, mapPackage.height),
      worldToLatLng(end, mapPackage.height)
    ), {
      pane: 'selectionPane',
      interactive: false,
      color: '#b52f2a',
      weight: 2,
      dashArray: '9 6',
      fillColor: '#e17a45',
      fillOpacity: 0.12,
      className: 'marker-selection-box'
    }).addTo(layers.markerSelection);
  }

  function stopMarkerSelectionPointer(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function handleMarkerSelectionPointerDown(event) {
    if (runtime.tool !== 'marker-select' || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('.leaflet-control')) return;
    stopMarkerSelectionPointer(event);
    clearMarkerSelection(false);
    runtime.selectedMarkerId = null;
    runtime.selectedCharacterId = null;
    runtime.characterMovePreview = null;
    const start = markerSelectionWorldPoint(event);
    runtime.markerSelectionDrag = {
      pointerId: event.pointerId,
      start,
      end: start,
      startClientX: event.clientX,
      startClientY: event.clientY
    };
    elements.map.setPointerCapture?.(event.pointerId);
    drawMarkerSelection(start, start);
    setStatus('框选标记：拖动矩形选择玩家标记');
    renderMarkers();
    renderMarkerLayers();
  }

  function handleMarkerSelectionPointerMove(event) {
    const drag = runtime.markerSelectionDrag;
    if (runtime.tool !== 'marker-select' || !drag || drag.pointerId !== event.pointerId) return;
    stopMarkerSelectionPointer(event);
    drag.end = markerSelectionWorldPoint(event);
    drawMarkerSelection(drag.start, drag.end);
  }

  function handleMarkerSelectionPointerUp(event) {
    const drag = runtime.markerSelectionDrag;
    if (runtime.tool !== 'marker-select' || !drag || drag.pointerId !== event.pointerId) return;
    stopMarkerSelectionPointer(event);
    drag.end = markerSelectionWorldPoint(event);
    if (elements.map.hasPointerCapture?.(event.pointerId)) elements.map.releasePointerCapture(event.pointerId);
    runtime.markerSelectionDrag = null;
    const dragPixels = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY);
    if (dragPixels < 4) {
      clearMarkerSelection();
      setStatus('框选标记：请拖出矩形；Esc 取消');
      return;
    }
    const selectedIds = markerIdsInBounds(state.markers, drag.start, drag.end);
    runtime.selectedMarkerIds = new Set(selectedIds);
    drawMarkerSelection(drag.start, drag.end);
    renderMarkers();
    renderMarkerLayers();
    setStatus(selectedIds.length
      ? '已框选 ' + selectedIds.length + ' 个玩家标记，按 Delete 删除；Esc 取消'
      : '框内没有玩家标记；继续拖动可重新框选，Esc 取消');
  }

  function handleMarkerSelectionPointerCancel(event) {
    const drag = runtime.markerSelectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    stopMarkerSelectionPointer(event);
    clearMarkerSelection();
    setStatus('框选标记：请拖出矩形；Esc 取消');
  }

  function clearMarkerSelection(render = true) {
    const pointerId = runtime.markerSelectionDrag?.pointerId;
    if (pointerId !== undefined && elements.map.hasPointerCapture?.(pointerId)) {
      elements.map.releasePointerCapture(pointerId);
    }
    runtime.markerSelectionDrag = null;
    runtime.selectedMarkerIds.clear();
    layers.markerSelection.clearLayers();
    if (render) {
      renderMarkers();
      renderMarkerLayers();
    }
  }

  function handleClick(event) {
    const button = event.target.closest('[data-action],[data-tool],[data-tab]');
    if (!button || !container.contains(button)) return;
    if (button.dataset.tool) {
      setTool(button.dataset.tool);
      return;
    }
    if (button.dataset.tab) {
      setTab(button.dataset.tab);
      return;
    }
    const action = button.dataset.action;
    const id = button.dataset.id || button.dataset.markerId || button.dataset.areaId;
    if (action === 'reset-view') fitInitialView();
    else if (action === 'focus-selected') focusSelected();
    else if (action === 'export') downloadSave();
    else if (action === 'import') elements.importFile.click();
    else if (action === 'marker-color') {
      runtime.currentMarkerColor = button.dataset.color;
      renderMarkers();
    } else if (action === 'tool-marker') setTool('marker');
    else if (action === 'tool-marker-select') setTool('marker-select');
    else if (action === 'tool-inspect') setTool('inspect');
    else if (action === 'tool-character-move') setTool('character-move');
    else if (action === 'place-character') setTool('character-place');
    else if (action === 'select-character') selectCharacter(id);
    else if (action === 'focus-character') focusCharacter(id);
    else if (action === 'edit-character') openCharacterEditor(id);
    else if (action === 'delete-character') deleteCharacter(id);
    else if (action === 'confirm-character-move') commitCharacterMove();
    else if (action === 'cancel-character-move') cancelCharacterMove();
    else if (action === 'enter-building') enterBuilding(runtime.selectedCharacterId, id);
    else if (action === 'exit-building') exitBuilding(id);
    else if (action === 'tool-distance') setTool('distance');
    else if (action === 'tool-route') setTool('route');
    else if (action === 'select-marker') {
      clearMarkerSelection(false);
      runtime.selectedMarkerId = button.closest('[data-marker-id]')?.dataset.markerId;
      renderMarkers();
      renderMarkerLayers();
    } else if (action === 'focus-marker') focusMarker(id);
    else if (action === 'edit-marker') openMarkerEditor(id);
    else if (action === 'delete-marker') deleteMarker(id);
    else if (action === 'undo-marker') undoDeletedMarker();
    else if (action === 'clear-markers') confirmClearMarkers();
    else if (action === 'clear-distance') clearDistance();
    else if (action === 'finish-route') {
      runtime.routeFinished = true;
      renderMeasurement();
      renderRouteLayers();
    } else if (action === 'undo-route') {
      runtime.routePoints.pop();
      runtime.routeFinished = false;
      renderMeasurement();
      renderRouteLayers();
    } else if (action === 'clear-route') clearRoute();
    else if (action === 'new-area') startAreaPlacement(button.dataset.shape);
    else if (action === 'select-area') {
      runtime.selectedAreaId = button.closest('[data-area-id]')?.dataset.areaId;
      runtime.damagePreview = null;
      renderAreas();
      renderAreaLayers();
      renderScene();
    } else if (action === 'area-color') updateArea(button.dataset.areaId, { color: button.dataset.color });
    else if (action === 'toggle-area') {
      const area = state.attackAreas.find(item => item.id === id);
      if (area) updateArea(id, { visible: !area.visible });
    } else if (action === 'duplicate-area') duplicateArea(id);
    else if (action === 'replace-area') {
      runtime.selectedAreaId = id;
      runtime.placingArea = true;
      setTool('aoe');
      setStatus('重新放置：在地图或图外工作区点击新的起点');
    } else if (action === 'delete-area') deleteArea(id);
    else if (action === 'focus-area') focusArea(id);
    else if (action === 'preview-damage') previewDamage();
    else if (action === 'apply-damage') applyDamage();
    else if (action === 'undo-scene') undoScene();
    else if (action === 'reset-scene') resetScene();
    else if (action === 'restore-event') restoreEvent(id);
    else if (action === 'focus-event') focusSceneEvent(id);
    else if (action === 'focus-preview-feature') focusPreviewFeature(id);
    else if (action === 'focus-feature') focusFeatureIds([id]);
    else if (action === 'restore-feature') {
      if (restoreFeatures([id])) showToast('所选对象已恢复，可撤销恢复使破坏重新出现', 'success');
      else showToast('所选对象当前已经完整');
    } else if (action === 'clear-feature-highlight') clearFeatureHighlight();
  }

  function handleChange(event) {
    const target = event.target;
    const role = target.dataset.role;
    const areaId = target.dataset.areaId;
    if (role === 'gridVisible') {
      runtime.gridVisible = target.checked;
      state.preferences.gridVisible = target.checked;
      updateGrid();
      scheduleSave();
    } else if (role === 'snap-setting') {
      state.preferences.snapMeters = target.value === 'free' ? null : Number(target.value);
      scheduleSave();
    } else if (role === 'severeDamage') {
      updateArea(areaId, {
        severeDamage: target.checked,
        ...(target.checked ? { craterEnabled: true } : {})
      });
      runtime.damagePreview = null;
      renderAreas();
    } else if (role === 'craterEnabled') {
      updateArea(areaId, { craterEnabled: target.checked });
      runtime.damagePreview = null;
      renderAreas();
    } else if (role === 'area-shape') {
      updateArea(areaId, { shape: target.value });
    } else if (role === 'area-anchor') {
      const area = state.attackAreas.find(item => item.id === areaId);
      if (!area) return;
      if (target.value) {
        const separator = target.value.indexOf(':');
        const type = target.value.slice(0, separator);
        const targetId = target.value.slice(separator + 1);
        if (type === 'marker') {
          const marker = state.markers.find(item => item.id === targetId);
          updateArea(areaId, {
            anchor: { type: 'marker', markerId: targetId },
            origin: marker ? { x: marker.x, y: marker.y } : area.origin
          });
        } else if (type === 'character') {
          const character = state.characters.find(item => item.id === targetId);
          updateArea(areaId, {
            anchor: { type: 'character', characterId: targetId },
            origin: characterWorldPosition(character) || area.origin
          });
        }
      } else {
        updateArea(areaId, {
          anchor: { type: 'free', markerId: null },
          origin: resolveAreaOrigin(area, state, mapPackage)
        });
      }
    } else if (role === 'destructionEnabled') {
      updateArea(areaId, { destructionEnabled: target.checked }, false);
      runtime.damagePreview = null;
      renderAreas();
      renderScene();
    } else if (role === 'damage-category') {
      const area = state.attackAreas.find(item => item.id === areaId);
      if (!area) return;
      const next = new Set(area.destructionTargets || []);
      if (target.checked) next.add(target.value); else next.delete(target.value);
      updateArea(areaId, { destructionTargets: [...next] }, false);
      runtime.damagePreview = null;
      renderAreas();
      renderScene();
    }
  }

  function handleInput(event) {
    const target = event.target;
    const role = target.dataset.role;
    const areaId = target.dataset.areaId;
    if (!role?.startsWith('area-') || !areaId) return;
    if (role === 'area-name') {
      updateArea(areaId, { name: target.value.slice(0, 80) }, false, false);
      return;
    }
    if (role === 'area-opacity') {
      updateArea(areaId, { opacity: clamp(Number(target.value), 0.05, 0.55) }, false, false);
      return;
    }
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    const max = Math.max(mapPackage.width, mapPackage.height) * 4;
    const patches = {
      'area-radius': { radius: clamp(value, 1, max) },
      'area-range': { range: clamp(value, 1, max) },
      'area-angle': { angleDeg: clamp(value, 1, 359) },
      'area-length': { length: clamp(value, 1, max) },
      'area-width': { width: clamp(value, 1, max) },
      'area-heading': { headingDeg: normalizeHeading(value) }
    };
    if (patches[role]) updateArea(areaId, patches[role], false);
  }

  function handleKeydown(event) {
    if (isEditableTarget(event.target)) return;
    if (elements.modalRoot.firstElementChild) return;
    if (event.key === 'Escape') {
      runtime.placingArea = false;
      runtime.damagePreview = null;
      if (runtime.characterMovePreview) cancelCharacterMove();
      if (runtime.tool === 'distance') clearDistance();
      else setTool('pan');
    } else if (event.key === 'Delete' && runtime.tool === 'marker-select') {
      if (!runtime.selectedMarkerIds.size) return;
      event.preventDefault();
      deleteMarkers([...runtime.selectedMarkerIds]);
    } else if (event.key === 'Enter' && runtime.tool === 'route') {
      runtime.routeFinished = true;
      renderMeasurement();
      renderRouteLayers();
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && runtime.tool === 'route') {
      event.preventDefault();
      runtime.routePoints.pop();
      runtime.routeFinished = false;
      renderMeasurement();
      renderRouteLayers();
    } else if (event.key.toLowerCase() === 'r') {
      fitInitialView();
    }
  }

  function setTab(tab) {
    runtime.activeTab = tab;
    container.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node.dataset.tab === tab));
    container.querySelectorAll('[data-panel]').forEach(node => node.classList.toggle('active', node.dataset.panel === tab));
  }

  function syncToolUi() {
    container.querySelectorAll('[data-tool]').forEach(node => node.classList.toggle('active', node.dataset.tool === runtime.tool));
    elements.map.style.cursor = runtime.tool === 'pan'
      ? 'grab'
      : (runtime.tool === 'marker' || runtime.tool === 'marker-select' || runtime.tool === 'inspect'
          || runtime.tool === 'character-place' || runtime.tool === 'character-move')
        ? 'crosshair'
        : 'cell';
  }

  function setTool(tool) {
    if (runtime.tool === 'marker-select' && tool !== 'marker-select') clearMarkerSelection(false);
    runtime.tool = tool;
    if (tool === 'marker' || tool === 'marker-select') setTab('markers');
    if (tool === 'character-place' || tool === 'character-move') setTab('characters');
    if (tool === 'inspect') setTab('inspect');
    if (tool === 'distance' || tool === 'route') setTab('measure');
    if (tool === 'route' && runtime.routeFinished) runtime.routeFinished = false;
    if (tool === 'aoe') setTab('areas');
    if (tool !== 'aoe') runtime.placingArea = false;
    if (tool === 'marker-select') {
      map.dragging.disable();
      map.boxZoom.disable();
    } else {
      map.dragging.enable();
      map.boxZoom.enable();
    }
    const messages = {
      pan: '浏览模式：拖动地图，滚轮无损缩放',
      marker: '标记模式：在底图内点击放置标记',
      'marker-select': '框选标记：拖出矩形后按 Delete 删除；Esc 取消',
      inspect: '检查地物：点击建筑、城墙、城门、树木或桥梁',
      'character-place': '放置角色：在底图可行走位置点击',
      'character-move': selectedCharacter()
        ? '移动角色：点击目的地预览道路优先路线'
        : '移动角色：请先在角色面板选择角色',
      distance: '两点测距：依次点击两个标记',
      route: '路线测距：在底图内点击添加节点，双击或 Enter 完成',
      aoe: runtime.placingArea ? '范围攻击：点击地图放置起点' : '范围攻击：选择已有范围，或点击形状按钮新建'
    };
    setStatus(messages[tool]);
    syncToolUi();
    renderMarkerLayers();
  }

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function showToast(message, type = '') {
    const toast = createElement('div', 'toast' + (type ? ' ' + type : ''), message);
    elements.toasts.append(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function confirmDialog(title, message, confirmLabel = '确认') {
    return new Promise(resolve => {
      const backdrop = createElement('div', 'modal-backdrop');
      const modal = createElement('div', 'modal');
      modal.append(createElement('h2', '', title), createElement('p', '', message));
      const buttons = createElement('div', 'button-row');
      const cancel = buttonNode('取消', '', 'modal-cancel');
      const confirm = buttonNode(confirmLabel, 'danger', 'modal-confirm');
      buttons.append(cancel, confirm);
      modal.append(buttons);
      backdrop.append(modal);
      elements.modalRoot.replaceChildren(backdrop);
      const finish = value => { elements.modalRoot.replaceChildren(); resolve(value); };
      cancel.addEventListener('click', () => finish(false));
      confirm.addEventListener('click', () => finish(true));
      backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(false); });
    });
  }

  function bindMap() {
    map.on('click', event => {
      const point = latLngToWorld(event.latlng, mapPackage.height);
      if (runtime.tool === 'pan') {
        const building = inspectableFeaturesAtPoint(point, mapPackage.features || [])
          .find(feature => feature.category === 'building');
        if (building) selectFeature(building.id);
        return;
      }
      if (runtime.tool === 'inspect') {
        if (!worldInside(point, mapPackage)) {
          showToast('地物检查仅适用于底图范围');
          return;
        }
        selectFeatureAtPoint(point);
        return;
      }
      if (runtime.tool === 'marker') {
        if (!worldInside(point, mapPackage)) {
          showToast('普通标记只能放在底图范围内', 'error');
          return;
        }
        const snapped = clampWorld(snapForPreference(point));
        const marker = {
          id: uid('marker'),
          name: '标记 ' + (state.markers.length + 1),
          color: runtime.currentMarkerColor,
          x: snapped.x,
          y: snapped.y
        };
        state.markers.push(marker);
        runtime.selectedMarkerId = marker.id;
        scheduleSave();
        renderMarkers();
        renderMarkerLayers();
        emit('marker:create', structuredClone(marker));
        return;
      }
      if (runtime.tool === 'character-place') {
        if (!worldInside(point, mapPackage)) {
          showToast('角色只能放在底图范围内', 'error');
          return;
        }
        placeCharacter(point);
        return;
      }
      if (runtime.tool === 'character-move') {
        if (!worldInside(point, mapPackage)) {
          showToast('移动目标必须位于底图范围内', 'error');
          return;
        }
        planCharacterMove(runtime.selectedCharacterId, point);
        return;
      }
      if (runtime.tool === 'route') {
        if (event.originalEvent?.detail > 1 || runtime.routeFinished) return;
        if (!worldInside(point, mapPackage)) {
          showToast('路线节点只能放在底图范围内', 'error');
          return;
        }
        runtime.routePoints.push(snapRoutePoint(point));
        renderMeasurement();
        renderRouteLayers();
        return;
      }
      if (runtime.tool === 'aoe' && runtime.placingArea) {
        placeAttackArea(snapForPreference(point));
      }
    });
    map.on('dblclick', event => {
      if (runtime.tool !== 'route') return;
      L.DomEvent.stop(event);
      runtime.routeFinished = true;
      renderMeasurement();
      renderRouteLayers();
    });
    map.on('zoomend moveend resize', () => {
      updateGrid();
      updateScale();
      mapPresentation.schedule();
    });
    map.on('move', () => {
      if (gridFrame) return;
      gridFrame = requestAnimationFrame(() => {
        gridFrame = null;
        updateGrid();
      });
    });
    map.on('mousemove', event => {
      const point = latLngToWorld(event.latlng, mapPackage.height);
      const label = runtime.tool === 'pan' ? '浏览模式：拖动地图，滚轮无损缩放' : elements.status.textContent.split(' · x ')[0];
      elements.status.textContent = label + ' · x ' + point.x.toFixed(1) + '，y ' + point.y.toFixed(1);
    });
  }

  function clampWorld(point) {
    return {
      x: clamp(point.x, 0, mapPackage.width),
      y: clamp(point.y, 0, mapPackage.height)
    };
  }

  function snapForPreference(point) {
    const step = state.preferences.snapMeters === undefined ? 5 : (state.preferences.snapMeters === null ? 'free' : state.preferences.snapMeters);
    return snapPoint(point, step);
  }

  function snapRoutePoint(point) {
    const clickPixel = map.latLngToContainerPoint(worldToLatLng(point, mapPackage.height));
    let nearest = null;
    let nearestDistance = 15;
    for (const marker of state.markers) {
      const markerPixel = map.latLngToContainerPoint(worldToLatLng(marker, mapPackage.height));
      const pixels = clickPixel.distanceTo(markerPixel);
      if (pixels <= nearestDistance) {
        nearestDistance = pixels;
        nearest = marker;
      }
    }
    if (nearest) return { x: nearest.x, y: nearest.y, markerId: nearest.id };
    return clampWorld(snapForPreference(point));
  }

  function safeColor(value, fallback = '#3c7ec9') {
    return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : fallback;
  }

  function markerIcon(marker) {
    const selected = runtime.selectedMarkerId === marker.id || runtime.selectedMarkerIds.has(marker.id);
    const labels = [];
    if (runtime.measureA === marker.id) labels.push('A');
    if (runtime.measureB === marker.id) labels.push('B');
    const html = '<div class="rpg-marker-core' + (selected ? ' selected' : '') + '" style="--marker-color:' + safeColor(marker.color) + '"></div>' +
      (labels.length ? '<div class="rpg-marker-label">' + labels.join('/') + '</div>' : '');
    return L.divIcon({ className: 'rpg-marker', html, iconSize: [24, 24], iconAnchor: [12, 12] });
  }

  function markerTooltip(marker) {
    const node = createElement('span');
    node.textContent = marker.name;
    return node;
  }

  function renderMarkerLayers() {
    const validIds = new Set(state.markers.map(marker => marker.id));
    for (const [id, view] of markerViews) {
      if (!validIds.has(id)) {
        layers.markers.removeLayer(view);
        markerViews.delete(id);
      }
    }
    for (const marker of state.markers) {
      let view = markerViews.get(marker.id);
      if (!view) {
        view = L.marker(worldToLatLng(marker, mapPackage.height), {
          icon: markerIcon(marker),
          draggable: true,
          keyboard: true,
          pane: 'markerPane',
          title: marker.name
        }).addTo(layers.markers);
        view.bindTooltip(markerTooltip(marker), {
          permanent: true,
          direction: 'bottom',
          offset: [0, 8],
          className: 'marker-tooltip'
        });
        view.on('click', event => {
          L.DomEvent.stopPropagation(event);
          const current = state.markers.find(item => item.id === marker.id);
          if (!current) return;
          if (runtime.tool === 'distance') {
            selectDistanceMarker(current.id);
          } else if (runtime.tool === 'route') {
            if (!runtime.routeFinished && event.originalEvent?.detail <= 1) {
              runtime.routePoints.push({ x: current.x, y: current.y, markerId: current.id });
              renderMeasurement();
              renderRouteLayers();
            }
          } else if (runtime.tool === 'marker-select') {
            return;
          } else {
            clearMarkerSelection(false);
            runtime.selectedMarkerId = current.id;
            renderMarkers();
            renderMarkerLayers();
          }
        });
        view.on('dblclick', event => {
          if (runtime.tool !== 'route') return;
          L.DomEvent.stopPropagation(event);
          runtime.routeFinished = true;
          renderMeasurement();
          renderRouteLayers();
        });
        view.on('drag', () => {
          const current = state.markers.find(item => item.id === marker.id);
          if (!current) return;
          const point = clampWorld(latLngToWorld(view.getLatLng(), mapPackage.height));
          current.x = point.x;
          current.y = point.y;
          const followed = followBoundAreas(current.id);
          followed.forEach(refreshAreaGeometry);
          if (runtime.routePoints.some(point => point.markerId === current.id)) renderRouteLayers();
          renderMeasurement();
          renderMeasurementLayers();
        });
        view.on('dragend', () => {
          const current = state.markers.find(item => item.id === marker.id);
          if (!current) return;
          const point = clampWorld(snapForPreference(latLngToWorld(view.getLatLng(), mapPackage.height)));
          current.x = point.x;
          current.y = point.y;
          view.setLatLng(worldToLatLng(current, mapPackage.height));
          followBoundAreas(current.id);
          scheduleSave();
          renderMarkers();
          renderMarkerLayers();
          renderAreaLayers();
          renderMeasurement();
          renderMeasurementLayers();
          emit('marker:move', structuredClone(current));
        });
        markerViews.set(marker.id, view);
      }
      view.setLatLng(worldToLatLng(marker, mapPackage.height));
      view.setIcon(markerIcon(marker));
      if (view.dragging) {
        if (runtime.tool === 'marker-select') view.dragging.disable();
        else view.dragging.enable();
      }
      view.options.title = marker.name;
      const tooltip = view.getTooltip();
      if (tooltip) tooltip.setContent(markerTooltip(marker));
    }
  }

  function invalidateNavigation() {
    runtime.navigationGrid = null;
    runtime.navigationRevision = null;
    runtime.characterMoveRequest += 1;
  }

  function ensureNavigationGrid() {
    const revision = state.sceneEvents.map(event => event.id).join('|');
    runtime.navigationBase ||= createNavigationBase(mapPackage);
    if (!runtime.navigationGrid || runtime.navigationRevision !== revision) {
      runtime.navigationGrid = createNavigationGrid(
        mapPackage,
        deriveSceneState(state.sceneEvents),
        runtime.navigationBase
      );
      runtime.navigationRevision = revision;
    }
    return runtime.navigationGrid;
  }

  function placeCharacter(point) {
    const navigation = ensureNavigationGrid();
    const safePoint = nearestWalkablePoint(navigation, point, 30);
    if (!safePoint) {
      showToast('附近没有可放置角色的安全位置', 'error');
      return false;
    }
    const character = {
      id: uid('character'),
      name: '角色 ' + (state.characters.length + 1),
      color: runtime.currentCharacterColor,
      avatarDataUrl: null,
      visible: true,
      location: { type: 'map', x: safePoint.x, y: safePoint.y }
    };
    state.characters.push(character);
    runtime.selectedCharacterId = character.id;
    scheduleSave();
    setTool('character-move');
    renderCharacters();
    renderCharacterLayers();
    openCharacterEditor(character.id);
    emit('character:create', structuredClone(character));
    return true;
  }

  function selectCharacter(id) {
    const character = state.characters.find(item => item.id === id);
    if (!character) return false;
    runtime.selectedCharacterId = id;
    setTab('characters');
    renderCharacters();
    renderCharacterLayers();
    renderInspection();
    emit('character:select', { id });
    return true;
  }

  function focusCharacter(id) {
    const character = state.characters.find(item => item.id === id);
    if (!character) return false;
    selectCharacter(id);
    if (character.location.type === 'building') return focusFeatureIds([character.location.featureId]);
    map.flyTo(
      worldToLatLng(character.location, mapPackage.height),
      Math.max(map.getZoom(), 0.75),
      { duration: 0.45 }
    );
    return true;
  }

  async function processAvatarFile(file) {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      throw new Error('头像仅支持 PNG、JPEG 或 WebP');
    }
    if (file.size > MAX_SAVE_FILE_BYTES) throw new Error('头像源文件超过 5 MB 上限');
    const bitmap = globalThis.createImageBitmap
      ? await createImageBitmap(file)
      : await new Promise((resolve, reject) => {
          const image = new Image();
          const url = URL.createObjectURL(file);
          image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
          image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('头像图片无法读取')); };
          image.src = url;
        });
    const size = Math.min(bitmap.width, bitmap.height);
    const sourceX = (bitmap.width - size) / 2;
    const sourceY = (bitmap.height - size) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d', { alpha: true });
    context.drawImage(bitmap, sourceX, sourceY, size, size, 0, 0, 128, 128);
    bitmap.close?.();
    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/webp', quality);
    const bytes = value => Math.floor(value.slice(value.indexOf(',') + 1).length * 3 / 4);
    while (bytes(dataUrl) > 96 * 1024 && quality > 0.5) {
      quality -= 0.08;
      dataUrl = canvas.toDataURL('image/webp', quality);
    }
    if (!dataUrl.startsWith('data:image/webp;base64,') || bytes(dataUrl) > 96 * 1024) {
      throw new Error('头像压缩后仍超过 96 KB');
    }
    return dataUrl;
  }

  function openCharacterEditor(id) {
    const character = state.characters.find(item => item.id === id);
    if (!character) return;
    const backdrop = createElement('div', 'modal-backdrop');
    const modal = createElement('div', 'modal character-modal');
    modal.append(createElement('h2', '', '编辑角色'));
    let preview = characterPortraitNode(character, 'editor');
    modal.append(preview);
    const nameField = createElement('div', 'field');
    const nameLabel = createElement('label', '', '名称');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.value = character.name;
    nameField.append(nameLabel, nameInput);
    modal.append(nameField);
    const avatarField = createElement('div', 'field');
    avatarField.append(createElement('label', '', '圆形头像'));
    const avatarInput = document.createElement('input');
    avatarInput.type = 'file';
    avatarInput.accept = 'image/png,image/jpeg,image/webp';
    avatarField.append(avatarInput);
    modal.append(avatarField);
    let nextAvatar = character.avatarDataUrl;
    avatarInput.addEventListener('change', async () => {
      try {
        nextAvatar = await processAvatarFile(avatarInput.files?.[0]);
        const draft = { ...character, name: nameInput.value || character.name, avatarDataUrl: nextAvatar };
        const nextPreview = characterPortraitNode(draft, 'editor');
        preview.replaceWith(nextPreview);
        preview = nextPreview;
        removeAvatar.disabled = false;
      } catch (error) {
        showToast(error.message, 'error');
        avatarInput.value = '';
      }
    });
    const palette = createElement('div', 'palette');
    let nextColor = character.color;
    MARKER_COLORS.forEach(color => {
      const swatch = createElement('button', 'color-swatch' + (character.color === color.value ? ' selected' : ''));
      swatch.type = 'button';
      swatch.title = color.name;
      swatch.style.background = color.value;
      swatch.addEventListener('click', () => {
        nextColor = color.value;
        palette.querySelectorAll('.color-swatch').forEach(node => node.classList.toggle('selected', node === swatch));
      });
      palette.append(swatch);
    });
    modal.append(palette);
    const buttons = createElement('div', 'button-row');
    const removeAvatar = buttonNode('移除头像', '', 'modal-remove-avatar');
    removeAvatar.disabled = !nextAvatar;
    const cancel = buttonNode('取消', '', 'modal-cancel');
    const save = buttonNode('保存', 'primary', 'modal-save');
    buttons.append(removeAvatar, cancel, save);
    modal.append(buttons);
    backdrop.append(modal);
    elements.modalRoot.replaceChildren(backdrop);
    const close = () => elements.modalRoot.replaceChildren();
    cancel.addEventListener('click', close);
    removeAvatar.addEventListener('click', () => {
      nextAvatar = null;
      removeAvatar.disabled = true;
      const draft = { ...character, name: nameInput.value || character.name, avatarDataUrl: null };
      const nextPreview = characterPortraitNode(draft, 'editor');
      preview.replaceWith(nextPreview);
      preview = nextPreview;
    });
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    save.addEventListener('click', () => {
      character.name = (nameInput.value.trim() || '未命名角色').slice(0, 80);
      character.color = safeColor(nextColor, '#3d9b63');
      character.avatarDataUrl = nextAvatar;
      runtime.currentCharacterColor = character.color;
      scheduleSave();
      close();
      renderCharacters();
      renderCharacterLayers();
      renderAreas();
      emit('character:update', structuredClone(character));
    });
    requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
  }

  function deleteCharacter(id) {
    const index = state.characters.findIndex(item => item.id === id);
    if (index < 0) return false;
    const character = state.characters[index];
    const position = characterWorldPosition(character) || { x: 0, y: 0 };
    state.attackAreas.forEach(area => {
      if (area.anchor?.type === 'character' && area.anchor.characterId === id) {
        area.anchor = { type: 'free', markerId: null };
        area.origin = { ...position };
      }
    });
    state.characters.splice(index, 1);
    if (runtime.selectedCharacterId === id) runtime.selectedCharacterId = null;
    cancelCharacterMove(false);
    scheduleSave();
    renderCharacters();
    renderCharacterLayers();
    renderAreaLayers();
    showToast('角色已删除；绑定范围已改为自由放置');
    emit('character:delete', { id });
    return true;
  }

  function characterIcon(character) {
    const selected = runtime.selectedCharacterId === character.id;
    const color = safeColor(character.color, '#3d9b63');
    const portrait = character.avatarDataUrl
      ? '<img src="' + character.avatarDataUrl + '" alt="">'
      : '<span>' + escapeHtml((character.name.trim()[0] || '?').toUpperCase()) + '</span>';
    return L.divIcon({
      className: 'rpg-character',
      html: '<div class="rpg-character-core' + (selected ? ' selected' : '') + '" style="--character-color:' + color + '">' + portrait + '</div>',
      iconSize: [selected ? 42 : 34, selected ? 42 : 34],
      iconAnchor: [selected ? 21 : 17, selected ? 21 : 17]
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function renderCharacterLayers() {
    const visible = new Set(state.characters
      .filter(character => character.visible !== false && character.location.type === 'map')
      .map(character => character.id));
    for (const [id, view] of characterViews) {
      if (!visible.has(id)) {
        layers.characters.removeLayer(view);
        characterViews.delete(id);
      }
    }
    state.characters.forEach(character => {
      if (!visible.has(character.id)) return;
      let view = characterViews.get(character.id);
      if (!view) {
        view = L.marker(worldToLatLng(character.location, mapPackage.height), {
          icon: characterIcon(character),
          keyboard: true,
          pane: 'characterPane',
          title: character.name
        }).addTo(layers.characters);
        view.bindTooltip(createElement('span', '', character.name), {
          permanent: true,
          direction: 'bottom',
          offset: [0, 12],
          className: 'marker-tooltip character-tooltip'
        });
        view.on('click', event => {
          L.DomEvent.stopPropagation(event);
          selectCharacter(character.id);
        });
        characterViews.set(character.id, view);
      }
      view.setLatLng(worldToLatLng(character.location, mapPackage.height));
      view.setIcon(characterIcon(character));
      view.options.title = character.name;
      view.getTooltip()?.setContent(createElement('span', '', character.name));
    });
  }

  function followBoundCharacterAreas(character) {
    const position = characterWorldPosition(character);
    if (!position) return;
    state.attackAreas.forEach(area => {
      if (area.anchor?.type === 'character' && area.anchor.characterId === character.id) {
        area.origin = { ...position };
      }
    });
    runtime.damagePreview = null;
  }

  async function planCharacterMove(characterId, destination, arrival = null) {
    const character = state.characters.find(item => item.id === characterId);
    if (!character || character.location.type !== 'map') {
      showToast('请先选择一个位于地图上的角色', 'error');
      return null;
    }
    const request = ++runtime.characterMoveRequest;
    runtime.characterMovePreview = { characterId, calculating: true, arrival };
    renderCharacters();
    renderCharacterRoute();
    setStatus('正在计算道路优先路线…');
    const route = await findNavigationPath(ensureNavigationGrid(), character.location, destination);
    if (request !== runtime.characterMoveRequest) return null;
    if (!route) {
      runtime.characterMovePreview = null;
      renderCharacters();
      renderCharacterRoute();
      showToast('找不到可行路线，角色位置未改变', 'error');
      return null;
    }
    runtime.characterMovePreview = { characterId, ...route, arrival, calculating: false };
    renderCharacters();
    renderCharacterRoute();
    setStatus('路线 ' + formatDistance(route.distance) + ' · 确认后开始移动');
    emit('character:move-preview', structuredClone(runtime.characterMovePreview));
    return route;
  }

  function renderCharacterRoute() {
    layers.characterRoute.clearLayers();
    const preview = runtime.characterMovePreview;
    if (!preview || preview.calculating || !preview.points?.length) return;
    L.polyline(preview.points.map(point => worldToLatLng(point, mapPackage.height)), {
      pane: 'measurePane',
      color: '#176d76',
      weight: 4,
      dashArray: '10 7',
      interactive: false,
      className: 'character-route-preview'
    }).addTo(layers.characterRoute);
    L.tooltip({ permanent: true, direction: 'top', className: 'marker-tooltip', pane: 'measurePane' })
      .setLatLng(worldToLatLng(preview.points.at(-1), mapPackage.height))
      .setContent(formatDistance(preview.distance))
      .addTo(layers.characterRoute);
  }

  function animateCharacterRoute(character, preview, onComplete) {
    const view = characterViews.get(character.id);
    if (!view || preview.points.length < 2) {
      onComplete();
      return;
    }
    const segments = routeSegments(preview.points).segments;
    const duration = clamp(preview.distance / 250, 0.8, 6) * 1000;
    const started = performance.now();
    const frame = now => {
      const progress = clamp((now - started) / duration, 0, 1);
      const targetDistance = preview.distance * progress;
      let segmentIndex = segments.findIndex(segment => segment.cumulative >= targetDistance);
      if (segmentIndex < 0) segmentIndex = segments.length - 1;
      const segment = segments[segmentIndex];
      const from = preview.points[segmentIndex];
      const to = preview.points[segmentIndex + 1];
      const priorDistance = segment.cumulative - segment.length;
      const local = segment.length ? clamp((targetDistance - priorDistance) / segment.length, 0, 1) : 1;
      view.setLatLng(worldToLatLng({
        x: from.x + (to.x - from.x) * local,
        y: from.y + (to.y - from.y) * local
      }, mapPackage.height));
      if (progress < 1) requestAnimationFrame(frame); else onComplete();
    };
    requestAnimationFrame(frame);
  }

  function commitCharacterMove() {
    const preview = runtime.characterMovePreview;
    if (!preview || preview.calculating) return false;
    const character = state.characters.find(item => item.id === preview.characterId);
    if (!character || character.location.type !== 'map') return false;
    const arrival = preview.arrival;
    preview.committing = true;
    if (!arrival) {
      character.location = { type: 'map', x: preview.destination.x, y: preview.destination.y };
      followBoundCharacterAreas(character);
      scheduleSave();
    }
    renderCharacters();
    animateCharacterRoute(character, preview, () => {
      if (arrival?.type === 'building') {
        character.location = { type: 'building', featureId: arrival.featureId };
        followBoundCharacterAreas(character);
        scheduleSave();
        showToast(character.name + ' 已进入' + (featureById.get(arrival.featureId)?.name || '建筑'), 'success');
      }
      runtime.characterMovePreview = null;
      renderCharacters();
      renderCharacterLayers();
      renderCharacterRoute();
      renderAreaLayers();
      renderInspection();
      setStatus(arrival?.type === 'building'
        ? '角色已进入建筑'
        : '角色移动完成 · ' + formatDistance(preview.distance));
      emit('character:move', structuredClone(character));
    });
    return true;
  }

  function cancelCharacterMove(render = true) {
    runtime.characterMoveRequest += 1;
    runtime.characterMovePreview = null;
    if (render) {
      renderCharacters();
      renderCharacterRoute();
    }
  }

  function enterBuilding(characterId, featureId) {
    const character = state.characters.find(item => item.id === characterId);
    const feature = featureById.get(featureId);
    if (!character || character.location.type !== 'map') {
      showToast('请先选择一个位于地图上的角色', 'error');
      return false;
    }
    if (!feature?.enterable || !feature.entrance || featureSceneStatus(featureId, state.sceneEvents) === 'destroyed') {
      showToast('当前建筑不可进入', 'error');
      return false;
    }
    setTool('character-move');
    planCharacterMove(characterId, { x: feature.entrance[0], y: feature.entrance[1] }, {
      type: 'building',
      featureId
    });
    return true;
  }

  function exitBuilding(characterId) {
    const character = state.characters.find(item => item.id === characterId);
    if (!character || character.location.type !== 'building') return false;
    const feature = featureById.get(character.location.featureId);
    const target = feature?.entrance
      ? { x: feature.entrance[0], y: feature.entrance[1] }
      : { x: feature?.center?.[0] || 0, y: feature?.center?.[1] || 0 };
    const safe = nearestWalkablePoint(ensureNavigationGrid(), target, 120);
    if (!safe) {
      showToast('建筑附近没有可用安全位置', 'error');
      return false;
    }
    character.location = { type: 'map', x: safe.x, y: safe.y };
    followBoundCharacterAreas(character);
    scheduleSave();
    renderCharacters();
    renderCharacterLayers();
    renderAreaLayers();
    renderInspection();
    showToast(character.name + ' 已离开建筑', 'success');
    emit('character:exit-building', structuredClone(character));
    return true;
  }

  function selectDistanceMarker(markerId) {
    if (!runtime.measureA || (runtime.measureA && runtime.measureB)) {
      runtime.measureA = markerId;
      runtime.measureB = null;
    } else if (runtime.measureA !== markerId) {
      runtime.measureB = markerId;
    }
    runtime.selectedMarkerId = markerId;
    renderMarkers();
    renderMeasurement();
    renderMarkerLayers();
    renderMeasurementLayers();
  }

  function followBoundAreas(markerId) {
    const marker = state.markers.find(item => item.id === markerId);
    if (!marker) return [];
    const followed = [];
    state.attackAreas.forEach(area => {
      if (area.anchor?.type === 'marker' && area.anchor.markerId === markerId) {
        area.origin = { x: marker.x, y: marker.y };
        followed.push(area);
      }
    });
    if (runtime.damagePreview && followed.some(area => area.id === runtime.damagePreview.areaId)) {
      runtime.damagePreview = null;
      renderAreas();
      renderScene();
    }
    runtime.routePoints.forEach(point => {
      if (point.markerId === markerId) {
        point.x = marker.x;
        point.y = marker.y;
      }
    });
    return followed;
  }

  function updateGrid() {
    layers.grid.clearLayers();
    const gridLabel = elements.map.querySelector('[data-grid-label]');
    if (!runtime.gridVisible) {
      if (gridLabel) gridLabel.textContent = '网格已隐藏';
      return;
    }
    const bounds = map.getBounds();
    const northWest = latLngToWorld({ lat: bounds.getNorth(), lng: bounds.getWest() }, mapPackage.height);
    const southEast = latLngToWorld({ lat: bounds.getSouth(), lng: bounds.getEast() }, mapPackage.height);
    const minX = clamp(Math.min(northWest.x, southEast.x), -mapPackage.width * 3, mapPackage.width * 4);
    const maxX = clamp(Math.max(northWest.x, southEast.x), -mapPackage.width * 3, mapPackage.width * 4);
    const minY = clamp(Math.min(northWest.y, southEast.y), -mapPackage.height * 3, mapPackage.height * 4);
    const maxY = clamp(Math.max(northWest.y, southEast.y), -mapPackage.height * 3, mapPackage.height * 4);
    const worldPerPixel = Math.max((maxX - minX) / Math.max(1, elements.map.clientWidth), (maxY - minY) / Math.max(1, elements.map.clientHeight));
    const spacings = [1, 5, 20, 100, 500];
    let spacing = spacings.find(value => value / worldPerPixel >= 32) || 500;
    while ((maxX - minX) / spacing + (maxY - minY) / spacing > 420) {
      spacing = spacings[Math.min(spacings.length - 1, spacings.indexOf(spacing) + 1)];
      if (spacing === 500) break;
    }
    runtime.gridSpacing = spacing;
    if (gridLabel) gridLabel.textContent = '网格 ' + spacing + '米';
    const majorEvery = spacing === 500 ? 2 : 5;
    const firstX = Math.floor(minX / spacing) * spacing;
    const firstY = Math.floor(minY / spacing) * spacing;
    for (let x = firstX, index = Math.round(firstX / spacing); x <= maxX + spacing; x += spacing, index += 1) {
      const major = index % majorEvery === 0;
      L.polyline([
        worldToLatLng({ x, y: minY }, mapPackage.height),
        worldToLatLng({ x, y: maxY }, mapPackage.height)
      ], { pane: 'gridPane', interactive: false, weight: major ? 1.15 : 0.65, className: major ? 'grid-major' : 'grid-minor' }).addTo(layers.grid);
    }
    for (let y = firstY, index = Math.round(firstY / spacing); y <= maxY + spacing; y += spacing, index += 1) {
      const major = index % majorEvery === 0;
      L.polyline([
        worldToLatLng({ x: minX, y }, mapPackage.height),
        worldToLatLng({ x: maxX, y }, mapPackage.height)
      ], { pane: 'gridPane', interactive: false, weight: major ? 1.15 : 0.65, className: major ? 'grid-major' : 'grid-minor' }).addTo(layers.grid);
    }
    L.rectangle(baseBounds, { pane: 'gridPane', interactive: false, fill: false, color: '#5e5141', weight: 2, dashArray: '14 10' }).addTo(layers.grid);
  }

  function focusSelected() {
    if (runtime.activeTab === 'inspect' && runtime.selectedFeatureId) {
      focusFeatureIds([runtime.selectedFeatureId]);
      return;
    }
    if (runtime.activeTab === 'characters' && runtime.selectedCharacterId) {
      focusCharacter(runtime.selectedCharacterId);
      return;
    }
    if (runtime.selectedMarkerIds.size) {
      const selected = state.markers.filter(marker => runtime.selectedMarkerIds.has(marker.id));
      if (selected.length === 1) {
        map.flyTo(worldToLatLng(selected[0], mapPackage.height), Math.max(map.getZoom(), 0.5), { duration: 0.45 });
      } else if (selected.length > 1) {
        map.fitBounds(selected.map(marker => worldToLatLng(marker, mapPackage.height)), {
          padding: [48, 48],
          maxZoom: 2,
          animate: true
        });
      }
      return;
    }
    if (runtime.activeTab === 'areas' && runtime.selectedAreaId) {
      focusArea(runtime.selectedAreaId);
      return;
    }
    if (runtime.selectedMarkerId) {
      focusMarker(runtime.selectedMarkerId);
      return;
    }
    const area = selectedArea();
    if (area) focusArea(area.id);
    else fitInitialView();
  }

  function focusMarker(id) {
    const marker = state.markers.find(item => item.id === id);
    if (!marker) return;
    runtime.selectedMarkerId = id;
    map.flyTo(worldToLatLng(marker, mapPackage.height), Math.max(map.getZoom(), 0.5), { duration: 0.45 });
    renderMarkers();
    renderMarkerLayers();
  }

  function openMarkerEditor(id) {
    const marker = state.markers.find(item => item.id === id);
    if (!marker) return;
    const backdrop = createElement('div', 'modal-backdrop');
    const modal = createElement('div', 'modal');
    modal.append(createElement('h2', '', '编辑标记'));
    const nameField = createElement('div', 'field');
    const nameLabel = createElement('label', '', '名称');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.value = marker.name;
    nameField.append(nameLabel, nameInput);
    modal.append(nameField);
    const palette = createElement('div', 'palette');
    let nextColor = marker.color;
    MARKER_COLORS.forEach(color => {
      const swatch = createElement('button', 'color-swatch' + (marker.color === color.value ? ' selected' : ''));
      swatch.type = 'button';
      swatch.title = color.name;
      swatch.style.background = color.value;
      swatch.addEventListener('click', () => {
        nextColor = color.value;
        palette.querySelectorAll('.color-swatch').forEach(node => node.classList.toggle('selected', node === swatch));
      });
      palette.append(swatch);
    });
    modal.append(palette);
    const buttons = createElement('div', 'button-row');
    const cancel = buttonNode('取消', '', 'modal-cancel');
    const save = buttonNode('保存', 'primary', 'modal-save');
    buttons.append(cancel, save);
    modal.append(buttons);
    backdrop.append(modal);
    elements.modalRoot.replaceChildren(backdrop);
    const close = () => elements.modalRoot.replaceChildren();
    cancel.addEventListener('click', close);
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    save.addEventListener('click', () => {
      marker.name = (nameInput.value.trim() || '未命名标记').slice(0, 80);
      marker.color = safeColor(nextColor);
      scheduleSave();
      close();
      renderMarkers();
      renderMarkerLayers();
      renderMeasurement();
      renderAreas();
      emit('marker:update', structuredClone(marker));
    });
    requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
  }

  function deleteMarker(id) {
    deleteMarkers([id]);
  }

  function deleteMarkers(markerIds) {
    const result = removeMarkers(state, markerIds);
    if (!result.removedMarkers.length) return;
    const removedIds = new Set(result.removedMarkers.map(record => record.marker.id));
    state = result.state;
    runtime.lastDeletedMarker = {
      markers: result.removedMarkers.map(record => ({
        marker: structuredClone(record.marker),
        index: record.index
      })),
      detachedAreas: result.detachedAreas.map(area => structuredClone(area))
    };
    if (runtime.selectedMarkerId && removedIds.has(runtime.selectedMarkerId)) runtime.selectedMarkerId = null;
    clearMarkerSelection(false);
    if (removedIds.has(runtime.measureA) || removedIds.has(runtime.measureB)) clearDistance(false);
    runtime.routePoints.forEach(point => {
      if (point.markerId && removedIds.has(point.markerId)) delete point.markerId;
    });
    scheduleSave();
    renderAll();
    const removed = result.removedMarkers.map(record => record.marker);
    const message = removed.length === 1 ? '已删除“' + removed[0].name + '”' : '已删除 ' + removed.length + ' 个标记';
    showUndoToast(message, '撤销', 'undo-marker');
    if (runtime.tool === 'marker-select') setStatus(message + '；可继续框选，Esc 结束');
    removed.forEach(marker => emit('marker:delete', { id: marker.id }));
    if (removed.length > 1) emit('marker:batch-delete', { ids: removed.map(marker => marker.id) });
  }

  function showUndoToast(message, label, action) {
    const toast = createElement('div', 'toast');
    const textNode = createElement('span', '', message);
    const button = buttonNode(label, '', action);
    toast.append(textNode, button);
    elements.toasts.append(toast);
    setTimeout(() => toast.remove(), 6200);
  }

  function undoDeletedMarker() {
    const record = runtime.lastDeletedMarker;
    if (!record) return;
    const markerRecords = record.markers || [{ marker: record.marker, index: record.index }];
    markerRecords
      .slice()
      .sort((left, right) => left.index - right.index)
      .forEach(saved => {
        state.markers.splice(clamp(saved.index, 0, state.markers.length), 0, structuredClone(saved.marker));
      });
    (record.detachedAreas || record.anchoredAreas || []).forEach(saved => {
      const area = state.attackAreas.find(item => item.id === saved.id);
      if (area) {
        area.anchor = structuredClone(saved.anchor);
        area.origin = structuredClone(saved.origin);
      }
    });
    runtime.selectedMarkerId = markerRecords.length === 1 ? markerRecords[0].marker.id : null;
    runtime.lastDeletedMarker = null;
    scheduleSave();
    renderAll();
    showToast(markerRecords.length === 1 ? '标记已恢复' : '已恢复 ' + markerRecords.length + ' 个标记', 'success');
  }

  async function confirmClearMarkers() {
    if (!state.markers.length) return;
    const confirmed = await confirmDialog('清空全部标记', '将删除全部玩家标记，并把绑定范围改为自由放置。此操作不会影响已应用的场景破坏。', '清空');
    if (!confirmed) return;
    const markerIds = state.markers.map(marker => marker.id);
    const result = removeMarkers(state, markerIds);
    state = result.state;
    const removedIds = new Set(markerIds);
    runtime.routePoints.forEach(point => {
      if (point.markerId && removedIds.has(point.markerId)) delete point.markerId;
    });
    runtime.selectedMarkerId = null;
    runtime.lastDeletedMarker = null;
    clearMarkerSelection(false);
    clearDistance(false);
    scheduleSave();
    renderAll();
    showToast('已清空全部玩家标记；场景破坏保持不变', 'success');
    emit('marker:clear', null);
  }

  function clearDistance(render = true) {
    runtime.measureA = null;
    runtime.measureB = null;
    if (render) {
      renderMarkers();
      renderMeasurement();
      renderMarkerLayers();
      renderMeasurementLayers();
    }
  }

  function renderMeasurementLayers() {
    layers.measure.clearLayers();
    const markerA = state.markers.find(marker => marker.id === runtime.measureA);
    const markerB = state.markers.find(marker => marker.id === runtime.measureB);
    if (!markerA || !markerB) return;
    const points = [worldToLatLng(markerA, mapPackage.height), worldToLatLng(markerB, mapPackage.height)];
    L.polyline(points, { pane: 'measurePane', color: '#a6332d', weight: 4, dashArray: '10 7' }).addTo(layers.measure);
    const midpoint = { x: (markerA.x + markerB.x) / 2, y: (markerA.y + markerB.y) / 2 };
    L.tooltip({
      permanent: true,
      direction: 'top',
      offset: L.point(0, -8),
      className: 'marker-tooltip measure-distance-tooltip',
      pane: 'measurePane'
    })
      .setLatLng(worldToLatLng(midpoint, mapPackage.height))
      .setContent(formatDistance(distanceMeters(markerA, markerB)))
      .addTo(layers.measure);
  }

  function clearRoute() {
    runtime.routePoints.splice(0);
    runtime.routeFinished = false;
    renderMeasurement();
    renderRouteLayers();
  }

  function routeHandleIcon(index) {
    return L.divIcon({
      className: 'aoe-handle',
      html: '<div class="aoe-handle-core secondary"></div><div class="rpg-marker-label">' + (index + 1) + '</div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  function renderRouteLayers() {
    layers.route.clearLayers();
    if (!runtime.routePoints.length) return;
    let latLngs = runtime.routePoints.map(point => worldToLatLng(point, mapPackage.height));
    let routeLine = null;
    let totalTooltip = null;
    if (latLngs.length > 1) {
      routeLine = L.polyline(latLngs, {
        pane: 'measurePane',
        color: runtime.routeFinished ? '#3f6f54' : '#82542f',
        weight: 4,
        dashArray: runtime.routeFinished ? null : '12 7'
      }).addTo(layers.route);
    }
    const refreshLiveRoute = () => {
      latLngs = runtime.routePoints.map(item => worldToLatLng(item, mapPackage.height));
      routeLine?.setLatLngs(latLngs);
      const liveSummary = routeSegments(runtime.routePoints);
      if (totalTooltip && latLngs.length) {
        totalTooltip.setLatLng(latLngs.at(-1));
        totalTooltip.setContent('总计 ' + formatDistance(liveSummary.total));
      }
      renderMeasurement();
    };
    runtime.routePoints.forEach((point, index) => {
      const handle = L.marker(worldToLatLng(point, mapPackage.height), {
        pane: 'handlePane',
        draggable: true,
        icon: routeHandleIcon(index),
        keyboard: true,
        title: '路线节点 ' + (index + 1)
      }).addTo(layers.route);
      handle.on('drag', () => {
        const next = clampWorld(latLngToWorld(handle.getLatLng(), mapPackage.height));
        runtime.routePoints[index] = next;
        refreshLiveRoute();
      });
      handle.on('dragend', () => {
        runtime.routePoints[index] = snapRoutePoint(clampWorld(latLngToWorld(handle.getLatLng(), mapPackage.height)));
        renderMeasurement();
        renderRouteLayers();
      });
    });
    const summary = routeSegments(runtime.routePoints);
    if (summary.total > 0) {
      totalTooltip = L.tooltip({ permanent: true, direction: 'top', className: 'marker-tooltip', pane: 'measurePane' })
        .setLatLng(latLngs.at(-1))
        .setContent('总计 ' + formatDistance(summary.total))
      .addTo(layers.route);
    }
  }

  function resolvedAttackArea(area) {
    return { ...area, origin: resolveAreaOrigin(area, state, mapPackage) };
  }

  function areaLatLngs(area) {
    return attackAreaToPolygon(resolvedAttackArea(area)).map(([x, y]) => worldToLatLng({ x, y }, mapPackage.height));
  }

  function startAreaPlacement(shape) {
    runtime.pendingShape = ['circle', 'sector', 'rectangle'].includes(shape) ? shape : 'circle';
    runtime.placingArea = true;
    runtime.selectedAreaId = null;
    runtime.damagePreview = null;
    setTool('aoe');
    renderAreas();
    setStatus('范围攻击：在底图或图外工作区点击放置' + (runtime.pendingShape === 'circle' ? '圆心' : '起点'));
  }

  function placeAttackArea(origin) {
    const replacing = state.attackAreas.find(item => item.id === runtime.selectedAreaId);
    if (replacing) {
      replacing.origin = { x: origin.x, y: origin.y };
      replacing.anchor = { type: 'free', markerId: null };
      runtime.damagePreview = null;
      emit('area:update', structuredClone(replacing));
    } else {
      const area = makeDefaultArea(runtime.pendingShape, origin, AREA_COLORS[state.attackAreas.length % AREA_COLORS.length]);
      state.attackAreas.push(area);
      runtime.selectedAreaId = area.id;
      emit('area:create', structuredClone(area));
    }
    runtime.placingArea = false;
    scheduleSave();
    renderAreas();
    renderAreaLayers();
    renderScene();
    setStatus('范围已放置，可拖动手柄或输入精确尺寸');
  }

  function updateArea(id, patch, refreshPanel = true, invalidatePreview = true) {
    const area = state.attackAreas.find(item => item.id === id);
    if (!area) return;
    Object.assign(area, patch);
    if (patch.origin) area.origin = { x: Number(patch.origin.x), y: Number(patch.origin.y) };
    if (patch.anchor) area.anchor = { ...patch.anchor };
    area.headingDeg = normalizeHeading(area.headingDeg ?? 0);
    area.opacity = clamp(Number(area.opacity ?? 0.18), 0.05, 0.55);
    if (invalidatePreview) invalidateDamagePreview();
    scheduleSave();
    if (refreshPanel) renderAreas();
    renderAreaLayers();
    renderScene();
    emit('area:update', structuredClone(area));
  }

  function duplicateArea(id) {
    const source = state.attackAreas.find(item => item.id === id);
    if (!source) return;
    const origin = resolveAreaOrigin(source, state, mapPackage);
    const copy = structuredClone(source);
    copy.id = uid('area');
    copy.name = (source.name + ' 副本').slice(0, 80);
    copy.anchor = { type: 'free', markerId: null };
    copy.origin = { x: origin.x + 40, y: origin.y + 40 };
    copy.destructionEnabled = false;
    state.attackAreas.push(copy);
    runtime.selectedAreaId = copy.id;
    runtime.damagePreview = null;
    scheduleSave();
    renderAreas();
    renderAreaLayers();
    emit('area:create', structuredClone(copy));
  }

  function deleteArea(id) {
    const index = state.attackAreas.findIndex(item => item.id === id);
    if (index < 0) return;
    const [removed] = state.attackAreas.splice(index, 1);
    runtime.selectedAreaId = state.attackAreas[index]?.id || state.attackAreas[index - 1]?.id || null;
    runtime.damagePreview = null;
    scheduleSave();
    renderAreas();
    renderAreaLayers();
    renderScene();
    showToast('已删除范围；已应用的破坏快照保持不变');
    emit('area:delete', { id: removed.id });
  }

  function focusArea(id) {
    const area = state.attackAreas.find(item => item.id === id);
    if (!area) return;
    runtime.selectedAreaId = id;
    const polygon = areaLatLngs(area);
    map.flyToBounds(L.latLngBounds(polygon), { padding: [70, 70], duration: 0.45, maxZoom: 3 });
    renderAreas();
    renderAreaLayers();
  }

  function areaHandleIcon(secondary = false, label = '') {
    return L.divIcon({
      className: 'aoe-handle',
      html: '<div class="aoe-handle-core' + (secondary ? ' secondary' : '') + '"></div>' +
        (label ? '<div class="rpg-marker-label">' + label + '</div>' : ''),
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  function renderAreaLayers() {
    layers.areas.clearLayers();
    layers.areaHandles.clearLayers();
    areaViews.clear();
    state.attackAreas.forEach(area => {
      if (!area.visible) return;
      let latLngs;
      try {
        latLngs = areaLatLngs(area);
      } catch (error) {
        console.warn('跳过无效攻击范围', area.id, error);
        return;
      }
      const selected = runtime.selectedAreaId === area.id;
      const view = L.polygon(latLngs, {
        pane: 'aoePane',
        color: safeColor(area.color, AREA_COLORS[0]),
        weight: selected ? 4 : 2.5,
        opacity: 0.95,
        fillColor: safeColor(area.color, AREA_COLORS[0]),
        fillOpacity: area.opacity,
        dashArray: area.destructionEnabled ? null : '10 6',
        interactive: true
      }).addTo(layers.areas);
      view.bindTooltip(createElement('span', '', area.name + ' · ' + areaDimensions(area)), { sticky: true, className: 'marker-tooltip' });
      view.on('click', event => {
        L.DomEvent.stopPropagation(event.originalEvent);
        runtime.selectedAreaId = area.id;
        runtime.damagePreview = null;
        setTab('areas');
        renderAreas();
        renderAreaLayers();
        renderScene();
      });
      areaViews.set(area.id, view);
      if (selected) renderAreaHandles(area);
    });
  }

  function addAreaHandle(area, point, options, onDrag, onEnd = onDrag) {
    const handle = L.marker(worldToLatLng(point, mapPackage.height), {
      pane: 'handlePane',
      draggable: true,
      keyboard: true,
      icon: areaHandleIcon(options.secondary, options.label),
      title: options.title
    }).addTo(layers.areaHandles);
    handle.on('drag', () => {
      const next = snapForPreference(latLngToWorld(handle.getLatLng(), mapPackage.height));
      onDrag(next);
    });
    handle.on('dragend', () => {
      const next = snapForPreference(latLngToWorld(handle.getLatLng(), mapPackage.height));
      onEnd(next);
      renderAreas();
      renderAreaLayers();
      scheduleSave();
    });
    return handle;
  }

  function renderAreaHandles(area) {
    const handles = {};
    const currentOrigin = () => resolveAreaOrigin(area, state, mapPackage);
    const syncHandles = () => {
      const origin = currentOrigin();
      handles.origin?.setLatLng(worldToLatLng(origin, mapPackage.height));
      if (area.shape === 'circle') {
        handles.radius?.setLatLng(worldToLatLng(forwardPoint(origin, area.radius, 90), mapPackage.height));
        return;
      }
      const end = forwardPoint(origin, area.shape === 'sector' ? area.range : area.length, area.headingDeg);
      handles.direction?.setLatLng(worldToLatLng(end, mapPackage.height));
      if (area.shape === 'sector') {
        const edge = forwardPoint(origin, area.range, area.headingDeg + area.angleDeg / 2);
        handles.angle?.setLatLng(worldToLatLng(edge, mapPackage.height));
      } else {
        const midpoint = forwardPoint(origin, area.length / 2, area.headingDeg);
        const widthPoint = forwardPoint(midpoint, area.width / 2, area.headingDeg + 90);
        handles.width?.setLatLng(worldToLatLng(widthPoint, mapPackage.height));
      }
    };
    const refreshLiveArea = () => {
      runtime.damagePreview = null;
      refreshAreaGeometry(area);
      syncHandles();
      renderScene();
    };

    handles.origin = addAreaHandle(area, currentOrigin(), { label: '起点', title: '拖动范围起点' }, next => {
      area.origin = { ...next };
      area.anchor = { type: 'free', markerId: null };
      refreshLiveArea();
    });

    if (area.shape === 'circle') {
      const radiusPoint = forwardPoint(currentOrigin(), area.radius, 90);
      handles.radius = addAreaHandle(area, radiusPoint, { secondary: true, label: '半径', title: '拖动修改半径' }, next => {
        const origin = currentOrigin();
        area.radius = clamp(distanceMeters(origin, next), 1, Math.max(mapPackage.width, mapPackage.height) * 4);
        refreshLiveArea();
      });
      return;
    }

    const origin = currentOrigin();
    const end = forwardPoint(origin, area.shape === 'sector' ? area.range : area.length, area.headingDeg);
    handles.direction = addAreaHandle(area, end, { secondary: true, label: '方向', title: '拖动修改距离与朝向' }, next => {
      const current = currentOrigin();
      const distance = clamp(distanceMeters(current, next), 1, Math.max(mapPackage.width, mapPackage.height) * 4);
      area.headingDeg = headingBetween(current, next);
      if (area.shape === 'sector') area.range = distance; else area.length = distance;
      refreshLiveArea();
    });

    if (area.shape === 'sector') {
      const edge = forwardPoint(origin, area.range, area.headingDeg + area.angleDeg / 2);
      handles.angle = addAreaHandle(area, edge, { secondary: true, label: '夹角', title: '拖动修改扇形夹角' }, next => {
        const current = currentOrigin();
        area.angleDeg = clamp(Math.abs(angularDelta(headingBetween(current, next), area.headingDeg)) * 2, 1, 359);
        area.range = clamp(distanceMeters(current, next), 1, Math.max(mapPackage.width, mapPackage.height) * 4);
        refreshLiveArea();
      });
    } else {
      const midpoint = forwardPoint(origin, area.length / 2, area.headingDeg);
      const widthPoint = forwardPoint(midpoint, area.width / 2, area.headingDeg + 90);
      handles.width = addAreaHandle(area, widthPoint, { secondary: true, label: '宽度', title: '拖动修改矩形宽度' }, next => {
        const current = currentOrigin();
        const currentMidpoint = forwardPoint(current, area.length / 2, area.headingDeg);
        const headingRadians = area.headingDeg * Math.PI / 180;
        const right = { x: Math.cos(headingRadians), y: Math.sin(headingRadians) };
        const dx = next.x - currentMidpoint.x;
        const dy = next.y - currentMidpoint.y;
        area.width = clamp(Math.abs(dx * right.x + dy * right.y) * 2, 1, Math.max(mapPackage.width, mapPackage.height) * 4);
        refreshLiveArea();
      });
    }
  }

  function refreshAreaGeometry(area) {
    const view = areaViews.get(area.id);
    if (view) {
      view.setLatLngs(areaLatLngs(area));
      view.getTooltip()?.setContent(createElement('span', '', area.name + ' · ' + areaDimensions(area)));
    }
    const values = {
      'area-radius': area.radius,
      'area-range': area.range,
      'area-angle': area.angleDeg,
      'area-length': area.length,
      'area-width': area.width,
      'area-heading': area.headingDeg,
      'area-opacity': area.opacity
    };
    Object.entries(values).forEach(([role, value]) => {
      const input = container.querySelector('[data-role="' + role + '"][data-area-id="' + CSS.escape(area.id) + '"]');
      if (input && document.activeElement !== input) input.value = Number(value).toFixed(role === 'area-opacity' ? 2 : 1).replace(/\.0$/, '');
    });
    const summary = container.querySelector('[data-area-summary-id="' + CSS.escape(area.id) + '"]');
    if (summary) {
      const shapeLabel = area.shape === 'circle' ? '圆' : area.shape === 'sector' ? '扇形' : '矩形';
      summary.textContent = shapeLabel + ' · ' + areaDimensions(area) + (area.visible ? '' : ' · 已隐藏');
    }
  }

  function downloadSave() {
    try {
      const payload = exportSave(state, mapPackage);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = mapPackage.id + '-存档-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      showToast('存档已导出', 'success');
    } catch (error) {
      showToast('导出失败：' + error.message, 'error');
    }
  }

  async function handleImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_SAVE_FILE_BYTES) {
        throw new Error('存档文件超过 5 MB 上限');
      }
      const text = await file.text();
      const raw = JSON.parse(text);
      await importSaveObject(raw, true);
    } catch (error) {
      showToast('导入失败：' + error.message, 'error');
    }
  }

  async function importSaveObject(raw, askConfirmation = false) {
    const migration = migrateSave(raw, mapPackage);
    const normalized = validateAndNormalizeSave(migration.save, mapPackage);
    if (askConfirmation) {
      const migrationMessage = migration.migrated
        ? `检测到 ${migration.fromVersion} 版存档，将迁移到 ${migration.toVersion}。`
        : '';
      const confirmed = await confirmDialog(
        '导入存档',
        migrationMessage + '导入将替换当前标记、攻击范围、破坏历史和用户设置。',
        '导入'
      );
      if (!confirmed) return false;
    }
    try {
      persistence.replace(normalized);
    } catch (error) {
      throw new Error('浏览器存储写入失败，当前状态未被替换：' + error.message);
    }
    state = normalized;
    runtime.selectedMarkerId = null;
    runtime.selectedMarkerIds.clear();
    runtime.markerSelectionDrag = null;
    runtime.lastDeletedMarker = null;
    layers.markerSelection.clearLayers();
    runtime.measureA = null;
    runtime.measureB = null;
    runtime.routePoints = [];
    runtime.routeFinished = false;
    runtime.selectedAreaId = state.attackAreas[0]?.id || null;
    runtime.placingArea = false;
    runtime.damagePreview = null;
    runtime.selectedFeatureId = null;
    runtime.highlightedFeatureIds.clear();
    runtime.featureHighlightSource = null;
    runtime.gridVisible = state.preferences.gridVisible !== false;
    invalidateNavigation();
    if (ejectDestroyedBuildingOccupants(deriveSceneState(state.sceneEvents).destroyedObjectIds).length) scheduleSave();
    renderAll();
    setTool(runtime.tool);
    showToast(migration.migrated
      ? `存档已从 ${migration.fromVersion} 迁移并导入`
      : '存档导入成功', 'success');
    if (migration.migrated) {
      emit('state:migrate', {
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
        warnings: [...migration.warnings]
      });
    }
    emit('state:import', structuredClone(state));
    return true;
  }

  function previewDamage() {
    const area = selectedArea();
    if (!area || (!area.destructionEnabled && !area.craterEnabled)) {
      showToast('请先选择范围，并启用场景破坏或弹坑', 'error');
      return null;
    }
    const categories = area.destructionEnabled ? (area.destructionTargets || []) : [];
    try {
      const previewArea = {
        ...resolvedAttackArea(area),
        severeDamage: area.destructionEnabled && area.severeDamage,
        destructionTargets: categories
      };
      const preview = createDamagePreview(previewArea, mapPackage.features || [], categories);
      if (!preview.counts) {
        const counts = {};
        const ids = new Set(preview.featureIds || [
          ...(preview.objectIds || []),
          ...(preview.clipHits || []).map(hit => hit.featureId)
        ]);
        (mapPackage.features || []).forEach(feature => {
          if (ids.has(feature.id)) counts[feature.category] = (counts[feature.category] || 0) + 1;
        });
        preview.counts = counts;
      }
      const destroyedBuildings = new Set((preview.objectIds || []).filter(id => featureById.get(id)?.category === 'building'));
      preview.ejectedCharacterIds = state.characters
        .filter(character => character.location.type === 'building' && destroyedBuildings.has(character.location.featureId))
        .map(character => character.id);
      runtime.damagePreview = preview;
      renderAreas();
      renderScene();
      emit('scene:preview', structuredClone(preview));
      return preview;
    } catch (error) {
      runtime.damagePreview = null;
      renderAreas();
      renderScene();
      showToast('影响预览失败：' + error.message, 'error');
      return null;
    }
  }

  function ejectDestroyedBuildingOccupants(destroyedFeatureIds) {
    const destroyedBuildings = new Set((destroyedFeatureIds || []).filter(id => (
      featureById.get(id)?.category === 'building'
    )));
    if (!destroyedBuildings.size) return [];
    const navigation = ensureNavigationGrid();
    const ejected = [];
    state.characters.forEach(character => {
      if (character.location.type !== 'building' || !destroyedBuildings.has(character.location.featureId)) return;
      const feature = featureById.get(character.location.featureId);
      const target = feature?.entrance
        ? { x: feature.entrance[0], y: feature.entrance[1] }
        : { x: feature?.center?.[0] || 0, y: feature?.center?.[1] || 0 };
      const safe = nearestWalkablePoint(navigation, target, 200)
        || nearestWalkablePoint(navigation, target, Math.max(mapPackage.width, mapPackage.height));
      if (!safe) return;
      character.location = { type: 'map', x: safe.x, y: safe.y };
      followBoundCharacterAreas(character);
      ejected.push(character.id);
      emit('character:eject', { characterId: character.id, featureId: feature?.id || null });
    });
    return ejected;
  }

  function applyDamage() {
    const area = selectedArea();
    if (!area || (!area.destructionEnabled && !area.craterEnabled) || !runtime.damagePreview) {
      showToast('请先预览影响，再应用破坏', 'error');
      return false;
    }
    try {
      const categories = area.destructionEnabled ? (area.destructionTargets || []) : [];
      const currentArea = {
        ...resolvedAttackArea(area),
        severeDamage: area.destructionEnabled && area.severeDamage,
        destructionTargets: categories
      };
      const currentPreview = createDamagePreview(
        currentArea,
        mapPackage.features || [],
        categories
      );
      if (runtime.damagePreview.signature !== currentPreview.signature) {
        invalidateDamagePreview();
        renderAreas();
        renderScene();
        showToast('范围参数已变化，请重新预览影响', 'error');
        return false;
      }
      const before = state;
      state = commitDamageEvent(state, currentArea, currentPreview);
      if (state === before) {
        showToast('范围内没有符合规则的可破坏对象');
        return false;
      }
      const event = state.sceneEvents.at(-1);
      invalidateNavigation();
      const ejected = ejectDestroyedBuildingOccupants(event.objectIds || []);
      runtime.damagePreview = null;
      scheduleSave();
      renderAreas();
      renderScene();
      renderCharacters();
      renderCharacterLayers();
      showToast('场景破坏已应用' + (ejected.length ? '，已疏散 ' + ejected.length + ' 名角色' : '') + '，可撤销或恢复对象', 'success');
      emit('scene:damage', structuredClone(event));
      return true;
    } catch (error) {
      showToast('应用破坏失败：' + error.message, 'error');
      return false;
    }
  }

  function undoScene() {
    try {
      const removedEvent = state.sceneEvents.at(-1);
      const before = state;
      state = undoLastSceneEvent(state);
      if (state === before) {
        showToast('没有可以撤销的场景记录');
        return false;
      }
      runtime.damagePreview = null;
      invalidateNavigation();
      scheduleSave();
      renderAreas();
      renderScene();
      showToast('已撤销上一步，并删除该条记录', 'success');
      emit('scene:undo', structuredClone(removedEvent));
      return true;
    } catch (error) {
      showToast('撤销失败：' + error.message, 'error');
      return false;
    }
  }

  async function resetScene() {
    if (!state.sceneEvents.length) {
      showToast('场景记录已经是空的');
      return false;
    }
    const confirmed = await confirmDialog(
      '彻底重置场景',
      '这会恢复所有被破坏的建筑、城墙、植被、桥梁和地表，并永久清空全部破坏与恢复记录。此操作不可撤销；已保存的攻击范围和标记不会被删除。',
      '彻底重置'
    );
    if (!confirmed) return false;
    const clearedEvents = state.sceneEvents;
    state = commitResetSceneEvent(state);
    runtime.damagePreview = null;
    invalidateNavigation();
    scheduleSave();
    renderAreas();
    renderScene();
    showToast('场景已彻底重置，全部破坏记录已清空', 'success');
    emit('scene:reset', structuredClone(clearedEvents));
    return true;
  }

  function restoreFeatures(featureIds) {
    try {
      const before = state;
      state = commitRestoreEvent(state, [...new Set(featureIds || [])]);
      if (state === before) return false;
      runtime.damagePreview = null;
      invalidateNavigation();
      scheduleSave();
      renderAreas();
      renderScene();
      emit('scene:restore', structuredClone(state.sceneEvents.at(-1)));
      return true;
    } catch (error) {
      showToast('恢复失败：' + error.message, 'error');
      return false;
    }
  }

  function restoreEvent(id) {
    const event = state.sceneEvents.find(item => item.id === id && item.type === 'damage');
    if (!event) return;
    const ids = [
      ...(event.objectIds || []),
      ...(event.clipHits || []).map(hit => hit.featureId)
    ];
    if (restoreFeatures(ids)) showToast('已恢复该事件涉及的当前对象', 'success');
    else showToast('这些对象当前已经完整');
  }

  function renderInspectionOverlay() {
    const namespace = 'http://www.w3.org/2000/svg';
    let layer = baseSvg.querySelector('#layer-inspection');
    if (!layer) {
      layer = document.createElementNS(namespace, 'g');
      layer.setAttribute('id', 'layer-inspection');
      layer.setAttribute('aria-hidden', 'true');
      const labels = baseSvg.querySelector('#layer-labels');
      (labels?.parentNode || baseSvg).insertBefore(layer, labels || null);
    }
    layer.replaceChildren();
    const ids = [...runtime.highlightedFeatureIds];
    if (runtime.selectedFeatureId && !runtime.highlightedFeatureIds.has(runtime.selectedFeatureId)) {
      ids.push(runtime.selectedFeatureId);
    }
    ids.forEach(id => {
      const feature = featureById.get(id);
      const points = feature?.geometry?.points;
      if (!Array.isArray(points) || points.length < 3) return;
      const outline = document.createElementNS(namespace, 'polygon');
      outline.setAttribute('points', points.map(point => point[0] + ',' + point[1]).join(' '));
      outline.setAttribute('vector-effect', 'non-scaling-stroke');
      outline.setAttribute('data-inspection-for', id);
      outline.setAttribute('class', 'feature-inspection-outline ' + (
        id === runtime.selectedFeatureId ? 'selected-feature' : 'event-highlight'
      ));
      layer.append(outline);
    });
  }

  function renderScene() {
    pruneFeatureHighlights();
    sceneRenderer.render();
    renderInspectionOverlay();
    renderInspection();
    mapPresentation.schedule();
  }

  function emit(name, detail) {
    bus.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
