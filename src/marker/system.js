import L from 'leaflet';
import { latLngToWorld, worldToLatLng } from '../engine/geometry.js';
import { resolveStatusUiSnapshot } from '../status/ui.js';

const MARKER_PANE = 'lightweightMarkerPane';
const STYLE_ID = 'rpgmap-lightweight-marker-style';
const KINDS = Object.freeze({ trap: '陷阱', target: '目标点', area: '区域', note: '注释' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .lightweight-marker-icon { background:transparent!important; border:0!important; }
    .lightweight-marker-core { width:24px; height:24px; display:grid; place-items:center; border:2px solid #fff; border-radius:50%; background:var(--marker-color,#b94b42); color:#fff; box-shadow:0 2px 8px rgba(0,0,0,.34); font:850 11px/1 sans-serif; }
    .lightweight-marker-core[data-kind="area"] { border-radius:5px; }
    .lightweight-marker-core[data-kind="trap"] { clip-path:polygon(50% 0,100% 100%,0 100%); border-radius:0; padding-top:5px; }
    .marker-panel { display:grid; gap:10px; padding:10px; }
    .marker-form,.marker-list-item { display:grid; gap:8px; padding:10px; border:1px solid rgba(70,90,90,.18); border-radius:8px; background:#fff; }
    .marker-form label { display:grid; gap:4px; font-size:11px; color:#59676a; }
    .marker-form input,.marker-form select { width:100%; box-sizing:border-box; padding:7px; border:1px solid #cbd5d2; border-radius:6px; background:#fff; }
    .marker-actions { display:flex; flex-wrap:wrap; gap:6px; }
    .marker-template-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 8px; align-items:center; padding:7px 0; border-bottom:1px solid rgba(70,90,90,.14); }
    .marker-template-row strong,.marker-instance-row input[type="text"] { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .marker-template-row small { grid-column:1; color:#667477; }
    .marker-template-row .marker-actions { grid-column:2; grid-row:1/3; flex-wrap:nowrap; }
    .marker-instance-drawer { display:grid; gap:8px; border-left:3px solid #176d76; }
    .marker-instance-toolbar { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .marker-instance-row { display:grid; grid-template-columns:auto minmax(90px,1fr) 64px 64px; gap:6px; align-items:center; }
    .marker-instance-row input { width:100%; box-sizing:border-box; }
    .marker-instance-row small { grid-column:2/-1; color:#687477; }
  `;
  documentNode.head.append(style);
}

function markerCode(kind) {
  return ({ trap: '!', target: '+', area: 'A', note: 'i' })[kind] || 'i';
}

function markerId() {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `marker-${value}`;
}

function activeScene(api) {
  const world = api.world.get();
  return world.scenes?.find(scene => String(scene.id) === String(world.activeSceneId)) || null;
}

export function createLightweightMarkerSystem() {
  return Object.freeze({
    register(api) {
      const documentNode = api.map.getContainer().ownerDocument || document;
      const shell = api.map.getContainer().closest('.app-shell') || documentNode;
      const panel = api.uiPanels?.get?.('markers');
      installStyles(documentNode);
      const pane = api.map.getPane?.(MARKER_PANE) || api.map.createPane(MARKER_PANE);
      pane.style.zIndex = '512';
      const layer = L.layerGroup([], { pane: MARKER_PANE }).addTo(api.map);
      let pending = null;
      let selectedTemplateId = null;
      const selectedInstanceIds = new Set();

      function list() {
        return structuredClone(activeScene(api)?.markers || []);
      }

      async function perform(type, payload, source) {
        return api.world.performOperations([{ type, payload: { sceneId: api.world.get().activeSceneId, ...payload } }], {
          source, kind: 'marker', render: true,
        });
      }

      api.markers = {
        list,
        upsert(marker) { return perform('marker.upsert', { marker }, 'marker.upsert'); },
        move(id, point) { return perform('marker.move', { markerId: id, x: point.x, y: point.y }, 'marker.move'); },
        remove(id) { return perform('marker.delete', { markerId: id }, 'marker.delete'); },
      };

      function canControl(marker) {
        const status = api.multiplayer?.getStatus?.();
        if (!status?.connected || status.session?.role === 'gm') return true;
        return (marker.controllerUserIds || []).map(String).includes(String(status.session?.userId || ''));
      }

      function canControlToken(token) {
        const status = api.multiplayer?.getStatus?.();
        return !status?.connected || status.session?.role === 'gm'
          || api.multiplayer?.canControlToken?.(token.id) === true;
      }

      function actorTokens(actorId) {
        return (activeScene(api)?.tokens || []).filter(token => String(token.actorId) === String(actorId));
      }

      function healthForToken(tokenId) {
        try { return api.health?.resolveToken?.(tokenId) || null; }
        catch { return null; }
      }

      function renderInstanceDrawer(actor) {
        if (!actor) return '';
        const tokens = actorTokens(actor.id);
        const definitions = api.status?.getDefinitions?.() || [];
        const statusOptions = definitions.map(definition => `<option value="${escapeHtml(definition.id)}">${escapeHtml(definition.label || definition.name || definition.id)}</option>`).join('');
        const rows = tokens.map(token => {
          const health = healthForToken(token.id);
          const controlled = canControlToken(token);
          const statuses = resolveStatusUiSnapshot(api, { tokenId: token.id, actorId: token.actorId }).statuses
            .map(status => status.label || status.name || status.definitionId).join('、') || '无状态';
          return `<label class="marker-instance-row" data-marker-instance-row="${escapeHtml(token.id)}"><input type="checkbox" data-marker-instance-check value="${escapeHtml(token.id)}" ${selectedInstanceIds.has(String(token.id)) ? 'checked' : ''}><input type="text" maxlength="80" value="${escapeHtml(token.name || actor.name)}" data-marker-instance-name="${escapeHtml(token.id)}" ${controlled ? '' : 'disabled'}><input type="number" min="0" value="${escapeHtml(health?.current ?? 0)}" title="当前生命" data-marker-instance-health="current" data-token-id="${escapeHtml(token.id)}" ${controlled ? '' : 'disabled'}><input type="number" min="0" value="${escapeHtml(health?.max ?? 0)}" title="生命上限" data-marker-instance-health="max" data-token-id="${escapeHtml(token.id)}" ${controlled ? '' : 'disabled'}><small>${escapeHtml(statuses)} · ${token.actorLink === false ? '独立实例' : '旧共享 Token'}</small></label>`;
        }).join('');
        return `<section class="marker-form marker-instance-drawer" data-marker-instance-drawer><h2>${escapeHtml(actor.name)} · 当前 Scene 实例</h2><div class="marker-instance-toolbar"><button type="button" class="small-button" data-marker-instance-select-all ${tokens.length ? '' : 'disabled'}>全选</button><select data-marker-batch-status ${statusOptions ? '' : 'disabled'}>${statusOptions || '<option>无可用状态</option>'}</select><button type="button" class="small-button" data-marker-batch-status-action="apply" ${statusOptions ? '' : 'disabled'}>批量添加</button><button type="button" class="small-button" data-marker-batch-status-action="remove" ${statusOptions ? '' : 'disabled'}>批量移除</button></div>${rows || '<div class="ui-current-empty">当前 Scene 尚无该模板的 Token。</div>'}</section>`;
      }

      function renderMap() {
        layer.clearLayers();
        for (const marker of list()) {
          const color = /^#[0-9a-f]{6}$/i.test(String(marker.color || '')) ? marker.color : '#b94b42';
          const icon = L.divIcon({
            className: 'lightweight-marker-icon',
            html: `<span class="lightweight-marker-core" data-kind="${escapeHtml(marker.kind)}" style="--marker-color:${escapeHtml(color)}">${markerCode(marker.kind)}</span>`,
            iconSize: [24, 24], iconAnchor: [12, 12],
          });
          const view = L.marker(worldToLatLng(marker, api.mapPackage.height), {
            icon, pane: MARKER_PANE, keyboard: true, title: marker.name || KINDS[marker.kind] || 'Marker',
          }).addTo(layer);
          view.bindTooltip(marker.name || KINDS[marker.kind] || 'Marker', { direction: 'top', className: 'marker-tooltip' });
          view.on('click', event => {
            L.DomEvent.stopPropagation(event);
            api.setActivePanel?.('markers');
          });
        }
      }

      function renderPanel() {
        if (!panel) return;
        const capabilities = api.multiplayer?.getCapabilities?.() || { canPlaceMarker: () => true };
        const gm = !capabilities.connected || capabilities.role === 'gm';
        const allowedKinds = Object.entries(KINDS).filter(([kind]) => capabilities.canPlaceMarker?.(kind) !== false);
        const world = api.world.get();
        const actorTemplates = (world.actors || []).filter(actor => ['monster', 'npc', 'summon', 'other'].includes(String(actor.type)));
        const actorRows = actors => actors.map(actor => {
          const canPlace = capabilities.canPlaceActor?.(actor.id) !== false;
          const type = ({ monster: '怪物', npc: 'NPC', summon: '召唤物', other: '其他' })[actor.type] || '其他';
          const open = `<button type="button" class="small-button" data-marker-actor-open="${escapeHtml(actor.id)}">${actor.audienceRestricted === true ? '公开摘要' : '模板卡'}</button>`;
          return `<article class="marker-template-row"><strong>${escapeHtml(actor.name)}</strong><small>${escapeHtml(type)} · 独立实例 · ${actorTokens(actor.id).length} 个</small><div class="marker-actions">${open}${canPlace ? `<button type="button" class="small-button" data-marker-actor-place="${escapeHtml(actor.id)}">放置</button>` : ''}<button type="button" class="small-button" data-marker-actor-manage="${escapeHtml(actor.id)}">实例</button></div></article>`;
        }).join('') || '<div class="ui-current-empty">没有可用模板。</div>';
        const monsterRows = actorRows(actorTemplates.filter(actor => actor.type === 'monster'));
        const npcRows = actorRows(actorTemplates.filter(actor => actor.type === 'npc'));
        const otherTemplateRows = actorRows(actorTemplates.filter(actor => ['summon', 'other'].includes(String(actor.type))));
        const importButton = type => gm && api.entities?.canImportXlsx
          ? `<button type="button" class="small-button primary" data-marker-import-actor-type="${type}">导入 XLSX</button>`
          : '';
        const selectedTemplate = actorTemplates.find(actor => String(actor.id) === String(selectedTemplateId)) || null;
        const parties = [...new Set((world.actors || []).map(actor => String(actor.partyId || '')).filter(Boolean))].sort();
        const partyOptions = parties.map(partyId => `<option value="${escapeHtml(partyId)}">${escapeHtml(partyId)}</option>`).join('');
        const rows = list().map(marker => `<article class="marker-list-item"><strong>${escapeHtml(marker.name || KINDS[marker.kind])}</strong><small>${escapeHtml(KINDS[marker.kind] || marker.kind)} · ${escapeHtml(marker.visibility?.mode || 'public')} · ${Math.round(marker.x)}, ${Math.round(marker.y)}</small>${canControl(marker) ? `<div class="marker-actions"><button type="button" class="small-button" data-marker-move="${escapeHtml(marker.id)}">移动</button><button type="button" class="small-button danger" data-marker-delete="${escapeHtml(marker.id)}">删除</button></div>` : '<small>只读</small>'}</article>`).join('');
        const scene = activeScene(api);
        const lighting = ['normal', 'dim', 'dark'].includes(String(scene?.settings?.lighting)) ? scene.settings.lighting : 'normal';
        panel.innerHTML = `<div class="marker-panel"><form class="marker-form" data-marker-create>
          <h2>其他指示物</h2>
          <label>类别<select name="kind">${allowedKinds.map(([kind, label]) => `<option value="${kind}">${label}</option>`).join('')}</select></label>
          <label>名称<input name="name" maxlength="80" value="新指示物"></label>
          <label>可见性<select name="visibility"><option value="public">公开</option><option value="party">队伍</option>${gm ? '<option value="gm">仅 GM</option>' : ''}</select></label>
          <label>队伍<input name="partyId" maxlength="80" placeholder="party-default" ${gm ? '' : 'disabled'}></label>
          <div class="marker-actions"><button type="submit" class="small-button primary" ${allowedKinds.length ? '' : 'disabled'}>放置指示物</button></div>
        </form><section class="marker-form"><div class="marker-instance-toolbar"><h2>怪物</h2>${importButton('monster')}</div>${monsterRows}</section><section class="marker-form"><div class="marker-instance-toolbar"><h2>NPC</h2>${importButton('npc')}</div>${npcRows}</section><section class="marker-form"><h2>其他模板</h2>${otherTemplateRows}</section>${renderInstanceDrawer(selectedTemplate)}${gm ? `<section class="marker-form" data-fog-controls><h2>战争迷雾</h2><label>环境光<select data-scene-lighting><option value="normal" ${lighting === 'normal' ? 'selected' : ''}>正常</option><option value="dim" ${lighting === 'dim' ? 'selected' : ''}>昏暗</option><option value="dark" ${lighting === 'dark' ? 'selected' : ''}>黑暗</option></select></label><label>队伍<select name="partyId">${partyOptions}</select></label><label>重新隐藏半径<input name="radiusMeters" type="number" min="5" max="120" step="5" value="20"></label><div class="marker-actions"><button type="button" class="small-button" data-vision-full>全图视角</button><button type="button" class="small-button" data-fog-hide ${parties.length ? '' : 'disabled'}>重新隐藏</button><button type="button" class="small-button danger" data-fog-reset ${parties.length ? '' : 'disabled'}>重置探索</button></div></section>` : ''}${rows || '<div class="ui-current-empty">当前 Scene 没有可见指示物。</div>'}</div>`;
      }

      function beginPlacement(value) {
        pending = value;
        api.setTool?.('pan');
        api.showToast?.('点击地图确定指示物位置', 'info');
      }

      panel?.addEventListener('submit', event => {
        const form = event.target.closest('[data-marker-create]');
        if (!form) return;
        event.preventDefault();
        const data = new FormData(form);
        beginPlacement({
          type: 'create', id: markerId(), kind: String(data.get('kind') || 'note'),
          name: String(data.get('name') || '新指示物').trim().slice(0, 80),
          partyId: String(data.get('partyId') || '').trim().slice(0, 80) || null,
          visibility: { mode: String(data.get('visibility') || 'public'), userIds: [] },
          controllerUserIds: [], color: '#b94b42',
        });
      });
      panel?.addEventListener('click', async event => {
        const actorImport = event.target.closest('[data-marker-import-actor-type]');
        if (actorImport) { api.entities?.requestImport?.(actorImport.dataset.markerImportActorType); return; }
        const actorOpen = event.target.closest('[data-marker-actor-open]');
        if (actorOpen) { api.entities?.openActor?.(actorOpen.dataset.markerActorOpen); return; }
        const actorPlace = event.target.closest('[data-marker-actor-place]');
        if (actorPlace) { api.entities?.placeActor?.(actorPlace.dataset.markerActorPlace, { actorLink: false }); return; }
        const actorManage = event.target.closest('[data-marker-actor-manage]');
        if (actorManage) {
          selectedTemplateId = actorManage.dataset.markerActorManage;
          selectedInstanceIds.clear();
          renderPanel();
          return;
        }
        if (event.target.closest('[data-marker-instance-select-all]')) {
          const actor = api.world.get().actors.find(item => String(item.id) === String(selectedTemplateId));
          const ids = actor ? actorTokens(actor.id).map(token => String(token.id)) : [];
          const allSelected = ids.length && ids.every(id => selectedInstanceIds.has(id));
          selectedInstanceIds.clear();
          if (!allSelected) ids.forEach(id => selectedInstanceIds.add(id));
          renderPanel();
          return;
        }
        const batchAction = event.target.closest('[data-marker-batch-status-action]');
        if (batchAction) {
          const definitionId = panel.querySelector('[data-marker-batch-status]')?.value;
          const tokens = actorTokens(selectedTemplateId).filter(token => selectedInstanceIds.has(String(token.id)) && canControlToken(token));
          if (!tokens.length || !definitionId) {
            api.showToast?.('请先选择至少一个可控制实例和状态', 'error');
            return;
          }
          const type = batchAction.dataset.markerBatchStatusAction === 'remove' ? 'status.remove' : 'status.apply';
          try {
            await api.status.applyBatch(tokens.map(token => ({
              type,
              scope: token.actorLink === false ? 'syntheticActor' : 'token',
              targetId: token.id,
              definitionId,
              ...(type === 'status.apply' ? { stacks: 1 } : {}),
            })));
            api.showToast?.(`已批量${type === 'status.apply' ? '添加' : '移除'}状态`, 'success');
          } catch (error) {
            api.showToast?.(error.message, 'error');
          }
          return;
        }
        if (event.target.closest('[data-vision-full]')) {
          api.vision?.setSource?.(null).catch(error => api.showToast?.(error.message, 'error'));
        }
        const fogControls = event.target.closest('[data-fog-controls]');
        const fogReset = event.target.closest('[data-fog-reset]');
        if (fogReset && fogControls) {
          const partyId = fogControls.querySelector('[name="partyId"]')?.value;
          const accepted = documentNode.defaultView?.confirm?.(`重置 ${partyId} 在当前 Scene 的全部探索区域？`) ?? true;
          if (accepted) api.vision?.resetExplored?.(partyId).catch(error => api.showToast?.(error.message, 'error'));
        }
        const fogHide = event.target.closest('[data-fog-hide]');
        if (fogHide && fogControls) {
          beginPlacement({
            type: 'fog-hide',
            partyId: fogControls.querySelector('[name="partyId"]')?.value,
            radiusMeters: Number(fogControls.querySelector('[name="radiusMeters"]')?.value) || 20,
          });
          api.showToast?.('点击地图选择重新隐藏区域', 'info');
        }
        const move = event.target.closest('[data-marker-move]');
        if (move) beginPlacement({ type: 'move', id: move.dataset.markerMove });
        const remove = event.target.closest('[data-marker-delete]');
        if (remove) api.markers.remove(remove.dataset.markerDelete).catch(error => api.showToast?.(error.message, 'error'));
      });
      panel?.addEventListener('change', async event => {
        const checkbox = event.target.closest('[data-marker-instance-check]');
        if (checkbox) {
          if (checkbox.checked) selectedInstanceIds.add(String(checkbox.value));
          else selectedInstanceIds.delete(String(checkbox.value));
          return;
        }
        const nameInput = event.target.closest('[data-marker-instance-name]');
        if (nameInput) {
          try {
            await api.tokens.update(nameInput.dataset.markerInstanceName, {
              name: String(nameInput.value || '').trim().slice(0, 80) || '未命名实例',
            });
          } catch (error) { api.showToast?.(error.message, 'error'); }
          return;
        }
        const healthInput = event.target.closest('[data-marker-instance-health]');
        if (healthInput) {
          const operationType = healthInput.dataset.markerInstanceHealth === 'max' ? 'set-max' : 'set-current';
          try {
            await api.world.performOperations([{ type: 'actor.runtime.perform', payload: {
              sceneId: api.world.get().activeSceneId,
              tokenId: healthInput.dataset.tokenId,
              operation: { type: 'health.runtime', operation: { type: operationType, value: Number(healthInput.value) || 0 } },
            } }], { source: 'markers:instance.health' });
          } catch (error) { api.showToast?.(error.message, 'error'); }
          return;
        }
        const lightingInput = event.target.closest('[data-scene-lighting]');
        if (lightingInput) {
          const scene = activeScene(api);
          if (!scene) return;
          try {
            await api.world.performOperations([{ type: 'scene.upsert', payload: {
              scene: { ...scene, settings: { ...(scene.settings || {}), lighting: lightingInput.value } },
            } }], { source: 'scene:lighting' });
          } catch (error) { api.showToast?.(error.message, 'error'); }
        }
      });
      const handleMapClick = event => {
        if (!pending || event.target.closest?.('.leaflet-control,.rpg-token-v2,.lightweight-marker-icon')) return;
        const latlng = api.map.mouseEventToLatLng?.(event);
        if (!latlng) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const point = latLngToWorld(latlng, api.mapPackage.height);
        const action = pending;
        pending = null;
        if (action.type === 'fog-hide') {
          api.vision?.hideExplored?.(action.partyId, {
            x: point.x, y: point.y, radiusMeters: action.radiusMeters,
          }).catch(error => api.showToast?.(error.message, 'error'));
          return;
        }
        const { type: _type, ...marker } = action;
        const promise = action.type === 'move'
          ? api.markers.move(action.id, point)
          : api.markers.upsert({ ...marker, x: point.x, y: point.y });
        promise.catch(error => api.showToast?.(error.message, 'error'));
      };
      api.map.getContainer().addEventListener('click', handleMapClick, true);

      const tabbar = shell.querySelector?.('.sidebar .tabbar');
      if (tabbar && !tabbar.querySelector('[data-ui-panel="markers"]')) {
        const tab = documentNode.createElement('button');
        tab.type = 'button';
        tab.className = 'ui-sidebar-tab';
        tab.dataset.uiPanel = 'markers';
        tab.textContent = '指示物';
        tab.addEventListener('click', () => api.setActivePanel?.('markers'));
        tabbar.append(tab);
      }
      const renderAll = () => { renderMap(); renderPanel(); };
      const off = ['state:commit', 'state:import', 'scene:activate', 'multiplayer:capabilities'].map(name => api.on?.(name, renderAll));
      renderAll();
      api.on?.('app:destroy', () => {
        off.forEach(dispose => dispose?.());
        api.map.getContainer().removeEventListener('click', handleMapClick, true);
        layer.clearLayers();
        api.map.removeLayer?.(layer);
      });
    },
  });
}
