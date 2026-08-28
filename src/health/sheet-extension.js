import { normalizeEntityState } from '../entities/model.js';
import { resolveActorHealth } from './actor.js';
import { describeHealth, healthModeOptions } from './model.js';
import { describeActorSheet } from '../actor/index.js';

const STYLE_ID = 'rpgmap-health-system-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function actorFromSheet(api, documentNode) {
  const actorId = documentNode.querySelector('.entity-sheet')?.dataset.actorId;
  if (!actorId) return null;
  const state = normalizeEntityState(api.getState().preferences?.entitySystem, { ruleset: api.ruleset });
  return state.actors.find(actor => String(actor.id) === String(actorId)) || null;
}

function selectedActor(api) {
  const tokenId = api.selection?.getPrimaryTokenId?.();
  if (!tokenId) return null;
  const state = normalizeEntityState(api.getState().preferences?.entitySystem, { ruleset: api.ruleset });
  const token = state.tokens.find(item => String(item.id) === String(tokenId));
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
    .entity-health-values { display:grid; grid-template-columns:repeat(4,minmax(90px,1fr)); gap:7px; }
    .entity-health-value { border:1px solid #dce3df; border-radius:8px; padding:8px; background:#f8faf8; }
    .entity-health-value b { display:block; font-size:18px; margin-top:2px; }
    .entity-health-value input { display:block; width:100%; box-sizing:border-box; margin-top:5px; padding:5px 6px; border:1px solid #cdd6d2; border-radius:6px; font:inherit; font-weight:800; }
    .entity-health-bar { display:flex; height:9px; border-radius:8px; overflow:hidden; background:#e7ebe8; }
    .entity-health-bar span { min-width:0; }
    .entity-health-status { font-size:12px; font-weight:800; color:#59676a; }
    .entity-health-status.is-danger { color:#a33c37; }
    .ui-health-mini { display:grid; gap:5px; padding:7px 8px; border-radius:7px; background:#f1f4f2; font-size:12px; }
    .ui-health-mini strong { color:#344548; }
    .ui-health-mini small { color:#697679; }
    @media (max-width:760px) { .entity-health-values{grid-template-columns:1fr 1fr;} }
  `;
  documentNode.head.append(style);
}

function canEditHealth(api, actorId) {
  const capabilities = api.multiplayer?.getCapabilities?.();
  return !capabilities || capabilities.canEditActor?.(actorId) !== false;
}

function modeOptionsHtml(mode, ruleset) {
  return healthModeOptions({ ruleset }).map(option => `<option value="${escapeHtml(option.id)}" ${String(mode) === String(option.id) ? 'selected' : ''}>${escapeHtml(option.label || option.id)}</option>`).join('');
}

function healthSignature(actor, state, view, ruleset) {
  return [
    actor.id,
    describeActorSheet(actor, { ruleset })?.currentVariantId,
    state?.mode,
    state?.max,
    view.summary,
    view.status,
    ...(view.segments || []).flatMap(segment => [segment.id, segment.value]),
    ...(view.fields || []).flatMap(field => [field.id, field.value]),
  ].join('|');
}

export function renderActorHealthPanel(api, actor) {
  const health = resolveActorHealth(actor, { ruleset: api.ruleset });
  if (!health) return '';
  const view = describeHealth(health, { ruleset: api.ruleset });
  const editable = canEditHealth(api, actor.id);
  const disabled = editable ? '' : ' disabled title="需要 OWNER 权限且必须轮到该角色行动"';
  const width = value => health.max > 0 ? Math.max(0, Number(value) / health.max * 100) : 0;
  const fields = new Map((view.fields || []).map(field => [String(field.id), field]));
  const values = (view.segments || []).map(segment => {
    const field = fields.get(String(segment.id));
    const input = field
      ? `<input type="number" min="${escapeHtml(field.min ?? 0)}" max="${escapeHtml(field.max ?? health.max)}" step="1" value="${escapeHtml(field.value)}" data-health-field-id="${escapeHtml(field.id)}" data-health-actor-id="${escapeHtml(actor.id)}" aria-label="${escapeHtml(field.label || segment.label)}"${disabled}>`
      : '';
    return `<label class="entity-health-value">${escapeHtml(segment.label || segment.id)}<b>${escapeHtml(segment.value)}</b>${input}</label>`;
  }).join('');
  const bar = (view.segments || []).length
    ? `<div class="entity-health-bar" title="${escapeHtml(view.summary)}">${view.segments.map(segment => `<span style="width:${width(segment.value)}%;background:${escapeHtml(segment.color || '#4b9f69')}" title="${escapeHtml(segment.label || segment.id)}"></span>`).join('')}</div>`
    : '';
  return `<section class="entity-section entity-health-panel" data-health-panel>
    <div class="entity-health-head"><h3>${escapeHtml(view.title || '生命系统')}</h3><label>模式 <select data-health-mode="${escapeHtml(actor.id)}"${disabled}>${modeOptionsHtml(health.mode, api.ruleset)}</select></label></div>
    ${view.hideBaseResource ? bar : ''}
    ${view.hideBaseResource && values ? `<div class="entity-health-values">${values}</div>` : ''}
    ${view.status ? `<div class="entity-health-status ${view.danger ? 'is-danger' : ''}">${escapeHtml(view.status)}</div>` : ''}
    ${view.help ? `<div class="entity-help">${escapeHtml(view.help)}</div>` : ''}
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
        if (!sheet || sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab !== 'overview') return;
        const actor = actorFromSheet(api, documentNode);
        const body = sheet.querySelector('.entity-sheet-body');
        if (!actor || !body) return;
        const health = resolveActorHealth(actor, { ruleset: api.ruleset });
        if (!health) {
          body.querySelector('[data-health-panel]')?.remove();
          const hpRow = body.querySelector('[data-sheet-role="health-base"]');
          if (hpRow) hpRow.style.display = '';
          return;
        }
        const view = describeHealth(health, { ruleset: api.ruleset });
        const signature = healthSignature(actor, health, view, api.ruleset);
        const existing = body.querySelector('[data-health-panel]');
        const hpRow = body.querySelector('[data-sheet-role="health-base"]');
        if (hpRow) hpRow.style.display = view.hideBaseResource ? 'none' : '';
        if (existing?.dataset.healthSignature === signature) return;
        enhancing = true;
        try {
          existing?.remove();
          body.insertAdjacentHTML('afterbegin', renderActorHealthPanel(api, actor));
          const panel = body.querySelector('[data-health-panel]');
          if (panel) panel.dataset.healthSignature = signature;
        } finally {
          enhancing = false;
        }
      }

      function enhanceInspector() {
        const inspector = documentNode.querySelector('.ui-current-inspector');
        const actor = selectedActor(api);
        const firstCard = inspector?.querySelector('.ui-inspector-card');
        if (!inspector || !actor || !firstCard) return;
        const health = resolveActorHealth(actor, { ruleset: api.ruleset });
        if (!health) {
          inspector.querySelector('[data-health-mini]')?.remove();
          return;
        }
        const view = describeHealth(health, { ruleset: api.ruleset });
        const hpMini = [...firstCard.querySelectorAll('.ui-resource-mini')].find(node => node.querySelector('span')?.textContent?.trim() === '生命');
        if (hpMini) hpMini.style.display = view.hideBaseResource ? 'none' : '';
        const signature = healthSignature(actor, health, view, api.ruleset);
        const existing = inspector.querySelector('[data-health-mini]');
        if (!view.hideBaseResource) { existing?.remove(); return; }
        if (existing?.dataset.healthSignature === signature) return;
        existing?.remove();
        const node = documentNode.createElement('div');
        node.className = 'ui-health-mini';
        node.dataset.healthMini = '1';
        node.dataset.healthSignature = signature;
        node.innerHTML = `<strong>生命 · ${escapeHtml(view.summary)}</strong><small>${escapeHtml(view.status)}</small>`;
        firstCard.querySelector('.ui-inspector-head')?.insertAdjacentElement('afterend', node);
      }

      documentNode.addEventListener('change', event => {
        const select = event.target.closest?.('[data-health-mode]');
        if (select) {
          api.health?.setMode?.(select.dataset.healthMode, select.value);
          queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
          return;
        }
        const input = event.target.closest?.('[data-health-field-id]');
        if (!input) return;
        const actor = actorFromSheet(api, documentNode);
        const health = actor ? resolveActorHealth(actor, { ruleset: api.ruleset }) : null;
        const field = health ? describeHealth(health, { ruleset: api.ruleset }).fields?.find(item => String(item.id) === String(input.dataset.healthFieldId)) : null;
        if (!field || typeof field.operation !== 'function') return;
        const value = Math.max(Number(field.min) || 0, Math.floor(Number(input.value) || 0));
        api.health?.performActorOperation?.(input.dataset.healthActorId, field.operation(value));
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
