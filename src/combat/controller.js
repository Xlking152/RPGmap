import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import {
  addCombatants,
  createCombat,
  currentCombatant,
  moveCombatant,
  nextTurn,
  removeCombatant,
  setCombatantInitiative,
  setCombatTurnOrigin,
  startCombat,
} from './model.js';
import { CombatStore } from './store.js';
import { installCombatStyles, renderCombatTopbar, renderCombatTracker } from './tracker.js';
import { describeActor } from '../actor/index.js';

function tokenRefs(api, ids) {
  if (!api.tokens?.get) return [];
  return (ids || []).map(String).flatMap(tokenId => {
    const token = api.tokens.get(tokenId);
    return token ? [{ tokenId: String(token.id), actorId: token.actorId ?? null }] : [];
  });
}

function runtimeTokenView(api, tokenId) {
  if (api.tokens?.get) {
    const token = api.tokens.get(tokenId);
    if (token) {
      let resolved = null;
      try { resolved = api.tokens.resolveActor?.(token.id) || null; } catch {}
      const actor = resolved?.actor || null;
      const presentation = describeActor(actor, { ruleset: api.ruleset }) || {};
      return {
        token,
        actor,
        synthetic: resolved?.synthetic === true,
        name: presentation.name || actor?.name || `Token ${token.id}`,
        avatar: presentation.avatarDataUrl || actor?.img || null,
      };
    }
  }
  return null;
}

