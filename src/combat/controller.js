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
  startCombat,
} from './model.js';
import { CombatStore } from './store.js';
import { installCombatStyles, renderCombatTopbar, renderCombatTracker } from './tracker.js';

function entityTokenRefs(appState, ids) {
  const entity = appState.preferences?.entitySystem || {};
  const entityTokens = Array.isArray(entity.tokens) ? entity.tokens : [];
  const characters = new Set((appState.characters || []).map(character => String(character.id)));
  return (ids || [])
    .map(String)
    .filter(id => characters.has(id))
    .map(tokenId => {
      const entityToken = entityTokens.find(token => String(token.characterId || token.id) === tokenId);
      return { tokenId, actorId: entityToken?.actorId ?? null };
    });
}

function tokenName(appState, tokenId) {
  return appState.characters?.find(item => String(item.id) === String(tokenId))?.name || `Token ${tokenId}`;
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
      const logCombat = (text, data = {}) => api.chat?.addCombat?.(text, data);

      const status = message => {
        const node = shell.querySelector?.('[data-role="map-status"]');
        if (node) node.textContent = message;
      };

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
        const character = api.getState().characters?.find(item => String(item.id) === String(current.tokenId));
        if (!character || character.location?.type !== 'map' || character.visible === false) return;
        L.circleMarker(worldToLatLng(character.location, api.mapPackage.height), {
          pane: 'combatPane', radius: 22, color: '#c86b24', weight: 4, opacity: 1,
          fillColor: '#f0a44d', fillOpacity: 0.08, interactive: false,
          className: 'rpgmap-combat-current-token',
        }).addTo(turnLayer);
      }

      function render() {
        const appState = api.getState();
        const combat = store.state.combat;
        renderCombatTracker(tracker, combat, appState);
        renderCombatTopbar(top, combat, appState, selectedIds().length, addableSelectedCount());
        renderTurn();
      }

      function persist(message = '') {
        store.persist();
        render();
        if (message) status(message);
      }

      function enterCombat() {
        const ids = selectedIds();
        if (!ids.length) { status('进入战斗：请先单选或框选至少一个 Token'); return false; }
        const refs = entityTokenRefs(api.getState(), ids);
        if (!refs.length) { status('进入战斗：当前选择中没有可用 Token'); return false; }
        store.state.combat = createCombat(refs);
        persist(`已建立战斗 · ${refs.length} 个 Token · 请填写先攻`);
        const names = refs.map(ref => tokenName(api.getState(), ref.tokenId));
        logCombat(`战斗准备：${names.join('、')} 进入先攻表。`, { event: 'combat-created', tokenIds: refs.map(ref => ref.tokenId) });
        return true;
      }

      function addSelected() {
        const combat = store.state.combat;
        if (!combat) return enterCombat();
        const refs = entityTokenRefs(api.getState(), selectedIds());
        const beforeIds = new Set(combat.combatants.map(item => String(item.tokenId)));
        const added = addCombatants(combat, refs);
        if (!added) { status('加入战斗：当前所选 Token 已全部在先攻表中'); render(); return false; }
        const addedRefs = refs.filter(ref => !beforeIds.has(String(ref.tokenId)));
        persist(`已加入 ${added} 个 Token · 新角色不会自动加入战斗`);
        logCombat(`加入战斗：${addedRefs.map(ref => tokenName(api.getState(), ref.tokenId)).join('、')}。`, { event: 'combatants-added', tokenIds: addedRefs.map(ref => ref.tokenId) });
        return true;
      }

      function focusToken(tokenId, { center = true } = {}) {
        const character = api.getState().characters?.find(item => String(item.id) === String(tokenId));
        if (!character) return false;
        api.selectCharacter?.(character.id);
        if (center && character.location?.type === 'map') api.map.panTo(worldToLatLng(character.location, api.mapPackage.height), { animate: true, duration: 0.25 });
        return true;
      }

      function focusCurrent(center = true) {
        const combat = store.state.combat;
        const current = combat?.state === 'active' ? currentCombatant(combat) : null;
        if (current) focusToken(current.tokenId, { center });
      }

      function beginCombat() {
        const combat = store.state.combat;
        if (!combat?.combatants?.length) { status('开始战斗：先攻表中没有参战者'); return false; }
        if (!startCombat(combat)) return false;
        const current = currentCombatant(combat);
        persist(`战斗开始 · 第 1 轮${current ? ` · 当前 ${current.tokenId}` : ''}`);
        if (current) logCombat(`第 1 轮开始 · 当前：${tokenName(api.getState(), current.tokenId)}。`, { event: 'combat-started', round: 1, tokenId: current.tokenId });
        else logCombat('战斗开始。', { event: 'combat-started', round: 1 });
        focusCurrent(false);
        return true;
      }

      function advanceTurn() {
        const combat = store.state.combat;
        const current = nextTurn(combat);
        if (!current) return false;
        persist(`第 ${combat.round} 轮 · 下一回合`);
        logCombat(`第 ${combat.round} 轮 · 轮到 ${tokenName(api.getState(), current.tokenId)}。`, { event: 'turn-started', round: combat.round, tokenId: current.tokenId });
        focusCurrent(false);
        return true;
      }

      function endCombat() {
        if (!store.state.combat) return;
        if (!window.confirm('结束当前战斗并清空先攻表？')) return;
        const round = store.state.combat.round || 0;
        store.clear();
        render();
        status('战斗已结束');
        logCombat(`战斗结束${round ? ` · 共进行至第 ${round} 轮` : ''}。`, { event: 'combat-ended', round });
      }

      top.addEventListener('click', event => {
        const action = event.target.closest?.('[data-combat-action]')?.dataset.combatAction;
        if (!action) return;
        if (action === 'enter') enterCombat();
        else if (action === 'add') addSelected();
        else if (action === 'start') beginCombat();
        else if (action === 'next') advanceTurn();
        else if (action === 'end') endCombat();
      });

      tracker.addEventListener('click', event => {
        const remove = event.target.closest?.('[data-combat-remove]');
        if (remove) {
          const combat = store.state.combat;
          if (!combat) return;
          const id = remove.dataset.combatRemove;
          const item = combat.combatants.find(entry => String(entry.id) === String(id));
          if (removeCombatant(combat, id)) {
            if (!combat.combatants.length) { store.clear(); render(); status('先攻表已清空'); }
            else persist('已将 Token 移出战斗');
            if (item) logCombat(`${tokenName(api.getState(), item.tokenId)} 离开战斗。`, { event: 'combatant-removed', tokenId: item.tokenId });
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
        const combat = store.state.combat;
        if (!combat) return;
        if (setCombatantInitiative(combat, input.dataset.combatInitiative, input.value)) {
          persist('先攻已更新 · 已按数值从高到低排列');
        }
      });

      tracker.addEventListener('dragstart', event => {
        const handle = event.target.closest?.('.combatant-drag');
        const row = handle?.closest?.('[data-combatant-id]');
        if (!row) return;
        draggingCombatantId = row.dataset.combatantId;
        event.dataTransfer?.setData('text/plain', draggingCombatantId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });

      tracker.addEventListener('dragover', event => {
        if (!draggingCombatantId) return;
        const row = event.target.closest?.('[data-combatant-id]');
        if (!row || row.dataset.combatantId === draggingCombatantId) return;
        event.preventDefault();
        tracker.querySelectorAll('.combatant-row.drag-over').forEach(node => node.classList.remove('drag-over'));
        row.classList.add('drag-over');
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });

      tracker.addEventListener('dragleave', event => { event.target.closest?.('.combatant-row')?.classList.remove('drag-over'); });

      tracker.addEventListener('drop', event => {
        const target = event.target.closest?.('[data-combatant-id]');
        if (!draggingCombatantId || !target) return;
        event.preventDefault();
        const combat = store.state.combat;
        if (combat && moveCombatant(combat, draggingCombatantId, target.dataset.combatantId)) persist('先攻顺序已手动调整');
        draggingCombatantId = null;
      });

      tracker.addEventListener('dragend', () => {
        draggingCombatantId = null;
        tracker.querySelectorAll('.combatant-row.drag-over').forEach(node => node.classList.remove('drag-over'));
      });

      selection?.subscribe?.(() => render());
      api.on('character:move', renderTurn);
      api.on('character:delete', event => {
        const combat = store.state.combat;
        const item = combat?.combatants?.find(entry => String(entry.tokenId) === String(event.detail?.id));
        if (!item) return;
        removeCombatant(combat, item.id);
        if (!combat.combatants.length) store.clear(); else store.persist();
        render();
        logCombat(`${tokenName(api.getState(), item.tokenId)} 的 Token 被移除，已退出战斗。`, { event: 'combatant-removed', tokenId: item.tokenId });
      });
      api.on('state:import', () => { if (store.saving) return; store.load(); render(); });

      render();
    },
  };
}
