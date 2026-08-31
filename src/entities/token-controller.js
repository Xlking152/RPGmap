import { latLngToWorld } from '../engine/geometry.js';
import { TOKEN_DIAMETERS_METERS } from '../elevation/model.js';
import { createActorTokenAtPoint, relocateActorTokenAtPoint } from '../token/placement.js';
import { nextTokenInstanceName } from '../token/naming.js';
import {
  normalizeTokenRotation,
  setTokenDiameterMeters,
  setTokenElevationFt,
  setTokenHidden,
  setTokenRotation,
} from '../token/properties.js';
import {
  deleteCanonicalActor,
  deleteCanonicalToken,
  listWorldActorTokens,
} from './canonical-delete.js';

function id(value) {
  return String(value ?? '').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function confirmWith(documentNode, message) {
  const fn = documentNode?.defaultView?.confirm || globalThis.confirm;
  return typeof fn === 'function' ? fn(message) : true;
}

function promptWith(documentNode, message, value) {
  const fn = documentNode?.defaultView?.prompt || globalThis.prompt;
  return typeof fn === 'function' ? fn(message, value) : value;
}

function resolvedActorName(api, tokenId) {
  try { return api.tokens.resolveActor?.(tokenId)?.actor?.name || `Token ${tokenId}`; }
  catch { return `Token ${tokenId}`; }
}

function positionLabel(token) {
  if (token?.placement === 'feature') return `建筑 ${token.featureId || '未知'}`;
  const x = Number(token?.x);
  const y = Number(token?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? `${Math.round(x)}, ${Math.round(y)}` : '未知';
}

export function createEntityTokenController({
  api,
  documentNode,
  mapElement,
  store,
  capabilities,
  setStatus,
  closeSheet,
  renderPanel,
  renderSheet,
  onSelectToken = () => {},
} = {}) {
  if (!api?.tokens?.list || !api?.tokens?.get || !api?.tokens?.create || !api?.tokens?.move || !api?.tokens?.update) {
    throw new Error('Canonical Entity Token controller requires Token Runtime V2');
  }
  if (!api?.world?.get || !api?.world?.commit) {
    throw new Error('Canonical Entity Token controller requires World V2');
  }

  let pendingActorId = null;
  let pendingPlacementOptions = {};
  let pendingRelocationTokenId = null;
  let placementBusy = false;
  let propertyBusy = false;
  let destroyed = false;

  function tokens() {
    return api.tokens.list?.() || [];
  }

  function actorTokens(actorId) {
    const target = id(actorId);
    return tokens().filter(token => id(token?.actorId) === target);
  }

  function canManageStructure() {
    return capabilities().canManageStructure !== false;
  }

  function canPlace(actorId) {
    return capabilities().canPlaceActor?.(actorId) !== false;
  }

  function renderHud(message) {
    documentNode.querySelector?.('.entity-placement-hud')?.remove();
    const hud = documentNode.createElement('div');
    hud.className = 'entity-placement-hud';
    hud.setAttribute('role', 'status');
    hud.innerHTML = `<span>${escapeHtml(message)}</span><button type="button" class="small-button" data-entity-placement-cancel>取消</button>`;
    documentNode.body.append(hud);
  }

  function clearPlacement({ message = '', restoreTool = true } = {}) {
    const hadPending = Boolean(pendingActorId || pendingRelocationTokenId);
    pendingActorId = null;
    pendingPlacementOptions = {};
    pendingRelocationTokenId = null;
    placementBusy = false;
    documentNode.querySelector?.('.entity-placement-hud')?.remove();
    if (hadPending && restoreTool) api.setTool?.('pan');
    if (message) setStatus(message);
    return hadPending;
  }

  function beginPlacement(actorId, options = {}) {
    const target = id(actorId);
    const actor = store.actor(target);
    if (!actor) return false;
    if (!canPlace(target)) {
      setStatus('当前没有该 Actor 的 Token 放置权限');
      return false;
    }
    pendingActorId = target;
    pendingPlacementOptions = {
      actorLink: actor.type === 'pc' ? options.actorLink !== false : false,
      name: String(options.name || nextTokenInstanceName(tokens(), actor)).trim().slice(0, 80)
        || nextTokenInstanceName(tokens(), actor),
    };
    pendingRelocationTokenId = null;
    closeSheet();
    renderHud(`放置 Token：${pendingPlacementOptions.name} · ${pendingPlacementOptions.actorLink ? '共享角色数据' : '独立实例'}`);
    setStatus(`放置 Token：请在地图上点击“${pendingPlacementOptions.name}”的位置`);
    return true;
  }

  function beginRelocation(tokenId) {
    const target = id(tokenId);
    const token = api.tokens.get(target);
    if (!token) {
      setStatus('待重新放置的 Token 已不存在');
      return false;
    }
    if (!canPlace(token.actorId)) {
      setStatus('当前没有重新放置该 Token 的权限');
      return false;
    }
    pendingActorId = null;
    pendingRelocationTokenId = target;
    closeSheet();
    renderHud(`重新放置 Token：点击地图移动“${resolvedActorName(api, target)}”`);
    setStatus('重新放置 Token：请选择可通行的 1m 格子');
    return true;
  }

  async function handleMapClick(event) {
    if (destroyed || placementBusy || (!pendingActorId && !pendingRelocationTokenId)) return false;
    if (!mapElement.contains(event.target)) return false;
    if (event.target.closest?.('.leaflet-control, .rpg-token-v2, .leaflet-marker-icon')) return false;
    const latlng = api.map.mouseEventToLatLng?.(event);
    if (!latlng) return false;

    event.preventDefault();
    event.stopImmediatePropagation();
    const point = latLngToWorld(latlng, api.mapPackage.height);
    placementBusy = true;
    try {
      if (pendingRelocationTokenId) {
        const target = pendingRelocationTokenId;
        const current = api.tokens.get(target);
        if (!current) {
          clearPlacement({ message: '待重新放置的 Token 已不存在，已取消' });
          return true;
        }
        if (!canPlace(current.actorId)) {
          clearPlacement({ message: '当前没有重新放置该 Token 的权限' });
          return true;
        }
        const result = await relocateActorTokenAtPoint(api, target, point);
        if (!result.ok || !result.token) {
          setStatus('该位置不可放置 Token；请选择地图中的可通行位置，或点击取消');
          return true;
        }
        const token = result.token;
        clearPlacement({ restoreTool: true });
        api.selection?.replace?.([token.id], token.id);
        onSelectToken(token.id);
        api.emit?.('token:move', {
          id: token.id, tokenId: token.id, actorId: token.actorId, token,
          source: 'entity-editor',
        });
        renderPanel();
        renderSheet();
        setStatus(`Token 已重新放置：${resolvedActorName(api, token.id)}`);
        return true;
      }

      const actorId = pendingActorId;
      const actor = store.actor(actorId);
      if (!actor) {
        clearPlacement({ message: '待放置 Actor 已不存在，已取消放置' });
        return true;
      }
      if (!canPlace(actorId)) {
        clearPlacement({ message: '当前没有该 Actor 的 Token 放置权限' });
        return true;
      }
      const result = await createActorTokenAtPoint(api, actorId, point, pendingPlacementOptions);
      if (!result.ok || !result.token) {
        setStatus('该位置不可放置 Token；请选择地图中的可通行位置，或点击取消');
        return true;
      }
      const token = result.token;
      clearPlacement({ restoreTool: true });
      api.selection?.replace?.([token.id], token.id);
      onSelectToken(token.id);
      api.emit?.('token:create', {
        id: token.id, tokenId: token.id, actorId: token.actorId, token,
        source: 'entity-editor',
      });
      renderPanel();
      renderSheet();
      setStatus(`Token 已创建并加入当前 Scene：${resolvedActorName(api, token.id)}`);
      return true;
    } catch (error) {
      console.error('[RPGmap Entity Token Controller] placement failed', error);
      setStatus(`Token 放置失败：${error?.message || error}`);
      return true;
    } finally {
      placementBusy = false;
    }
  }

  async function changeProperty(tokenId, property, value) {
    const target = id(tokenId);
    if (!api.tokens.get(target)) return null;
    if (!canManageStructure()) {
      setStatus('当前 Token 外观/尺寸属性仅 GM 可修改');
      return null;
    }
    if (propertyBusy) return null;
    propertyBusy = true;
    try {
      let token;
      if (property === 'diameterMeters') token = await setTokenDiameterMeters(api, target, value);
      else if (property === 'hidden') token = await setTokenHidden(api, target, value);
      else if (property === 'rotation') token = await setTokenRotation(api, target, value);
      else throw new Error(`Unsupported Token property: ${property}`);
      api.emit?.('token:property-change', {
        id: token.id, tokenId: token.id, actorId: token.actorId, property, token,
        source: 'entity-editor',
      });
      if (property === 'diameterMeters') {
        api.emit?.('token:size-change', { tokenId: token.id, diameterMeters: token.diameterMeters });
      }
      if (property === 'hidden') api.emit?.('token:visibility-change', { tokenId: token.id, hidden: token.visibility?.mode === 'gm' });
      if (property === 'rotation') api.emit?.('token:rotation-change', { tokenId: token.id, rotation: token.rotation });
      renderPanel();
      renderSheet();
      return token;
    } finally {
      propertyBusy = false;
    }
  }

  async function changeAccess(tokenId, patch) {
    const target = id(tokenId);
    const token = api.tokens.get(target);
    if (!token) return null;
    await api.world.performOperations([{ type: 'token.access.patch', payload: {
      sceneId: api.world.get().activeSceneId,
      tokenId: target,
      patch,
    } }], { source: 'entities:token.access', kind: 'token' });
    api.emit?.('token:property-change', { tokenId: target, actorId: token.actorId, property: 'access' });
    renderPanel();
    renderSheet();
    return api.tokens.get(target);
  }

  async function editElevation(tokenId) {
    const target = id(tokenId);
    const token = api.tokens.get(target);
    if (!token) return false;
    if (api.elevation?.canSetTokenElevation?.(target) === false) {
      setStatus('当前无法修改该 Token 高度：需要该 Actor 的 OWNER 权限，并遵守战斗回合限制');
      return true;
    }
    const value = promptWith(documentNode, 'Token 高度（ft）：', String(Number(token.elevationFt) || 0));
    if (value === null) return true;
    try {
      const updated = await setTokenElevationFt(api, target, value);
      api.emit?.('elevation:token-change', {
        tokenId: updated.id, elevationFt: updated.elevationFt,
      });
      api.emit?.('token:property-change', {
        id: updated.id, tokenId: updated.id, actorId: updated.actorId,
        property: 'elevationFt', token: updated, source: 'entity-editor',
      });
      renderPanel();
      renderSheet();
      setStatus(`${resolvedActorName(api, target)} 高度已设为 ${updated.elevationFt} ft`);
    } catch (error) {
      console.error('[RPGmap Entity Token Controller] elevation failed', error);
      setStatus(`Token 高度更新失败：${error?.message || error}`);
    }
    return true;
  }

  async function removeToken(tokenId) {
    const target = id(tokenId);
    const token = api.tokens.get(target);
    if (!token) return null;
    if (!canManageStructure()) {
      setStatus('只有 GM 可以删除 Token');
      return null;
    }
    const name = resolvedActorName(api, target);
    if (!confirmWith(documentNode, `删除 Token“${name}”？绑定到该 Token 的范围会转为自由锚点。`)) return null;
    const removed = await deleteCanonicalToken(api, target);
    if (removed) {
      onSelectToken(null);
      renderPanel();
      renderSheet();
      setStatus(`已删除 Token“${name}”`);
    }
    return removed;
  }

  async function removeActor(actorId) {
    const target = id(actorId);
    if (!canManageStructure()) {
      setStatus('只有 GM 可以删除角色与关联 Token');
      return null;
    }
    const world = api.world.get();
    const actor = (world.actors || []).find(item => id(item?.id) === target);
    if (!actor) return null;
    const refs = listWorldActorTokens(world, target);
    if (!confirmWith(documentNode, `删除角色“${actor.name || actor.id}”及其全部 ${refs.length} 个 Token（包含其他 Scene）？绑定范围会转为自由锚点，战斗中的缺失 Token 会自动移除。`)) return null;
    const result = await deleteCanonicalActor(api, target);
    clearPlacement({ restoreTool: false });
    store.load({ migrateLegacy: false, dropMarkers: false });
    renderPanel();
    renderSheet();
    setStatus(`已删除角色“${actor.name || actor.id}”及 ${result.tokens.length} 个 Token`);
    return result;
  }

  function renderActorTokenSection(actor) {
    const list = actorTokens(actor.id);
    const structureAllowed = canManageStructure();
    const cards = list.map(token => {
      const elevationAllowed = api.elevation?.canSetTokenElevation?.(token.id) !== false;
      const userId = api.multiplayer?.getStatus?.()?.session?.userId || '';
      const visionAllowed = structureAllowed || (token.vision?.overrideUserIds || []).map(String).includes(String(userId));
      const diameter = Number(token.diameterMeters) || 1;
      const rotation = normalizeTokenRotation(token.rotation);
      const sizeControl = structureAllowed
        ? `<label>直径 <select data-token-diameter data-token-id="${escapeHtml(token.id)}">${TOKEN_DIAMETERS_METERS.map(value => `<option value="${value}" ${Number(value) === diameter ? 'selected' : ''}>${value} m</option>`).join('')}</select></label>`
        : `<small>直径：${diameter} m（仅 GM 可修改）</small>`;
      const displayControls = structureAllowed
        ? `<label>可见性 <select data-token-visibility data-token-id="${escapeHtml(token.id)}"><option value="public" ${token.visibility?.mode === 'public' ? 'selected' : ''}>公开</option><option value="party" ${token.visibility?.mode === 'party' ? 'selected' : ''}>队伍</option><option value="gm" ${token.visibility?.mode === 'gm' ? 'selected' : ''}>仅 GM</option><option value="users" ${token.visibility?.mode === 'users' ? 'selected' : ''}>指定用户</option></select></label><label>指定用户 <input data-token-visibility-users data-token-id="${escapeHtml(token.id)}" value="${escapeHtml((token.visibility?.userIds || []).join(','))}"></label><label>控制者 <input data-token-controllers data-token-id="${escapeHtml(token.id)}" value="${escapeHtml((token.controllerUserIds || []).join(','))}"></label><label>视野用户 <input data-token-vision-users data-token-id="${escapeHtml(token.id)}" value="${escapeHtml((token.vision?.overrideUserIds || []).join(','))}"></label><label>旋转 <input type="number" min="0" max="359" step="15" value="${rotation}" data-token-rotation data-token-id="${escapeHtml(token.id)}">°</label>`
        : `<small>${token.visibility?.mode === 'gm' ? '仅 GM' : token.visibility?.mode === 'party' ? '队伍可见' : '公开'} · 旋转 ${rotation}°</small>`;
      const visionControls = visionAllowed
        ? `<label>视野 <input type="checkbox" data-token-vision-enabled data-token-id="${escapeHtml(token.id)}" ${token.vision?.enabled === false ? '' : 'checked'} ${structureAllowed ? '' : 'disabled'}></label><label>视野半径 <input type="number" min="0" max="120" step="5" data-token-vision-range data-token-id="${escapeHtml(token.id)}" value="${token.vision?.rangeOverrideMeters ?? ''}" placeholder="规则包"></label>`
        : '';
      return `<div class="entity-card" data-token-id="${escapeHtml(token.id)}"><strong>Token ${escapeHtml(token.id)}</strong><small>位置：${escapeHtml(positionLabel(token))} · 高度：${escapeHtml(Number(token.elevationFt) || 0)} ft</small><div class="entity-card-actions">${sizeControl}${displayControls}${visionControls}${structureAllowed ? `<button type="button" class="small-button" data-sheet-action="reposition-token" data-token-id="${escapeHtml(token.id)}">重新放置</button>` : ''}<button type="button" class="small-button" data-sheet-action="edit-token-elevation" data-token-id="${escapeHtml(token.id)}" ${elevationAllowed ? '' : 'disabled title="当前没有该 Actor 的控制权限或不在可行动回合"'}>调整高度</button>${structureAllowed ? `<button type="button" class="small-button danger" data-sheet-action="delete-token" data-token-id="${escapeHtml(token.id)}">删除 Token</button>` : ''}</div></div>`;
    }).join('');
    return `<section class="entity-section"><h3>Token</h3>${cards || '<div class="entity-empty">当前角色尚未放置 Token。</div>'}<button type="button" class="small-button" data-sheet-action="place-token">放置 Token</button></section>`;
  }

  async function handleSheetAction(actionNode, actor) {
    const action = actionNode?.dataset?.sheetAction;
    if (action === 'place-token') { beginPlacement(actor.id); return true; }
    if (action === 'reposition-token') { beginRelocation(actionNode.dataset.tokenId); return true; }
    if (action === 'edit-token-elevation') return editElevation(actionNode.dataset.tokenId);
    if (action === 'delete-token') { await removeToken(actionNode.dataset.tokenId); return true; }
    return false;
  }

  async function handleChange(target) {
    if (target?.matches?.('[data-token-diameter]')) {
      const token = await changeProperty(target.dataset.tokenId, 'diameterMeters', target.value);
      if (token) setStatus(`Token 直径已设为 ${token.diameterMeters} m`);
      return true;
    }
    if (target?.matches?.('[data-token-visibility]')) {
      const token = api.tokens.get(target.dataset.tokenId);
      await changeAccess(target.dataset.tokenId, { visibility: { ...token.visibility, mode: target.value } });
      return true;
    }
    if (target?.matches?.('[data-token-visibility-users]')) {
      const token = api.tokens.get(target.dataset.tokenId);
      await changeAccess(target.dataset.tokenId, { visibility: { ...token.visibility, userIds: target.value.split(',').map(value => value.trim()).filter(Boolean) } });
      return true;
    }
    if (target?.matches?.('[data-token-controllers]')) {
      await changeAccess(target.dataset.tokenId, { controllerUserIds: target.value.split(',').map(value => value.trim()).filter(Boolean) });
      return true;
    }
    if (target?.matches?.('[data-token-vision-users]')) {
      await changeAccess(target.dataset.tokenId, { vision: { overrideUserIds: target.value.split(',').map(value => value.trim()).filter(Boolean) } });
      return true;
    }
    if (target?.matches?.('[data-token-vision-enabled]')) {
      await changeAccess(target.dataset.tokenId, { vision: { enabled: target.checked } });
      return true;
    }
    if (target?.matches?.('[data-token-vision-range]')) {
      await changeAccess(target.dataset.tokenId, { vision: { rangeOverrideMeters: target.value === '' ? null : Number(target.value) } });
      return true;
    }
    if (target?.matches?.('[data-token-rotation]')) {
      const token = await changeProperty(target.dataset.tokenId, 'rotation', target.value);
      if (token) setStatus(`Token 旋转已设为 ${token.rotation}°`);
      return true;
    }
    return false;
  }

  function handleKeydown(event) {
    if (event.key !== 'Escape' || (!pendingActorId && !pendingRelocationTokenId)) return false;
    event.preventDefault();
    clearPlacement({ message: '已取消 Token 放置' });
    return true;
  }

  function destroy() {
    destroyed = true;
    clearPlacement({ restoreTool: false });
  }

  return Object.freeze({
    tokens,
    actorTokens,
    renderActorTokenSection,
    beginPlacement,
    beginRelocation,
    handleMapClick,
    handleSheetAction,
    handleChange,
    handleKeydown,
    removeToken,
    removeActor,
    clearPlacement,
    destroy,
  });
}