function tokenMapPoint(api, tokenId) {
  const view = runtimeTokenView(api, tokenId);
  const token = view?.token;
  if (token) {
    if (token.hidden === true || token.placement !== 'map') return null;
    const x = Number(token.x);
    const y = Number(token.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  return null;
}

export function captureCurrentTurnOrigin(api, combat) {
  const current = combat?.state === 'active' ? currentCombatant(combat) : null;
  const token = current ? api.tokens?.get?.(current.tokenId) : null;
  if (!token || token.hidden === true || token.placement !== 'map') return setCombatTurnOrigin(combat, null);
  return setCombatTurnOrigin(combat, token);
}

function ensureCombatPane(map) {
  let pane = map.getPane?.('combatPane');
  if (!pane) pane = map.createPane('combatPane');
  if (pane) {
    pane.style.zIndex = '700';
    pane.style.pointerEvents = 'none';
  }
}

export function createCombatController({ selection } = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const mapCard = mapElement.parentElement || mapElement;
      const toolbar = shell.querySelector?.('.toolbar');
      installCombatStyles(documentNode);
      ensureCombatPane(api.map);
      if (mapCard && getComputedStyle(mapCard).position === 'static') mapCard.style.position = 'relative';

      const store = new CombatStore(api);
      store.load();
      const turnLayer = L.layerGroup([], { pane: 'combatPane' }).addTo(api.map);
      let draggingCombatantId = null;

      const tracker = documentNode.createElement('aside');
      tracker.className = 'rpgmap-combat-tracker';
      tracker.hidden = true;
      mapCard.append(tracker);

      const top = documentNode.createElement('div');
      top.className = 'combat-top-controls';
      const ruler = toolbar?.querySelector('.ui-ruler-tool');
      if (ruler) ruler.insertAdjacentElement('afterend', top);
      else toolbar?.append(top);

      const selectedIds = () => selection?.getSelectedTokenIds?.() || api.selection?.getSelectedTokenIds?.() || [];
      const resolveTokenView = tokenId => runtimeTokenView(api, tokenId);
      const tokenName = tokenId => resolveTokenView(tokenId)?.name || `Token ${tokenId}`;
      const combatLog = (message, data = null) => api.chat?.combat?.(message, data);

      const status = message => {
        const node = shell.querySelector?.('[data-role="map-status"]');
        if (node) node.textContent = message;
      };

      function canManageCombat() {
        const multiplayer = api.multiplayer?.getStatus?.();
        if (!multiplayer?.connected) return true;
        return multiplayer.permissions?.combatManage !== false;
      }

      function requireCombatManager() {
        if (canManageCombat()) return true;
        status('战斗流程由 GM 管理：Player 只能查看先攻与当前回合');
        return false;
      }

      function applyPermissionUi() {
        const readonly = !canManageCombat();
        tracker.classList.toggle('combat-player-readonly', readonly);
        top.querySelectorAll('[data-combat-action]').forEach(node => { node.disabled = readonly; });
        tracker.querySelectorAll('[data-combat-initiative],[data-combat-remove]').forEach(node => { node.disabled = readonly; });
        tracker.querySelectorAll('.combatant-drag').forEach(node => {
          node.draggable = !readonly;
          node.setAttribute('aria-disabled', readonly ? 'true' : 'false');
          if (readonly) node.title = '先攻顺序由 GM 管理';
        });
      }

      function addableSelectedCount() {
        const combat = store.state.combat;
        const existing = new Set((combat?.combatants || []).map(item => String(item.tokenId)));
        return selectedIds().filter(id => !existing.has(String(id))).length;
      }

      function renderTurn() {
        turnLayer.clearLayers();
        const combat = store.state.combat;
        const current = combat?.state === 'active' ? currentCombatant(combat) : null;
        if (!current) return;
        const point = tokenMapPoint(api, current.tokenId);
        if (!point) return;
        L.circleMarker(worldToLatLng(point, api.mapPackage.height), {
          pane: 'combatPane',
          radius: 22,
          color: '#c86b24',
          weight: 4,
          opacity: 1,
          fillColor: '#f0a44d',
          fillOpacity: 0.08,
          interactive: false,
          className: 'rpgmap-combat-current-token',
        }).addTo(turnLayer);
      }

      function render() {
        const appState = api.getState();
        const combat = store.state.combat;
        renderCombatTracker(tracker, combat, appState, resolveTokenView);
        renderCombatTopbar(top, combat, appState, selectedIds().length, addableSelectedCount(), resolveTokenView);
        renderTurn();
        applyPermissionUi();
      }

      function persist(message = '') {
        store.persist();
        render();
        if (message) status(message);
      }

      function enterCombat() {
        if (!requireCombatManager()) return false;
        const ids = selectedIds();
        if (!ids.length) {
          status('进入战斗：请先单选或框选至少一个 Token');
          return false;
        }
        const refs = tokenRefs(api, ids);
        if (!refs.length) {
          status('进入战斗：当前选择中没有可用 Token');
          return false;
        }
        store.state.combat = createCombat(refs);
        persist(`已建立战斗 · ${refs.length} 个 Token · 请填写先攻`);
        combatLog(`进入战斗：${refs.map(ref => tokenName(ref.tokenId)).join('、')}`, { event: 'enter', tokenIds: refs.map(ref => ref.tokenId) });
        return true;
      }

      function addSelected() {
        if (!requireCombatManager()) return false;
        const combat = store.state.combat;
        if (!combat) return enterCombat();
        const refs = tokenRefs(api, selectedIds());
        const existing = new Set(combat.combatants.map(item => String(item.tokenId)));
        const newRefs = refs.filter(ref => !existing.has(String(ref.tokenId)));
        const added = addCombatants(combat, refs);
        if (!added) {
          status('加入战斗：当前所选 Token 已全部在先攻表中');
          render();
          return false;
        }
        persist(`已加入 ${added} 个 Token · 新角色不会自动加入战斗`);
        const addedIds = newRefs.map(ref => ref.tokenId);
        combatLog(`加入战斗：${addedIds.map(tokenName).join('、')}`, { event: 'add', tokenIds: addedIds });
        return true;
      }

      function beginCombat() {
        if (!requireCombatManager()) return false;
        const combat = store.state.combat;
        if (!combat?.combatants?.length) {
          status('开始战斗：先攻表中没有参战者');
          return false;
        }
        if (!startCombat(combat)) return false;
        const current = currentCombatant(combat);
        captureCurrentTurnOrigin(api, combat);
        persist(`战斗开始 · 第 1 轮${current ? ` · 当前 ${current.tokenId}` : ''}`);
        combatLog(`战斗开始 · 第 1 轮${current ? ` · ${tokenName(current.tokenId)} 的回合` : ''}`, { event: 'start', round: 1, tokenId: current?.tokenId || null });
        focusCurrent(false);
        return true;
      }

      function advanceTurn() {
        if (!requireCombatManager()) return false;
        const combat = store.state.combat;
        const current = nextTurn(combat);
        if (!current) return false;
        captureCurrentTurnOrigin(api, combat);
        persist(`第 ${combat.round} 轮 · 下一回合`);
        combatLog(`第 ${combat.round} 轮 · ${tokenName(current.tokenId)} 的回合`, { event: 'turn', round: combat.round, tokenId: current.tokenId });
        focusCurrent(false);
        return true;
      }

      function endCombat() {
        if (!requireCombatManager()) return false;
        if (!store.state.combat) return;
        if (!window.confirm('结束当前战斗并清空先攻表？')) return;
        const combatId = store.state.combat.id;
        // In LAN mode the World commit must be sent before its matching chat
        // event. Sending the event first increments the server revision, so
        // the following clear request is rejected as stale.
        store.clear();
        render();
        combatLog('战斗结束', { event: 'end', combatId });
        status('战斗已结束');
        return true;
      }

      function focusToken(tokenId, { center = true } = {}) {
        const view = runtimeTokenView(api, tokenId);
        if (!view) return false;
        api.selection?.replace?.([String(tokenId)], String(tokenId));
        const point = tokenMapPoint(api, tokenId);
        if (center && point) {
          api.map.panTo(worldToLatLng(point, api.mapPackage.height), { animate: true, duration: 0.25 });
        }
        return true;
      }

      function focusCurrent(center = true) {
        const combat = store.state.combat;
        const current = combat?.state === 'active' ? currentCombatant(combat) : null;
        if (current) focusToken(current.tokenId, { center });
      }

      function pruneMissingTokens() {
        const combat = store.state.combat;
        if (!combat?.combatants?.length || !api.tokens?.get) return false;
        let changed = false;
        for (const item of [...combat.combatants]) {
          if (api.tokens.get(item.tokenId)) continue;
          removeCombatant(combat, item.id);
          changed = true;
        }
        if (!changed) return false;
        if (!combat.combatants.length) store.clear();
        else {
          if (combat.state === 'active' && !combat.turnOrigin) captureCurrentTurnOrigin(api, combat);
          store.persist();
        }
        return true;
      }

      top.addEventListener('click', event => {
        const action = event.target.closest?.('[data-combat-action]')?.dataset.combatAction;
        if (!action) return;
        if (!requireCombatManager()) { event.preventDefault(); return; }
        if (action === 'enter') enterCombat();
        else if (action === 'add') addSelected();
        else if (action === 'start') beginCombat();
        else if (action === 'next') advanceTurn();
        else if (action === 'end') endCombat();
      });

      tracker.addEventListener('click', event => {
        const remove = event.target.closest?.('[data-combat-remove]');
        if (remove) {
          if (!requireCombatManager()) { event.preventDefault(); return; }
          const combat = store.state.combat;
          if (!combat) return;
          const id = remove.dataset.combatRemove;
          const removed = combat.combatants.find(item => item.id === id);
          if (removeCombatant(combat, id)) {
            if (!combat.combatants.length) {
              store.clear();
              render();
              status('先攻表已清空');
            } else {
              if (combat.state === 'active' && !combat.turnOrigin) captureCurrentTurnOrigin(api, combat);
              persist('已将 Token 移出战斗');
            }
            if (removed) combatLog(`移出战斗：${tokenName(removed.tokenId)}`, { event: 'remove', tokenId: removed.tokenId });
          }
          return;
        }
        if (event.target.closest?.('input,.combatant-drag,button')) return;
        const row = event.target.closest?.('[data-token-id]');
        if (row) focusToken(row.dataset.tokenId);
      });

      tracker.addEventListener('change', event => {
        const input = event.target.closest?.('[data-combat-initiative]');
        if (!input) return;
        if (!requireCombatManager()) { render(); return; }
        const combat = store.state.combat;
        if (!combat) return;
        if (setCombatantInitiative(combat, input.dataset.combatInitiative, input.value)) {
          persist('先攻已更新 · 已按数值从高到低排列');
        }
      });

      tracker.addEventListener('dragstart', event => {
        if (!requireCombatManager()) { event.preventDefault(); return; }
        const handle = event.target.closest?.('.combatant-drag');
        const row = handle?.closest?.('[data-combatant-id]');
        if (!row) return;
        draggingCombatantId = row.dataset.combatantId;
        event.dataTransfer?.setData('text/plain', draggingCombatantId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });

      tracker.addEventListener('dragover', event => {
        if (!canManageCombat() || !draggingCombatantId) return;
        const row = event.target.closest?.('[data-combatant-id]');
        if (!row || row.dataset.combatantId === draggingCombatantId) return;
        event.preventDefault();
        tracker.querySelectorAll('.combatant-row.drag-over').forEach(node => node.classList.remove('drag-over'));
        row.classList.add('drag-over');
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });

      tracker.addEventListener('dragleave', event => {
        event.target.closest?.('.combatant-row')?.classList.remove('drag-over');
      });

      tracker.addEventListener('drop', event => {
        if (!requireCombatManager()) { event.preventDefault(); draggingCombatantId = null; return; }
        const target = event.target.closest?.('[data-combatant-id]');
        if (!draggingCombatantId || !target) return;
        event.preventDefault();
        const combat = store.state.combat;
        if (combat && moveCombatant(combat, draggingCombatantId, target.dataset.combatantId)) {
          persist('先攻顺序已手动调整');
        }
        draggingCombatantId = null;
      });

      tracker.addEventListener('dragend', () => {
        draggingCombatantId = null;
        tracker.querySelectorAll('.combatant-row.drag-over').forEach(node => node.classList.remove('drag-over'));
      });

      selection?.subscribe?.(() => render());
      api.on('token:move', renderTurn);
      api.on('token:delete', event => {
        const combat = store.state.combat;
        const tokenId = event.detail?.tokenId || event.detail?.id;
        const item = combat?.combatants?.find(entry => String(entry.tokenId) === String(tokenId));
        if (!item) return;
        removeCombatant(combat, item.id);
        if (!combat.combatants.length) store.clear();
        else {
          if (combat.state === 'active' && !combat.turnOrigin) captureCurrentTurnOrigin(api, combat);
          store.persist();
        }
        render();
      });
      api.on('state:import', () => {
        if (store.saving) return;
        store.load();
        pruneMissingTokens();
        render();
      });
      api.on('state:commit', event => {
        const source = String(event.detail?.source || '');
        if (!source.startsWith('token-v2:') && !source.startsWith('world-v2:') && source !== 'health') return;
        if (pruneMissingTokens()) return render();
        render();
      });

      render();
    },
  };
}
