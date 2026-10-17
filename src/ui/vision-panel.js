import { describeActor } from '../actor/index.js';
import { contentImageAttributes } from '../content/references.js';
import { readRuntimeState } from '../engine/state-access.js';
import { latLngToWorld, worldToLatLng } from '../engine/geometry.js';
import { readConnectionState } from '../multiplayer/connection-state.js';
import { normalizeLightSource } from '../spatial/kernel.js';
import { renderUiIcon } from './icons.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const denied = () => Object.assign(new Error('只有 GM 可以修改场景视野与探索记录'), { code: 'vision_panel_gm_only' });

function worldState(api) {
  const state = readRuntimeState(api);
  const world = state.preferences?.worldV2 || api.world?.get?.() || {};
  return { world, scene: world.scenes?.find(item => String(item.id) === String(world.activeSceneId)) || null };
}

function isGm(api) {
  const connection = readConnectionState(api);
  const role = connection?.session?.role || connection?.role;
  if (connection?.connected || connection?.retainsServerState) return role === 'gm';
  return !role || role === 'gm' || role === 'offline';
}

function tokenView(api, token, actors) {
  let actor = actors.find(item => String(item.id) === String(token.actorId));
  try { actor = api.tokens?.resolveActor?.(token.id)?.actor || actor; } catch { /* The projected profile is enough. */ }
  const presentation = actor ? describeActor(actor, { ruleset: api.ruleset }) || {} : {};
  return { id: String(token.id), name: token.name || presentation.name || actor?.name || '未命名棋子',
    portrait: presentation.avatarDataUrl || null, partyId: actor?.partyId || null };
}

export function readVisionPanelState(api) {
  const { world, scene } = worldState(api);
  const gm = isGm(api), actors = world.actors || [];
  const tokens = scene?.tokens || [];
  const sourceId = api.vision?.getSource?.() || null;
  const sources = tokens.filter(token => token.placement === 'map' && token.vision?.enabled !== false
    && (gm || api.multiplayer?.canControlToken?.(token.id) === true)).map(token => tokenView(api, token, actors));
  const source = sources.find(item => item.id === sourceId) || null;
  const parties = [...new Set([...actors.map(actor => actor.partyId),
    ...Object.keys(scene?.fog?.exploredByParty || {})].filter(Boolean).map(String))].sort();
  const lights = gm ? [
    ...(api.mapPackage?.lights || []).flatMap(light => {
      const normalized = normalizeLightSource(light);
      return normalized ? [{ ...normalized, name: light.name || '地图光源', kind: 'map' }] : [];
    }),
    ...tokens.filter(token => token.placement === 'map' && token.light
      && (token.light.enabled || Number(token.light.rangeMeters) > 0)).map(token => ({
      id: `token-light:${token.id}`, tokenId: String(token.id), name: tokenView(api, token, actors).name,
      kind: 'token', x: token.x, y: token.y, rangeMeters: Number(token.light.rangeMeters) || 0,
      enabled: token.light.enabled === true, color: /^#[0-9a-f]{6}$/i.test(token.light.color || '') ? token.light.color : '#fff3c4',
    })),
  ] : [];
  return { gm, sceneId: scene?.id || null, sceneName: scene?.name || '当前场景', sourceId, source, sources, parties, lights,
    lighting: ['normal', 'dim', 'dark'].includes(scene?.settings?.lighting) ? scene.settings.lighting : 'normal',
    region: api.vision?.getVisibleRegion?.() || null,
    canEditOcclusion: gm && api.occlusionEditor?.canEdit?.() === true };
}

