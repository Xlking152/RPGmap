import { latLngToWorld, worldToLatLng, pointInPolygon, featureToPolygon } from '../engine/geometry.js';
import { normalizeOcclusionShape } from '../vision/occlusion-model.js';
import { createOcclusionDraft } from './occlusion-draft.js';
import { availableOcclusionHostIds, featureForOcclusionDoor } from '../world/occlusion-config.js';
import { effectiveFeatureOpen } from '../world/feature-states.js';

const STYLE_ID = 'rpgmap-occlusion-editor-style';
const clone = structuredClone;

function editable(api) {
  const status = api.multiplayer?.getStatus?.();
  const capabilities = api.multiplayer?.getCapabilities?.();
  return !status?.connected || capabilities?.role === 'gm' || capabilities?.canManageStructure === true;
}

function element(doc, tag, text, attrs = {}) {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = String(text);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function styles(doc) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = element(doc, 'style');
  style.id = STYLE_ID;
  style.textContent = `
    .occlusion-editor{position:fixed;right:18px;top:72px;z-index:1800;width:340px;max-height:calc(100vh - 94px);overflow:auto;background:#fff;color:#253b3e;border:1px solid #6d8b8d;border-radius:10px;box-shadow:0 8px 30px #0005;padding:14px;display:grid;gap:10px}
    .occlusion-editor h2,.occlusion-editor p{margin:0}.occlusion-editor h2{font-size:16px}.occlusion-editor p{font-size:12px;line-height:1.5;color:#53676a}
    .occlusion-editor .occlusion-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.occlusion-editor label{display:grid;gap:4px;font-size:12px}.occlusion-editor select,.occlusion-editor input{min-height:30px;max-width:100%;padding:4px}
    .occlusion-editor .occlusion-list{max-height:150px;overflow:auto;display:grid;gap:4px}.occlusion-editor .occlusion-list button{text-align:left}.occlusion-editor button.active{background:#176d76;color:white}.occlusion-editor .occlusion-status{padding:8px;background:#edf4f2;font-size:12px}
    .occlusion-vertex{background:#fff!important;border:2px solid #d56329!important;border-radius:50%!important}.occlusion-door-control{background:#fff!important;border:2px solid #176d76!important;border-radius:4px!important;display:grid!important;place-items:center!important;font-size:13px}
    @media(max-width:760px){.occlusion-editor{right:6px;top:58px;width:280px;max-height:calc(100vh - 76px)}}
  `;
  doc.head.append(style);
}

