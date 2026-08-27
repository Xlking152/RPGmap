import L from 'leaflet';
import { attackAreaToPolygon, worldToLatLng } from '../engine/geometry.js';
import { createDamagePreview, commitDamageEvent } from '../engine/state.js';

const AREA_COLORS = ['#d63d32', '#e48a28', '#7652a8', '#258a83', '#3f70c5'];

function clone(value) { return structuredClone(value); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function uid(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${value}`;
}
function safeColor(value, fallback = AREA_COLORS[0]) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}
function createElement(documentNode, tag, className = '', text = null) {
  const node = documentNode.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}
function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find(feature => String(feature.id) === String(featureId)) || null;
}
function defaultArea(shape, origin, index = 0) {
  return {
    id: uid('area'),
    name: shape === 'circle' ? '圆形范围' : shape === 'sector' ? '扇形范围' : '矩形范围',
    shape,
    origin: { x: Number(origin.x), y: Number(origin.y) },
    anchor: { type: 'free', markerId: null },
    radius: 100,
    range: 200,
    angleDeg: 60,
    length: 300,
    width: 80,
    headingDeg: 0,
    color: AREA_COLORS[index % AREA_COLORS.length],
    opacity: 0.18,
    visible: true,
    destructionEnabled: false,
    severeDamage: false,
    craterEnabled: false,
    destructionTargets: ['building', 'wall', 'vegetation', 'bridge', 'terrain'],
  };
}

export function createSceneAreaSystem() {
  return Object.freeze({
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const panel = api.uiPanels?.get?.('areas') || shell.querySelector?.('[data-panel="areas"]');
      let pane = api.map.getPane?.('aoePane');
      if (!pane) pane = api.map.createPane('aoePane');
      pane.style.zIndex = '390';
      const layer = L.layerGroup([], { pane: 'aoePane' }).addTo(api.map);
      let selectedAreaId = null;
      let placingShape = null;
      let preview = null;
      let destroyed = false;
      const off = [];

      const status = message => {
        const node = shell.querySelector?.('[data-role="map-status"]');
        if (node) node.textContent = message;
      };
      const areas = () => api.getState()?.attackAreas || [];
      const selected = () => areas().find(area => String(area.id) === String(selectedAreaId)) || null;

      function tokenOrigin(tokenId) {
        const token = api.tokens?.get?.(tokenId);
        if (!token) return null;
        if (token.placement === 'map') return { x: Number(token.x), y: Number(token.y) };
        if (token.placement === 'feature') {
          const feature = featureById(api.mapPackage, token.featureId);
          if (Array.isArray(feature?.center)) return { x: Number(feature.center[0]), y: Number(feature.center[1]) };
        }
        return null;
      }

      function resolvedOrigin(area) {
        if (area?.anchor?.type === 'marker') {
          const marker = api.getState()?.markers?.find(item => String(item.id) === String(area.anchor.markerId));
          if (marker) return { x: Number(marker.x), y: Number(marker.y) };
        }
        if (area?.anchor?.type === 'token') {
          const origin = tokenOrigin(area.anchor.tokenId);
          if (origin) return origin;
        }
        return { x: Number(area?.origin?.x) || 0, y: Number(area?.origin?.y) || 0 };
      }

      function resolvedArea(area) {
        return { ...area, origin: resolvedOrigin(area) };
      }

      async function commitAreas(nextAreas, source = 'scene-area') {
        const next = api.getState();
        next.attackAreas = clone(nextAreas);
        await Promise.resolve(api.commitState(next, { source, render: true }));
        return true;
      }

      async function patchArea(areaId, patch) {
        const next = clone(areas());
        const area = next.find(item => String(item.id) === String(areaId));
        if (!area) return false;
        Object.assign(area, patch);
        if (patch.origin) area.origin = { x: Number(patch.origin.x), y: Number(patch.origin.y) };
        if (patch.anchor) area.anchor = clone(patch.anchor);
        area.opacity = clamp(Number(area.opacity ?? 0.18), 0.05, 0.55);
        area.headingDeg = ((Number(area.headingDeg || 0) % 360) + 360) % 360;
        preview = null;
        await commitAreas(next, 'scene-area:update');
        render();
        return true;
      }

      function renderLayers() {
        layer.clearLayers();
        for (const area of areas()) {
          if (area.visible === false) continue;
          let points;
          try { points = attackAreaToPolygon(resolvedArea(area)); }
          catch { continue; }
          const polygon = L.polygon(points.map(([x, y]) => worldToLatLng({ x, y }, api.mapPackage.height)), {
            pane: 'aoePane',
            color: safeColor(area.color),
            weight: String(area.id) === String(selectedAreaId) ? 4 : 2.5,
            opacity: 0.95,
            fillColor: safeColor(area.color),
            fillOpacity: clamp(Number(area.opacity ?? 0.18), 0.05, 0.55),
            dashArray: area.destructionEnabled ? null : '10 6',
            interactive: true,
          }).addTo(layer);
          polygon.bindTooltip(area.name || area.id, { sticky: true, className: 'marker-tooltip' });
          polygon.on('click', event => {
            L.DomEvent.stopPropagation(event.originalEvent);
            selectedAreaId = area.id;
            preview = null;
            api.setActivePanel?.('areas');
            render();
          });
        }
      }

      function actorName(token) {
        try { return api.tokens.resolveActor(token.id)?.actor?.name || token.id; }
        catch { return token.id; }
      }

      function inputRow(label, name, value, { type = 'number', min = null, max = null, step = null } = {}) {
        const row = createElement(documentNode, 'label', 'field');
        row.append(createElement(documentNode, 'span', '', label));
        const input = documentNode.createElement('input');
        input.type = type;
        input.name = name;
        input.value = value ?? '';
        if (min != null) input.min = String(min);
        if (max != null) input.max = String(max);
        if (step != null) input.step = String(step);
        row.append(input);
        return row;
      }

      function renderEditor(area) {
        const section = createElement(documentNode, 'div', 'section');
        section.append(createElement(documentNode, 'h2', '', `编辑：${area.name || area.id}`));
        const grid = createElement(documentNode, 'div', 'field-grid');
        grid.append(inputRow('名称', 'name', area.name, { type: 'text' }));
        if (area.shape === 'circle') grid.append(inputRow('半径（米）', 'radius', area.radius, { min: 1, step: 1 }));
        if (area.shape === 'sector') {
          grid.append(inputRow('距离（米）', 'range', area.range, { min: 1, step: 1 }));
          grid.append(inputRow('夹角（度）', 'angleDeg', area.angleDeg, { min: 1, max: 359, step: 1 }));
          grid.append(inputRow('朝向（度）', 'headingDeg', area.headingDeg, { min: 0, max: 359, step: 1 }));
        }
        if (area.shape === 'rectangle') {
          grid.append(inputRow('长度（米）', 'length', area.length, { min: 1, step: 1 }));
          grid.append(inputRow('宽度（米）', 'width', area.width, { min: 1, step: 1 }));
          grid.append(inputRow('朝向（度）', 'headingDeg', area.headingDeg, { min: 0, max: 359, step: 1 }));
        }
        grid.append(inputRow('透明度', 'opacity', area.opacity, { min: 0.05, max: 0.55, step: 0.01 }));
        section.append(grid);

        const anchorField = createElement(documentNode, 'label', 'field');
        anchorField.append(createElement(documentNode, 'span', '', '绑定对象'));
        const select = documentNode.createElement('select');
        select.name = 'anchor';
        const free = documentNode.createElement('option'); free.value = ''; free.textContent = '自由放置'; select.append(free);
        for (const marker of api.getState()?.markers || []) {
          const option = documentNode.createElement('option'); option.value = `marker:${marker.id}`; option.textContent = `标记 · ${marker.name || marker.id}`; select.append(option);
        }
        for (const token of api.tokens?.list?.() || []) {
          const option = documentNode.createElement('option'); option.value = `token:${token.id}`; option.textContent = `Token · ${actorName(token)}`; select.append(option);
        }
        select.value = area.anchor?.type === 'token'
          ? `token:${area.anchor.tokenId}`
          : area.anchor?.type === 'marker' ? `marker:${area.anchor.markerId}` : '';
        anchorField.append(select);
        section.append(anchorField);

        const checks = createElement(documentNode, 'div', 'category-grid');
        for (const [key, label] of [
          ['visible', '显示范围'],
          ['destructionEnabled', '启用场景破坏'],
          ['severeDamage', '严重破坏'],
          ['craterEnabled', '形成弹坑'],
        ]) {
          const chip = createElement(documentNode, 'label', 'check-chip');
          const input = documentNode.createElement('input');
          input.type = 'checkbox'; input.name = key; input.checked = area[key] === true || (key === 'visible' && area.visible !== false);
          chip.append(input, documentNode.createTextNode(label));
          checks.append(chip);
        }
        section.append(checks);

        const actions = createElement(documentNode, 'div', 'button-row');
        for (const [action, label, className] of [
          ['preview', '预览影响', ''], ['apply', '应用破坏', 'danger'], ['duplicate', '复制', ''], ['delete', '删除', 'danger'],
        ]) {
          const button = createElement(documentNode, 'button', `small-button ${className}`.trim(), label);
          button.type = 'button'; button.dataset.areaAction = action; button.dataset.areaId = area.id;
          if (action === 'apply') button.disabled = !preview || preview.areaId !== area.id;
          actions.append(button);
        }
        section.append(actions);
        if (preview?.areaId === area.id) {
          const hits = (preview.objectIds?.length || 0) + (preview.clipHits?.length || 0);
          section.append(createElement(documentNode, 'p', 'preview-summary', `预计影响 ${hits} 个 Feature${preview.craterPolygon ? '，并形成弹坑' : ''}`));
        }
        return section;
      }

      function renderPanel() {
        if (!panel || destroyed) return;
        panel.replaceChildren();
        const create = createElement(documentNode, 'div', 'section');
        create.append(createElement(documentNode, 'h2', '', '范围 / 场景破坏'));
        create.append(createElement(documentNode, 'p', '', '选择形状后点击地图放置；范围可绑定 Marker 或 Scene Token。'));
        const row = createElement(documentNode, 'div', 'button-row');
        for (const [shape, label] of [['circle', '圆形'], ['sector', '扇形'], ['rectangle', '矩形']]) {
          const button = createElement(documentNode, 'button', 'small-button', label);
          button.type = 'button'; button.dataset.newAreaShape = shape; row.append(button);
        }
        create.append(row);
        panel.append(create);
        const area = selected();
        if (area) panel.append(renderEditor(area));
        const list = createElement(documentNode, 'div', 'section');
        list.append(createElement(documentNode, 'h2', '', `已保存范围 · ${areas().length}`));
        for (const item of areas()) {
          const button = createElement(documentNode, 'button', `occupant-button${String(item.id) === String(selectedAreaId) ? ' selected' : ''}`, item.name || item.id);
          button.type = 'button'; button.dataset.selectArea = item.id; list.append(button);
        }
        if (!areas().length) list.append(createElement(documentNode, 'div', 'empty-state compact', '暂无范围'));
        panel.append(list);
      }

      function render() { renderLayers(); renderPanel(); }

      async function beginPlacement(shape = 'circle') {
        placingShape = ['circle', 'sector', 'rectangle'].includes(shape) ? shape : 'circle';
        preview = null;
        api.setTool?.('aoe');
        api.setActivePanel?.('areas');
        status('范围放置：点击地图设置起点；Esc 取消');
        renderPanel();
        return true;
      }

      async function previewArea(areaId = selectedAreaId) {
        const area = areas().find(item => String(item.id) === String(areaId));
        if (!area) return null;
        const categories = area.destructionEnabled ? (area.destructionTargets || []) : [];
        const resolved = { ...resolvedArea(area), destructionTargets: categories, severeDamage: area.destructionEnabled && area.severeDamage };
        preview = createDamagePreview(resolved, api.mapPackage.features || [], categories);
        preview.areaId = area.id;
        renderPanel();
        api.emit?.('scene:preview', clone(preview));
        return preview;
      }

      async function applyArea(areaId = selectedAreaId) {
        const area = areas().find(item => String(item.id) === String(areaId));
        if (!area || !preview || String(preview.areaId) !== String(area.id)) return false;
        const categories = area.destructionEnabled ? (area.destructionTargets || []) : [];
        const resolved = { ...resolvedArea(area), destructionTargets: categories, severeDamage: area.destructionEnabled && area.severeDamage };
        const current = createDamagePreview(resolved, api.mapPackage.features || [], categories);
        if (current.signature !== preview.signature) {
          preview = null;
          renderPanel();
          status('范围参数已变化，请重新预览');
          return false;
        }
        const next = commitDamageEvent(api.getState(), resolved, current);
        if (next === api.getState()) return false;
        await Promise.resolve(api.commitState(next, { source: 'scene-area:damage', render: true }));
        preview = null;
        render();
        api.emit?.('scene:damage', clone(api.getState().sceneEvents?.at?.(-1) || null));
        status('场景破坏已应用');
        return true;
      }

      async function removeArea(areaId) {
        const next = areas().filter(area => String(area.id) !== String(areaId));
        if (next.length === areas().length) return false;
        if (String(selectedAreaId) === String(areaId)) selectedAreaId = next[0]?.id || null;
        preview = null;
        await commitAreas(next, 'scene-area:delete');
        render();
        return true;
      }

      panel?.addEventListener('click', event => {
        const newButton = event.target.closest?.('[data-new-area-shape]');
        if (newButton) { void beginPlacement(newButton.dataset.newAreaShape); return; }
        const selectButton = event.target.closest?.('[data-select-area]');
        if (selectButton) { selectedAreaId = selectButton.dataset.selectArea; preview = null; render(); return; }
        const action = event.target.closest?.('[data-area-action]');
        if (!action) return;
        const areaId = action.dataset.areaId;
        if (action.dataset.areaAction === 'preview') void previewArea(areaId);
        else if (action.dataset.areaAction === 'apply') void applyArea(areaId);
        else if (action.dataset.areaAction === 'delete') void removeArea(areaId);
        else if (action.dataset.areaAction === 'duplicate') {
          const source = areas().find(area => String(area.id) === String(areaId));
          if (!source) return;
          const copy = clone(source); copy.id = uid('area'); copy.name = `${source.name || '范围'} 副本`.slice(0, 80); copy.anchor = { type: 'free', markerId: null };
          const origin = resolvedOrigin(source); copy.origin = { x: origin.x + 20, y: origin.y + 20 };
          const next = [...clone(areas()), copy]; selectedAreaId = copy.id; preview = null;
          void commitAreas(next, 'scene-area:duplicate').then(render);
        }
      });

      panel?.addEventListener('change', event => {
        const area = selected();
        if (!area) return;
        const target = event.target;
        if (!target.name) return;
        if (target.name === 'anchor') {
          const [type, value] = String(target.value || '').split(':');
          const anchor = type === 'token' ? { type: 'token', tokenId: value }
            : type === 'marker' ? { type: 'marker', markerId: value }
              : { type: 'free', markerId: null };
          void patchArea(area.id, { anchor, origin: resolvedOrigin(area) });
          return;
        }
        if (['visible', 'destructionEnabled', 'severeDamage', 'craterEnabled'].includes(target.name)) {
          void patchArea(area.id, { [target.name]: target.checked });
          return;
        }
        const numeric = ['radius', 'range', 'angleDeg', 'length', 'width', 'headingDeg', 'opacity'];
        if (numeric.includes(target.name)) {
          const value = Number(target.value);
          if (Number.isFinite(value)) void patchArea(area.id, { [target.name]: value });
          return;
        }
        if (target.name === 'name') void patchArea(area.id, { name: String(target.value || '').trim().slice(0, 80) || area.name });
      });

      const mapClick = event => {
        if (api.getTool?.() !== 'aoe' || !placingShape) return;
        const point = { x: Number(event.latlng.lng), y: Number(api.mapPackage.height - event.latlng.lat) };
        if (point.x < 0 || point.y < 0 || point.x > api.mapPackage.width || point.y > api.mapPackage.height) return;
        const next = clone(areas());
        const area = defaultArea(placingShape, point, next.length);
        next.push(area);
        selectedAreaId = area.id;
        placingShape = null;
        void commitAreas(next, 'scene-area:create').then(() => {
          api.setTool?.('pan');
          render();
          status('范围已放置');
          api.emit?.('area:create', clone(area));
        });
      };
      api.map.on('click', mapClick);

      const keydown = event => {
        if (event.key !== 'Escape' || !placingShape) return;
        placingShape = null;
        api.setTool?.('pan');
        status('范围放置已取消');
      };
      documentNode.addEventListener('keydown', keydown);

      for (const name of ['state:commit', 'state:import', 'token:move', 'token:delete', 'marker:move', 'marker:delete']) {
        off.push(api.on?.(name, render));
      }
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        api.map.off('click', mapClick);
        documentNode.removeEventListener('keydown', keydown);
        layer.clearLayers();
        api.map.removeLayer?.(layer);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.sceneAreas = Object.freeze({
        canonicalTokenAnchors: true,
        beginPlacement,
        preview: previewArea,
        apply: applyArea,
        select(areaId) { selectedAreaId = areaId; preview = null; render(); return selected(); },
        list() { return clone(areas()); },
        getSelected() { return clone(selected()); },
        render,
      });
      render();
    },
  });
}