export function createVisionPanelActions(api, { confirm = () => false } = {}) {
  const requireGm = () => { if (!isGm(api)) throw denied(); };
  return {
    async setSource(tokenId) {
      const state = readVisionPanelState(api);
      if (tokenId == null && !state.gm) throw denied();
      if (tokenId != null && !state.sources.some(item => item.id === String(tokenId))) {
        throw Object.assign(new Error('当前不能使用该棋子的视野'), { code: 'vision_source_forbidden' });
      }
      return api.vision.setSource(tokenId);
    },
    async setLighting(lighting) {
      requireGm();
      if (!['normal', 'dim', 'dark'].includes(lighting)) throw new Error('无效的环境光');
      const { scene } = worldState(api);
      if (!scene || scene.settings?.lighting === lighting) return null;
      return api.world.performOperations([{ type: 'scene.upsert', payload: {
        scene: { ...scene, settings: { ...scene.settings, lighting } },
      } }], { source: 'vision:lighting' });
    },
    async setLight(tokenId, enabled) {
      requireGm();
      const { scene } = worldState(api);
      const token = scene?.tokens?.find(item => String(item.id) === String(tokenId));
      if (!token?.light) throw new Error('当前光源已不存在');
      return api.tokens.update(token.id, { light: { ...token.light, enabled: enabled === true } });
    },
    async resetExplored(partyId) {
      requireGm();
      const state = readVisionPanelState(api);
      if (!state.parties.includes(partyId)) throw new Error('当前队伍已不存在');
      if (!confirm(`重置 ${partyId} 在当前场景的全部探索记录？此操作不能撤销。`)) return null;
      requireGm();
      return api.vision.resetExplored(partyId, { sceneId: state.sceneId });
    },
    async hideExplored(partyId, circle, sceneId) {
      requireGm();
      const state = readVisionPanelState(api);
      if (state.sceneId !== sceneId || !state.parties.includes(partyId)) throw new Error('场景或队伍已改变，请重新选择');
      if (![circle.x, circle.y, circle.radiusMeters].every(Number.isFinite) || circle.radiusMeters <= 0) throw new Error('隐藏区域无效');
      return api.vision.hideExplored(partyId, circle, { sceneId });
    },
  };
}

const iconButton = (icon, label, data, disabled = false) => `<button type="button" class="vision-icon-button" ${data} title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" ${disabled ? 'disabled' : ''}>${renderUiIcon(icon)}</button>`;