/** GM authoring lives in a local draft; only Apply sends an authority operation. */
export function createOcclusionEditor(api) {
  const doc = api.map?.getContainer?.()?.ownerDocument;
  if (!doc) return null;
  styles(doc);
  let L = null, draft = null, panel = null, layer = null, doorLayer = null;
  let mode = 'select', points = [], selectedShapeId = null, transientShape = null;
  let boxStart = null, boxLayer = null, committing = false, destroyed = false;
  let previousTool = 'pan', draggingBeforeBox = false, doorGeneration = 0;
  const off = [];
  const scene = () => {
    const world = api.getState?.()?.preferences?.worldV2;
    return world?.scenes?.find(item => String(item.id) === String(world.activeSceneId)) || null;
  };
  const features = () => api.mapPackage.features || [];
  const shapeValues = () => {
    const values = new Map((api.mapPackage.occlusionShapes || []).map(shape => [String(shape.id), shape]));
    for (const shape of draft?.configuration.occlusionShapes || scene()?.occlusionShapes || []) values.set(shape.id, shape);
    return [...values.values()].filter(shape => shape.enabled !== false);
  };
  const hostEntries = () => {
    const valid = availableOcclusionHostIds(api.mapPackage, scene(), draft?.configuration);
    const entries = [
      ...shapeValues().filter(shape => shape.kind !== 'door' && valid.has(String(shape.id)))
        .map(shape => [shape.id, `${shape.kind === 'wall' ? '墙' : '建筑'} · ${shape.id}`]),
      ...features().filter(feature => valid.has(String(feature.id)))
        .map(feature => [feature.id, feature.name || feature.id]),
    ];
    return [...new Map(entries).entries()];
  };
  const notifyPreview = () => api.emit?.('occlusion:preview', { active: Boolean(draft), sceneId: draft?.sceneId || null });
  const report = error => api.showToast?.(error?.message || String(error), 'error');
  const refresh = () => { draw(); renderPanel(); notifyPreview(); };
  const button = (label, action, attrs = {}) => {
    const node = element(doc, 'button', label, { type: 'button', class: 'small-button', ...attrs });
    node.addEventListener('click', event => {
      event.preventDefault();
      try { const result = action(); if (result?.catch) result.catch(report); } catch (error) { report(error); }
    });
    return node;
  };
  const row = (...nodes) => { const host = element(doc, 'div', null, { class: 'occlusion-row' }); host.append(...nodes); return host; };
  const select = (entries, value) => {
    const node = element(doc, 'select');
    for (const [id, label] of entries) node.append(element(doc, 'option', label, { value: id }));
    node.value = String(value ?? ''); return node;
  };
  const label = (text, node) => { const host = element(doc, 'label', text); host.append(node); return host; };
  const latlngs = polygon => polygon.map(([x, y]) => worldToLatLng({ x, y }, api.mapPackage.height));

  function selectMode(next) {
    points = []; transientShape = null; boxStart = null; mode = next;
    refresh();
  }

  function draw() {
    if (!layer || !draft) return;
    layer.clearLayers();
    for (const featureId of draft.selectedFeatureIds) {
      const feature = features().find(item => String(item.id) === featureId);
      const polygon = feature && featureToPolygon(feature);
      if (polygon?.length) L.polygon(latlngs(polygon), { pane: 'occlusionEditPane', color: '#176d76',
        weight: 3, fillOpacity: .12, interactive: false }).addTo(layer);
    }
    for (const shape of shapeValues()) {
      const selected = shape.id === selectedShapeId;
      const preview = transientShape?.id === shape.id ? transientShape : shape;
      const polygon = L.polygon(latlngs(preview.points), { pane: 'occlusionEditPane',
        color: shape.kind === 'door' ? '#288c62' : selected ? '#d56329' : '#607176',
        weight: selected ? 3 : 2, fillOpacity: selected ? .15 : .06, dashArray: '6 4',
        interactive: mode === 'select' }).addTo(layer);
      polygon.on('click', event => {
        L.DomEvent.stopPropagation(event.originalEvent);
        if (shape.featureId) draft.selectFeatures([shape.featureId]);
        selectedShapeId = shape.id; points = []; refresh();
      });
      if (!selected || mode !== 'select') continue;
      preview.points.forEach((point, index) => {
        const marker = L.marker(worldToLatLng({ x: point[0], y: point[1] }, api.mapPackage.height), {
          pane: 'occlusionEditPane', draggable: true, keyboard: false,
          icon: L.divIcon({ className: 'occlusion-vertex', iconSize: [12, 12], iconAnchor: [6, 6] }) }).addTo(layer);
        marker.on('drag', () => {
          const nextPoints = clone(shape.points);
          const next = latLngToWorld(marker.getLatLng(), api.mapPackage.height);
          nextPoints[index] = [next.x, next.y];
          try {
            transientShape = normalizeOcclusionShape({ ...shape, points: nextPoints });
            polygon.setLatLngs(latlngs(nextPoints)); notifyPreview();
          } catch { transientShape = null; }
        });
        marker.on('dragend', () => {
          try {
            const nextPoints = clone(shape.points);
            const next = latLngToWorld(marker.getLatLng(), api.mapPackage.height);
            nextPoints[index] = [next.x, next.y];
            draft.upsertShape({ ...shape, points: nextPoints });
          } catch (error) { report(error); }
          transientShape = null; refresh();
        });
      });
    }
    if (points.length) L.polyline(latlngs(points), { pane: 'occlusionEditPane', color: '#d56329', weight: 3, interactive: false }).addTo(layer);
  }

  function finishPolygon() {
    if (points.length < 3) throw new Error('至少绘制三个顶点，然后完成多边形');
    const kind = mode;
    if (!['building', 'wall', 'door'].includes(kind)) return;
    const id = `occlusion-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)}`;
    const hostId = panel.querySelector('[data-occlusion-host]')?.value || null;
    const featureId = panel.querySelector('[data-occlusion-binding]')?.value || null;
    draft.upsertShape({ id, kind, points, hostShapeId: kind === 'door' ? hostId : null,
      featureId, blockingHeightMeters: null, enabled: true });
    selectedShapeId = id; mode = 'select'; points = []; refresh();
  }

  function renderPanel() {
    if (!panel || !draft) return;
    panel.replaceChildren();
    panel.append(element(doc, 'h2', '遮挡编辑'), element(doc, 'p', '点选物体，Shift 多选；框选后批量设置遮挡。手绘轮廓可绑定物体替代其默认轮廓。草稿仅在本机预览，点击提交后同步。'));
    const modes = [['select', '点选'], ['box', '框选'], ['building', '建筑'], ['wall', '墙'], ['door', '门']];
    panel.append(row(...modes.map(([id, text]) => button(text, () => selectMode(id), { class: `small-button${mode === id ? ' active' : ''}`, 'data-occlusion-mode': id }))));
    const targetIds = draft.selectedFeatureIds;
    const visionTags = draft.configuration.featureVision;
    const selectedTags = targetIds.map(id => visionTags[id]?.occluder ?? 'inherit');
    const selectedHeights = targetIds.map(id => visionTags[id]?.blockingHeightMeters ?? 'inherit');
    const sameValue = values => !values.length ? 'inherit' : values.every(value => value === values[0]) ? values[0] : 'preserve';
    const currentTag = sameValue(selectedTags), currentHeight = sameValue(selectedHeights);
    const tag = select([...(currentTag === 'preserve' ? [['preserve', '混合设置（保持各自 Tag）']] : []),
      ['inherit', '继承地图默认'], ['true', '遮挡视线'], ['false', '透视（不遮挡）']], String(currentTag));
    const height = element(doc, 'input', null, { type: 'number', min: '0', step: '.5', placeholder: '米' });
    const heightMode = select([...(currentHeight === 'preserve' ? [['preserve', '保持各自高度']] : []),
      ['inherit', '继承高度'], ['unbounded', '无限高度'], ['finite', '指定高度']], typeof currentHeight === 'number' ? 'finite' : currentHeight);
    if (typeof currentHeight === 'number') height.value = String(currentHeight);
    height.hidden = heightMode.value !== 'finite'; heightMode.addEventListener('change', () => { height.hidden = heightMode.value !== 'finite'; });
    panel.append(element(doc, 'div', `已选 ${targetIds.length} 个地图物体`), label('遮挡 Tag', tag), row(label('高度', heightMode), height),
      button('应用到所选物体', () => {
        if (!targetIds.length) throw new Error('请先点选或框选地图物体');
        const raw = heightMode.value === 'finite' ? Number(height.value) : heightMode.value;
        if (heightMode.value === 'finite' && (!height.value || !Number.isFinite(raw) || raw < 0)) throw new Error('请输入非负米制高度');
        draft.setFeatureVision(targetIds, { occluder: ['inherit', 'preserve'].includes(tag.value) ? tag.value : tag.value === 'true', blockingHeightMeters: raw }); refresh();
      }, { disabled: targetIds.length ? '' : 'disabled' }));
    // HTML boolean attributes must be absent, rather than an empty string, when enabled.
    if (targetIds.length) panel.lastElementChild.removeAttribute('disabled');
    if (['building', 'wall', 'door'].includes(mode)) {
      const binding = select([['', '独立遮挡（不绑定物体）'], ...features().map(feature => [feature.id, feature.name || feature.id])], targetIds.length === 1 ? targetIds[0] : '');
      binding.dataset.occlusionBinding = '';
      panel.append(label('绑定地图物体', binding));
      if (mode === 'door') {
        const host = select([['', '请选择宿主墙或建筑'], ...hostEntries()], ''); host.dataset.occlusionHost = '';
        panel.append(label('门所在的墙或建筑', host));
      }
      panel.append(element(doc, 'p', `已绘制 ${points.length} 个顶点；单击地图增加顶点，双击或按完成结束。门轮廓须横穿宿主墙或建筑的完整厚度。`),
        row(button('完成多边形', finishPolygon), button('取消绘制', () => selectMode('select'))));
    }
    const list = element(doc, 'div', null, { class: 'occlusion-list' });
    for (const shape of shapeValues()) list.append(button(`${shape.kind === 'door' ? '门' : shape.kind === 'wall' ? '墙' : '建筑'} · ${shape.featureId || shape.id}`, () => { selectedShapeId = shape.id; mode = 'select'; refresh(); },
      { class: `small-button${selectedShapeId === shape.id ? ' active' : ''}`, 'data-occlusion-shape': shape.id }));
    panel.append(list);
    const shape = shapeValues().find(item => item.id === selectedShapeId);
    if (shape && mode === 'select') {
      const bound = select([['', '独立遮挡'], ...features().map(feature => [feature.id, feature.name || feature.id])], shape.featureId || '');
      const shapeHeight = element(doc, 'input', null, { type: 'number', min: '0', step: '.5', placeholder: '留空：无限高度' });
      shapeHeight.value = shape.blockingHeightMeters == null ? '' : String(shape.blockingHeightMeters);
      const host = shape.kind === 'door' ? select([['', '请选择宿主墙或建筑'], ...hostEntries()], shape.hostShapeId || '') : null;
      panel.append(label('选中轮廓绑定', bound), label('遮挡高度（米）', shapeHeight));
      if (host) panel.append(label('门宿主', host));
      panel.append(row(button('更新轮廓属性', () => { draft.upsertShape({ ...shape, featureId: bound.value || null,
        hostShapeId: host?.value || null, blockingHeightMeters: shapeHeight.value === '' ? null : Number(shapeHeight.value) }); refresh(); }),
        button('删除轮廓及其门', () => { draft.deleteShape(shape.id); selectedShapeId = null; refresh(); })));
    }
    panel.append(row(button('撤销草稿', () => { draft.undo(); refresh(); }, { 'data-occlusion-undo': '' }),
      button('重做草稿', () => { draft.redo(); refresh(); }, { 'data-occlusion-redo': '' }), button('恢复地图默认', () => { draft.resetDefaults(); selectedShapeId = null; refresh(); })));
    panel.querySelector('[data-occlusion-undo]').disabled = !draft.canUndo;
    panel.querySelector('[data-occlusion-redo]').disabled = !draft.canRedo;
    const input = element(doc, 'input', null, { type: 'file', accept: '.json,application/json', hidden: 'hidden' });
    input.addEventListener('change', async () => {
      try { if (input.files?.[0]) { draft.importConfiguration(JSON.parse(await input.files[0].text())); selectedShapeId = null; refresh(); } } catch (error) { report(error); }
    });
    panel.append(input, row(button('导入遮挡配置', () => input.click()), button('导出草稿配置', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(draft.configuration, null, 2)], { type: 'application/json' }));
      const link = element(doc, 'a', null, { href: url, download: `${draft.configuration.map.id}-occlusion.json` });
      doc.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    })));
    panel.append(element(doc, 'div', committing ? '正在提交…' : draft.dirty ? '草稿尚未提交，关闭将丢弃修改。' : '与已保存配置一致。', { class: 'occlusion-status', role: 'status' }),
      row(button('提交并同步', commit, { 'data-occlusion-apply': '' }), button('关闭编辑', close)));
    panel.querySelector('[data-occlusion-apply]').disabled = committing || !draft.dirty;
  }

  async function commit() {
    if (!draft || !editable(api)) throw new Error('只有 GM 可以提交遮挡配置');
    const submittedDraft = draft;
    committing = true; renderPanel();
    try {
      await api.world.performOperations(submittedDraft.commitOperations(), { source: 'occlusion:configure' });
      if (draft === submittedDraft) {
        submittedDraft.markCommitted(scene());
        api.showToast?.('遮挡配置已保存并同步', 'success');
      }
    } finally { committing = false; refresh(); syncDoors(); }
  }

  async function open() {
    if (!editable(api)) throw new Error('只有 GM 可以编辑遮挡配置');
    if (draft) return;
    L ||= (await import('leaflet')).default;
    if (destroyed) return;
    const current = scene();
    if (!current) throw new Error('当前场景不可用');
    draft = createOcclusionDraft(api.mapPackage, current);
    previousTool = api.getTool?.() || 'pan'; api.setTool?.('occlusion');
    const pane = api.map.getPane('occlusionEditPane') || api.map.createPane('occlusionEditPane');
    pane.style.zIndex = '670';
    layer = L.layerGroup().addTo(api.map);
    panel = element(doc, 'section', null, { class: 'occlusion-editor', 'aria-label': '遮挡编辑', 'data-occlusion-editor': '' });
    doc.body.append(panel); mode = 'select'; selectedShapeId = null; points = [];
    const selected = api.getSelectedFeatureId?.(); if (selected) draft.selectFeature(selected);
    refresh(); void syncDoors();
  }

  function close() {
    if (!draft) return;
    draft = null; transientShape = null; points = []; selectedShapeId = null;
    boxStart = null; boxLayer = null;
    if (draggingBeforeBox) api.map.dragging?.enable(); draggingBeforeBox = false;
    layer?.remove(); layer = null; panel?.remove(); panel = null;
    api.setTool?.(previousTool); notifyPreview(); if (!destroyed) void syncDoors();
  }

  function mapClick(event) {
    if (!draft || committing || !editable(api)) return;
    if (event.originalEvent?.target?.closest?.('.leaflet-marker-icon,.leaflet-control')) return;
    const point = latLngToWorld(event.latlng, api.mapPackage.height);
    if (['building', 'wall', 'door'].includes(mode)) {
      const previous = points.at(-1);
      if (!previous || Math.hypot(previous[0] - point.x, previous[1] - point.y) > 1e-7) points.push([point.x, point.y]);
      // Preserve the binding/host selections while adding vertices.
      const binding = panel.querySelector('[data-occlusion-binding]')?.value;
      const host = panel.querySelector('[data-occlusion-host]')?.value;
      draw(); renderPanel();
      if (binding != null) panel.querySelector('[data-occlusion-binding]').value = binding;
      if (host != null) panel.querySelector('[data-occlusion-host]').value = host;
    } else if (mode === 'select') {
      const feature = [...features()].reverse().find(item => {
        try { const polygon = featureToPolygon(item); return polygon?.length && pointInPolygon([point.x, point.y], polygon); } catch { return false; }
      });
      if (feature) { draft.selectFeature(feature.id, event.originalEvent?.shiftKey === true); selectedShapeId = null; refresh(); }
    }
  }

  function mouseDown(event) {
    if (!draft || mode !== 'box' || committing) return;
    boxStart = latLngToWorld(event.latlng, api.mapPackage.height);
    draggingBeforeBox = api.map.dragging?.enabled?.() === true;
    api.map.dragging?.disable();
  }
  function mouseMove(event) {
    if (!boxStart || !draft) return;
    const point = latLngToWorld(event.latlng, api.mapPackage.height);
    boxLayer?.remove();
    boxLayer = L.rectangle([worldToLatLng(boxStart, api.mapPackage.height), worldToLatLng(point, api.mapPackage.height)],
      { pane: 'occlusionEditPane', color: '#176d76', fillOpacity: .1, weight: 2, interactive: false }).addTo(layer);
  }
  function mouseUp(event) {
    if (!boxStart || !draft) return;
    const point = latLngToWorld(event.latlng, api.mapPackage.height);
    const left = Math.min(boxStart.x, point.x), right = Math.max(boxStart.x, point.x);
    const top = Math.min(boxStart.y, point.y), bottom = Math.max(boxStart.y, point.y);
    draft.selectFeatures(features().filter(feature => {
      try {
        const polygon = featureToPolygon(feature);
        return polygon?.length && Math.min(...polygon.map(p => p[0])) <= right && Math.max(...polygon.map(p => p[0])) >= left
          && Math.min(...polygon.map(p => p[1])) <= bottom && Math.max(...polygon.map(p => p[1])) >= top;
      } catch { return false; }
    }).map(feature => feature.id));
    boxStart = null; boxLayer = null;
    if (draggingBeforeBox) api.map.dragging?.enable(); draggingBeforeBox = false;
    refresh();
  }

  async function syncDoors() {
    if (destroyed) return;
    const generation = ++doorGeneration;
    const current = scene();
    if (!current) return;
    const doors = shapeValues().filter(shape => shape.kind === 'door');
    if (!doors.length && !doorLayer) return;
    L ||= (await import('leaflet')).default;
    if (destroyed || generation !== doorGeneration || String(scene()?.id) !== String(current.id)) return;
    doorLayer ||= L.layerGroup().addTo(api.map); doorLayer.clearLayers();
    if (draft) return;
    for (const shape of doors) {
      const featureId = shape.featureId || shape.id;
      const feature = featureForOcclusionDoor(api.mapPackage, current, featureId);
      if (!feature) continue;
      const openState = effectiveFeatureOpen(current.featureStates?.[featureId], feature);
      const control = L.marker(worldToLatLng({ x: feature.center[0], y: feature.center[1] }, api.mapPackage.height), {
        pane: 'handlePane', keyboard: true, title: openState ? '关闭门' : '打开门',
        icon: L.divIcon({ className: 'occlusion-door-control', html: openState ? '↔' : '▣', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(doorLayer);
      control.on('click', () => {
        const tokenId = api.selection?.getPrimaryTokenId?.() || null;
        api.world.performOperations([{ type: 'scene.door.use', payload: { sceneId: current.id, featureId, tokenId,
          action: openState ? 'close' : 'open' } }], { source: 'occlusion:door' }).catch(report);
      });
    }
  }

  api.map.on('click', mapClick);
  api.map.on('mousedown', mouseDown); api.map.on('mousemove', mouseMove); api.map.on('mouseup', mouseUp);
  const doubleClick = () => { if (draft && ['building', 'wall', 'door'].includes(mode)) { try { finishPolygon(); } catch (error) { report(error); } } };
  api.map.on('dblclick', doubleClick);
  const documentMouseUp = event => {
    if (boxStart && draft && api.map.mouseEventToLatLng) mouseUp({ latlng: api.map.mouseEventToLatLng(event) });
  };
  const keyDown = event => {
    if (!draft || committing || event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
    if (event.key === 'Escape') { event.preventDefault(); points.length ? selectMode('select') : close(); }
    else if (event.key === 'Enter' && ['building', 'wall', 'door'].includes(mode)) {
      event.preventDefault(); try { finishPolygon(); } catch (error) { report(error); }
    } else if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.key.toLowerCase() === 'y' || event.shiftKey ? draft.redo() : draft.undo(); refresh();
    }
  };
  doc.addEventListener('mouseup', documentMouseUp); doc.addEventListener('keydown', keyDown);
  off.push(api.on?.('state:patch', event => {
    const changes = event.detail?.changeSet;
    if (!changes || changes.featureStates?.length || changes.scenes?.activeSceneChanged
      || changes.scenes?.upsertIds?.length || changes.sceneContent?.some(entry => entry.types.includes('OcclusionShape'))) void syncDoors();
  }));
  off.push(api.on?.('state:commit', event => {
    if (/occlusion|feature|door|import|scene/i.test(String(event.detail?.source || ''))) void syncDoors();
  }));
  off.push(api.on?.('feature:state-change', () => { void syncDoors(); }));
  off.push(api.on?.('scene:content-change', event => {
    if (event.detail?.types?.includes('OcclusionShape')) void syncDoors();
  }));
  for (const name of ['scene:activate', 'state:import']) off.push(api.on?.(name, () => { close(); void syncDoors(); }));
  off.push(api.on?.('multiplayer:capabilities', () => { if (draft && !editable(api)) close(); void syncDoors(); }));
  off.push(api.on?.('app:destroy', () => {
    destroyed = true; close(); doorLayer?.remove();
    api.map.off('click', mapClick); api.map.off('mousedown', mouseDown); api.map.off('mousemove', mouseMove); api.map.off('mouseup', mouseUp); api.map.off('dblclick', doubleClick);
    doc.removeEventListener('mouseup', documentMouseUp); doc.removeEventListener('keydown', keyDown);
    off.forEach(dispose => dispose?.());
  }));
  const editor = {
    open, close, commit, get active() { return Boolean(draft); }, canEdit: () => editable(api),
    getPreviewScene(authoritativeScene) {
      if (!draft || !editable(api) || String(authoritativeScene?.id) !== draft.sceneId) return authoritativeScene;
      const preview = draft.previewScene(authoritativeScene);
      if (transientShape) {
        const values = new Map(preview.occlusionShapes.map(shape => [shape.id, shape])); values.set(transientShape.id, transientShape);
        preview.occlusionShapes = [...values.values()];
      }
      return preview;
    },
  };
  api.occlusionEditor = editor;
  void syncDoors();
  return editor;
}
