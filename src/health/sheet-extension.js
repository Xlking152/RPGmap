import { normalizeEntityState } from '../entities/model.js';
import { resolveActorHealth } from './actor.js';
import { HEALTH_MODE_SIMPLE, HEALTH_MODE_WOUND_TRACK, formatHealthSummary, healthStatusLabel } from './model.js';

const STYLE_ID = 'rpgmap-health-system-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function actorFromSheet(api, documentNode) {
  const formId = documentNode.querySelector('.entity-sheet [data-form-select]')?.value;
  if (!formId) return null;
  const state = normalizeEntityState(api.getState().preferences?.entitySystem);
  return state.actors.find(actor => actor.forms?.some(form => String(form.id) === String(formId))) || null;
}

function selectedActor(api) {
  const tokenId = api.selection?.getPrimaryTokenId?.();
  if (!tokenId) return null;
  const state = normalizeEntityState(api.getState().preferences?.entitySystem);
  const token = state.tokens.find(item => String(item.characterId || item.id) === String(tokenId));
  return token ? state.actors.find(actor => String(actor.id) === String(token.actorId)) || null : null;
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .entity-health-panel { display:grid; gap:10px; }
    .entity-health-head { display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .entity-health-head label { display:flex; gap:6px; align-items:center; font-size:12px; color:#617073; }
    .entity-wound-values { display:grid; grid-template-columns:repeat(4,minmax(90px,1fr)); gap:7px; }
    .entity-wound-value { border:1px solid #dce3df; border-radius:8px; padding:8px; background:#f8faf8; }
    .entity-wound-value b { display:block; font-size:18px; margin-top:2px; }
    .entity-wound-value input { display:block; width:100%; box-sizing:border-box; margin-top:5px; padding:5px 6px; border:1px solid #cdd6d2; border-radius:6px; font:inherit; font-weight:800; }
    .entity-wound-bar { display:flex; height:9px; border-radius:8px; overflow:hidden; background:#e7ebe8; }
    .entity-wound-bar span { min-width:0; }
    .entity-wound-bar .healthy { background:#4b9f69; }
    .entity-wound-bar .bashing { background:#d9b84a; }
    .entity-wound-bar .lethal { background:#d77c42; }
    .entity-wound-bar .aggravated { background:#a94442; }
    .entity-health-status { font-size:12px; font-weight:800; color:#59676a; }
    .entity-health-status.is-danger { color:#a33c37; }
    .ui-health-mini { display:grid; gap:5px; padding:7px 8px; border-radius:7px; background:#f1f4f2; font-size:12px; }
    .ui-health-mini strong { color:#344548; }
    .ui-health-mini small { color:#697679; }
    @media (max-width:760px) { .entity-wound-values{grid-template-columns:1fr 1fr;} }
  `;
  documentNode.head.append(style);
}

function canEditHealth(api, actorId) {
  const capabilities = api.multiplayer?.getCapabilities?.();
  return !capabilities || capabilities.canEditActor?.(actorId) !== false;
}

function healthPanelHtml(api, actor) {
  const health = resolveActorHealth(actor);
  const editable = canEditHealth(api, actor.id);
  const disabled = editable ? '' : ' disabled title="需要 OWNER 权限且必须轮到该角色行动"';
  const options = `<option value="${HEALTH_MODE_WOUND_TRACK}" ${health.mode === HEALTH_MODE_WOUND_TRACK ? 'selected' : ''}>伤势生命槽 B/L/A</option><option value="${HEALTH_MODE_SIMPLE}" ${health.mode === HEALTH_MODE_SIMPLE ? 'selected' : ''}>普通 HP</option>`;
  if (health.mode === HEALTH_MODE_SIMPLE) {
    return `<section class="entity-section entity-health-panel" data-health-panel><div class="entity-health-head"><h3>生命系统</h3><label>模式 <select data-health-mode="${escapeHtml(actor.id)}"${disabled}>${options}</select></label></div><div class="entity-help">普通 HP 模式沿用原有“当前 / 最大”生命值。适合其他规则游戏。</div></section>`;
  }
  const width = value => health.max > 0 ? Math.max(0, value / health.max * 100) : 0;
  return `<section class="entity-section entity-health-panel" data-health-panel>
    <div class="entity-health-head"><h3>生命值 · 上限 ${health.max}</h3><label>模式 <select data-health-mode="${escapeHtml(actor.id)}"${disabled}>${options}</select></label></div>
    <div class="entity-wound-bar" title="${escapeHtml(formatHealthSummary(health))}"><span class="healthy" style="width:${width(health.healthy)}%"></span><span class="bashing" style="width:${width(health.bashing)}%"></span><span class="lethal" style="width:${width(health.lethal)}%"></span><span class="aggravated" style="width:${width(health.aggravated)}%"></span></div>
    <div class="entity-wound-values"><div class="entity-wound-value">完好<b>${health.healthy}</b></div><label class="entity-wound-value">冲击 B<b>${health.bashing}</b><input type="number" min="0" max="${health.max}" step="1" value="${health.bashing}" data-health-wound="bashing" data-health-actor-id="${escapeHtml(actor.id)}" aria-label="冲击 B 伤势"${disabled}></label><label class="entity-wound-value">严重 L<b>${health.lethal}</b><input type="number" min="0" max="${health.max}" step="1" value="${health.lethal}" data-health-wound="lethal" data-health-actor-id="${escapeHtml(actor.id)}" aria-label="严重 L 伤势"${disabled}></label><label class="entity-wound-value">恶性 A<b>${health.aggravated}</b><input type="number" min="0" max="${health.max}" step="1" value="${health.aggravated}" data-health-wound="aggravated" data-health-actor-id="${escapeHtml(actor.id)}" aria-label="恶性 A 伤势"${disabled}></label></div>
    <div class="entity-health-status ${health.dead || health.unconscious ? 'is-danger' : ''}">${escapeHtml(healthStatusLabel(health))}${health.deteriorating ? ' · 每轮伤势恶化规则请由操作者确认后处理' : ''}</div>
    <div class="entity-help">伤害由右侧“聊天 → 伤害”应用。这里显示的是生命槽结果；不会自动处理盔甲、硬度、DR、临时生命等伤害前置步骤。</div>
  </section>`;
}

export function createHealthSheetExtension() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      installStyles(documentNode);
      let enhancing = false;

      function enhanceSheet() {
        if (enhancing) return;
        const sheet = documentNode.querySelector('.entity-sheet');
        if (!sheet) return;
        const activeTab = sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab;
        if (activeTab !== 'overview') return;
        const actor = actorFromSheet(api, documentNode);
        if (!actor) return;
        const body = sheet.querySelector('.entity-sheet-body');
        if (!body) return;
        const health = resolveActorHealth(actor);
        const signature = [actor.id, actor.currentFormId, health.mode, health.max, health.healthy, health.bashing, health.lethal, health.aggravated].join('|');
        const existing = body.querySelector('[data-health-panel]');
        const hpRow = body.querySelector('[data-resource-id="hp"]');
        if (hpRow) hpRow.style.display = health.mode === HEALTH_MODE_WOUND_TRACK ? 'none' : '';
        if (existing?.dataset.healthSignature === signature) return;
        enhancing = true;
        try {
          existing?.remove();
          body.insertAdjacentHTML('afterbegin', healthPanelHtml(api, actor));
          const panel = body.querySelector('[data-health-panel]');
          if (panel) panel.dataset.healthSignature = signature;
        } finally {
          enhancing = false;
        }
      }

      function enhanceInspector() {
        const inspector = documentNode.querySelector('.ui-current-inspector');
        if (!inspector) return;
        const actor = selectedActor(api);
        const firstCard = inspector.querySelector('.ui-inspector-card');
        if (!actor || !firstCard) return;
        const health = resolveActorHealth(actor);
        const hpMini = [...firstCard.querySelectorAll('.ui-resource-mini')].find(node => node.querySelector('span')?.textContent?.trim() === '生命');
        if (hpMini) hpMini.style.display = health.mode === HEALTH_MODE_WOUND_TRACK ? 'none' : '';
        const signature = [actor.id, actor.currentFormId, health.mode, health.max, health.healthy, health.bashing, health.lethal, health.aggravated].join('|');
        const existing = inspector.querySelector('[data-health-mini]');
        if (health.mode !== HEALTH_MODE_WOUND_TRACK) { existing?.remove(); return; }
        if (existing?.dataset.healthSignature === signature) return;
        existing?.remove();
        const node = documentNode.createElement('div');
        node.className = 'ui-health-mini'; node.dataset.healthMini = '1'; node.dataset.healthSignature = signature;
        node.innerHTML = `<strong>生命 · ${escapeHtml(formatHealthSummary(health))}</strong><small>${escapeHtml(healthStatusLabel(health))}</small>`;
        firstCard.querySelector('.ui-inspector-head')?.insertAdjacentElement('afterend', node);
      }

      documentNode.addEventListener('change', event => {
        const select = event.target.closest?.('[data-health-mode]');
        if (select) {
          api.health?.setMode?.(select.dataset.healthMode, select.value);
          queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
          return;
        }
        const input = event.target.closest?.('[data-health-wound]');
        if (!input) return;
        const value = Math.max(0, Math.floor(Number(input.value) || 0));
        api.health?.setWounds?.(input.dataset.healthActorId, { [input.dataset.healthWound]: value });
        queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
      });

      const observer = new MutationObserver(() => queueMicrotask(() => { enhanceSheet(); enhanceInspector(); }));
      observer.observe(documentNode.body, { childList: true, subtree: true });
      api.selection?.subscribe?.(() => queueMicrotask(enhanceInspector));
      api.on('state:import', () => queueMicrotask(() => { enhanceSheet(); enhanceInspector(); }));
      api.on('state:commit', event => {
        const source = String(event.detail?.source || '');
        if (source === 'health' || source.startsWith('entities:resource')) queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
      });
      api.on('health:change', () => queueMicrotask(() => { enhanceSheet(); enhanceInspector(); }));
      queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
    },
  };
}