export function renderVisionPanel(state, { partyId = '', radiusMeters = 20, busy = false, error = '', placement = false } = {}) {
  const disabled = busy ? 'disabled' : '';
  const source = state.source;
  const portrait = source?.portrait ? `<img alt="" ${contentImageAttributes(source.portrait, escapeHtml)}>` : escapeHtml(Array.from(source?.name || '?')[0]);
  return `<div class="vision-panel" aria-busy="${busy}">
    <header class="vision-panel-heading"><div><h2>视野与光照</h2><span>${escapeHtml(state.sceneName)}</span></div>${renderUiIcon('eye', { size: 22 })}</header>
    ${state.gm ? `<div class="vision-segmented" role="group" aria-label="视角模式"><button type="button" data-vision-mode="full" aria-pressed="${!state.sourceId}" ${disabled}>全图</button><button type="button" data-vision-mode="token" aria-pressed="${Boolean(state.sourceId)}" ${busy || !state.sources.length ? 'disabled' : ''}>玩家预览</button></div>` : ''}
    <section class="vision-panel-section vision-source-section"><label for="vision-source-select">视野来源</label><div class="vision-source-control"><span class="vision-source-avatar">${portrait}</span><select id="vision-source-select" data-vision-source ${busy || !state.sources.length ? 'disabled' : ''}><option value="" ${state.sourceId ? '' : 'selected'} disabled>${state.gm ? '全图视角' : '选择可控棋子'}</option>${state.sources.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === state.sourceId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>${iconButton('map-pin', '定位视野来源', 'data-vision-locate-source', !source || busy)}</div>${state.region ? `<dl class="vision-range"><div><dt>精确</dt><dd>${Number(state.region.preciseRangeMeters ?? state.region.rangeMeters) || 0}<small>m</small></dd></div><div><dt>模糊</dt><dd>${Number(state.region.vagueRangeMeters ?? state.region.rangeMeters) || 0}<small>m</small></dd></div><div><dt>高度</dt><dd>${Number(state.region.elevationMeters) || 0}<small>m</small></dd></div></dl>` : ''}</section>
    <section class="vision-panel-section"><h3>场景光照</h3><div class="vision-segmented" role="group" aria-label="场景光照">${[['normal', '正常'], ['dim', '昏暗'], ['dark', '黑暗']].map(([value, label]) => `<button type="button" data-vision-lighting="${value}" aria-pressed="${state.lighting === value}" ${busy || !state.gm ? 'disabled' : ''}>${label}</button>`).join('')}</div><div class="vision-occlusion-row"><span>${renderUiIcon('shield')}视线遮挡</span><span class="vision-state-tag">规则启用</span>${state.canEditOcclusion ? iconButton('sliders', '编辑场景遮挡', 'data-vision-edit-occlusion', busy) : ''}</div></section>
    ${state.gm ? `<section class="vision-panel-section"><div class="vision-section-title"><h3>光源列表</h3><span>${state.lights.length}</span></div><div class="vision-light-list">${state.lights.map(light => `<article class="vision-light-row"><span class="vision-light-swatch" style="--light-color:${escapeHtml(light.color)}">${renderUiIcon('circle')}</span><div class="vision-light-name"><strong>${escapeHtml(light.name)}</strong><small>${light.kind === 'map' ? '地图光源 · 只读' : '棋子光源'}</small></div><span class="vision-light-range">${light.rangeMeters} m</span>${iconButton('map-pin', `定位 ${light.name}`, `data-vision-locate-light="${escapeHtml(light.id)}"`, busy)}${light.kind === 'token' ? `<input type="checkbox" class="vision-light-toggle" aria-label="启用 ${escapeHtml(light.name)} 光源" data-vision-light-token="${escapeHtml(light.tokenId)}" ${light.enabled ? 'checked' : ''} ${disabled}>` : ''}</article>`).join('') || '<p class="vision-empty">当前场景没有光源</p>'}</div>${source ? `<button type="button" class="vision-text-command" data-vision-edit-source ${disabled}>${renderUiIcon('settings')}棋子光源与视野设置</button>` : ''}</section>
    <section class="vision-panel-section"><div class="vision-section-title"><h3>队伍探索</h3><select aria-label="探索队伍" data-vision-party ${busy || !state.parties.length ? 'disabled' : ''}>${state.parties.map(value => `<option value="${escapeHtml(value)}" ${partyId === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></div><div class="vision-hide-settings"><label>隐藏半径 <span><input type="number" min="5" max="120" step="5" value="${radiusMeters}" data-vision-hide-radius ${disabled}> m</span></label><button type="button" class="vision-text-command" data-vision-hide ${busy || !state.parties.length ? 'disabled' : ''}>${renderUiIcon(placement ? 'x' : 'eye')}${placement ? '取消选择' : '重新隐藏区域'}</button></div><button type="button" class="vision-reset-command" data-vision-reset ${busy || !state.parties.length ? 'disabled' : ''}>${renderUiIcon('rotate-ccw')}重置队伍探索</button></section>` : ''}
    <footer class="vision-legend"><span><i data-vision-level="precise"></i>精确</span><span><i data-vision-level="vague"></i>模糊</span><span><i data-vision-level="explored"></i>已探索</span><span><i data-vision-level="unknown"></i>未探索</span></footer><div class="vision-panel-feedback" role="status">${escapeHtml(error || (busy ? '正在保存…' : placement ? '选择地图上的隐藏区域中心' : ''))}</div>
  </div>`;
}

export function installVisionPanel(api, { container }) {
  if (!container) return null;
  const documentNode = container.ownerDocument;
  const windowNode = documentNode.defaultView;
  const actions = createVisionPanelActions(api, { confirm: message => windowNode.confirm(message) });
  let partyId = '', radiusMeters = 20, busy = false, error = '', pending = null, destroyed = false, frame = null;
  const off = [];
  function render() {
    if (destroyed) return;
    const state = readVisionPanelState(api);
    if (!state.parties.includes(partyId)) partyId = state.source?.partyId || state.parties[0] || '';
    if (pending && (pending.sceneId !== state.sceneId || !state.gm)) pending = null;
    container.innerHTML = renderVisionPanel(state, { partyId, radiusMeters, busy, error, placement: Boolean(pending) });
  }
  function schedule() {
    if (frame !== null || destroyed || container.hidden) return;
    frame = windowNode.requestAnimationFrame(() => { frame = null; render(); });
  }
  async function run(action) {
    if (busy || destroyed) return;
    busy = true; error = ''; render();
    try { await action(); }
    catch (failure) { error = failure.message || '操作失败'; api.showToast?.(error, 'error'); }
    finally { busy = false; render(); }
  }
  function locate(point) {
    if (point) api.map.panTo(worldToLatLng(point, api.mapPackage.height));
  }
  function handleClick(event) {
    const button = event.target.closest?.('button');
    if (!button || !container.contains(button) || button.disabled) return;
    const state = readVisionPanelState(api);
    if (button.dataset.visionMode === 'full') return run(() => actions.setSource(null));
    if (button.dataset.visionMode === 'token') {
      const selected = api.selection?.getSelectedTokenIds?.() || [];
      const source = state.sources.find(item => selected.includes(item.id)) || state.sources[0];
      if (source) return run(() => actions.setSource(source.id));
    }
    if (button.dataset.visionLighting) return run(() => actions.setLighting(button.dataset.visionLighting));
    if (button.hasAttribute('data-vision-locate-source')) locate(worldState(api).scene?.tokens?.find(token => String(token.id) === state.sourceId));
    if (button.hasAttribute('data-vision-locate-light')) locate(state.lights.find(light => light.id === button.dataset.visionLocateLight));
    if (button.hasAttribute('data-vision-edit-source') && state.sourceId) api.entities?.openToken?.(state.sourceId, 'token');
    if (button.hasAttribute('data-vision-edit-occlusion') && state.canEditOcclusion) return run(() => api.occlusionEditor.open());
    if (button.hasAttribute('data-vision-reset')) return run(() => actions.resetExplored(partyId));
    if (button.hasAttribute('data-vision-hide') && state.gm) {
      pending = pending ? null : { sceneId: state.sceneId, partyId, radiusMeters };
      api.setTool?.('pan'); render();
    }
  }
  function handleChange(event) {
    const target = event.target;
    if (target.hasAttribute('data-vision-source')) return run(() => actions.setSource(target.value));
    if (target.hasAttribute('data-vision-party')) { partyId = target.value; pending = null; }
    if (target.hasAttribute('data-vision-hide-radius')) radiusMeters = Math.min(120, Math.max(5, Number(target.value) || 20));
    if (target.hasAttribute('data-vision-light-token')) return run(() => actions.setLight(target.dataset.visionLightToken, target.checked));
    render();
  }
  function handleMapClick(event) {
    if (!pending || busy || event.target.closest?.('.leaflet-control,.rpg-token-v2,.lightweight-marker-icon')) return;
    const latlng = api.map.mouseEventToLatLng?.(event);
    if (!latlng) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const action = pending; pending = null;
    const point = latLngToWorld(latlng, api.mapPackage.height);
    return run(() => actions.hideExplored(action.partyId, { ...point, radiusMeters: action.radiusMeters }, action.sceneId));
  }
  function cancel(event) {
    if (event.key === 'Escape' && pending) { pending = null; event.preventDefault(); render(); }
  }
  container.addEventListener('click', handleClick);
  container.addEventListener('change', handleChange);
  api.map.getContainer().addEventListener('click', handleMapClick, true);
  documentNode.addEventListener('keydown', cancel);
  for (const name of ['state:patch', 'state:commit', 'state:import', 'vision:source-change', 'multiplayer:capabilities', 'multiplayer:status', 'scene:switch-complete', 'token:property-change']) {
    const dispose = api.on?.(name, schedule); if (typeof dispose === 'function') off.push(dispose);
  }
  const panelDispose = api.on?.('ui:panel-change', event => {
    if ((event.detail?.name || event.detail?.panel || event.detail?.id) === 'vision') render();
    else if (pending) { pending = null; render(); }
  });
  if (typeof panelDispose === 'function') off.push(panelDispose);
  function destroy() {
    if (destroyed) return;
    destroyed = true; pending = null;
    if (frame !== null) windowNode.cancelAnimationFrame(frame);
    container.removeEventListener('click', handleClick); container.removeEventListener('change', handleChange);
    api.map.getContainer().removeEventListener('click', handleMapClick, true);
    documentNode.removeEventListener('keydown', cancel);
    off.splice(0).forEach(dispose => dispose());
  }
  const destroyDispose = api.on?.('app:destroy', destroy); if (typeof destroyDispose === 'function') off.push(destroyDispose);
  render();
  return Object.freeze({ render, destroy });
}
