import { deriveActorDocument, describeActorSheet } from '../actor/index.js';
import { normalizeEntityState } from '../entities/model.js';
import { describeHealth, healthModeOptions } from './model.js';

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

function resolveActorHealth(actor, ruleset) {
  return deriveActorDocument(actor, { ruleset })?.health || null;
}

function selectedTokenId(api) {
  const tokenId = api.selection?.getPrimaryTokenId?.();
  return tokenId == null ? null : String(tokenId);
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

function healthSignature(subjectId, state, view, variantId = '') {
  return [
    subjectId,
    variantId,
    state?.mode,
    state?.max,
    view.summary,
    view.status,
    ...(view.segments || []).flatMap(segment => [segment.id, segment.value]),
    ...(view.fields || []).flatMap(field => [field.id, field.value]),
  ].join('|');
}

function healthInput(field, actorId, disabled) {
  const min = Number.isFinite(Number(field.min)) ? ` min="${escapeHtml(field.min)}"` : '';
  const max = Number.isFinite(Number(field.max)) ? ` max="${escapeHtml(field.max)}"` : '';
  return `<input type="number"${min}${max} step="1" value="${escapeHtml(field.value)}" data-health-field-id="${escapeHtml(field.id)}" data-health-actor-id="${escapeHtml(actorId)}" aria-label="${escapeHtml(field.label || field.id)}"${disabled}>`;
}

export function renderActorHealthPanel(api, actor) {
  const health = resolveActorHealth(actor, api.ruleset);
  if (!health) return '';
  const view = describeHealth(health, { ruleset: api.ruleset });
  const editable = canEditHealth(api, actor.id);
  const disabled = editable ? '' : ' disabled title="需要 OWNER 权限且必须轮到该角色行动"';
  const width = value => health.max > 0 ? Math.max(0, Number(value) / health.max * 100) : 0;
  const fields = new Map((view.fields || []).map(field => [String(field.id), field]));
  const segmentIds = new Set((view.segments || []).map(segment => String(segment.id)));
  const segmentValues = (view.segments || []).map(segment => {
    const field = fields.get(String(segment.id));
    return `<label class="entity-health-value">${escapeHtml(segment.label || segment.id)}<b>${escapeHtml(segment.value)}</b>${field ? healthInput(field, actor.id, disabled) : ''}</label>`;
  });
  const extraValues = (view.fields || [])
    .filter(field => !segmentIds.has(String(field.id)))
    .map(field => `<label class="entity-health-value">${escapeHtml(field.label || field.id)}<b>${escapeHtml(field.value)}</b>${healthInput(field, actor.id, disabled)}</label>`);
  const values = [...segmentValues, ...extraValues].join('');
  const bar = (view.segments || []).length
    ? `<div class="entity-health-bar" title="${escapeHtml(view.summary)}">${view.segments.map(segment => `<span style="width:${width(segment.value)}%;background:${escapeHtml(segment.color || '#4b9f69')}" title="${escapeHtml(segment.label || segment.id)}"></span>`).join('')}</div>`
    : '';
  return `<section class="entity-section entity-health-panel" data-health-panel>
    <div class="entity-health-head"><h3>${escapeHtml(view.title || '生命系统')}</h3><label>模式 <select data-health-mode="${escapeHtml(actor.id)}"${disabled}>${modeOptionsHtml(health.mode, api.ruleset)}</select></label></div>
    ${bar}
    ${values ? `<div class="entity-health-values">${values}</div>` : ''}
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
        const health = resolveActorHealth(actor, api.ruleset);
        if (!health) {
          body.querySelector('[data-health-panel]')?.remove();
          return;
        }
        const view = describeHealth(health, { ruleset: api.ruleset });
        const variantId = describeActorSheet(actor, { ruleset: api.ruleset })?.currentVariantId || '';
        const signature = healthSignature(actor.id, health, view, variantId);
        const existing = body.querySelector('[data-health-panel]');
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
        const tokenId = selectedTokenId(api);
        const firstCard = inspector?.querySelector('.ui-inspector-card');
        if (!inspector || !tokenId || !firstCard) {
          inspector?.querySelector('[data-health-mini]')?.remove();
          return;
        }
        const health = api.health?.resolveToken?.(tokenId);
        if (!health) {
          inspector.querySelector('[data-health-mini]')?.remove();
          return;
        }
        const view = describeHealth(health, { ruleset: api.ruleset });
        const signature = healthSignature(tokenId, health, view);
        const existing = inspector.querySelector('[data-health-mini]');
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
        const health = actor ? resolveActorHealth(actor, api.ruleset) : null;
        const field = health ? describeHealth(health, { ruleset: api.ruleset }).fields?.find(item => String(item.id) === String(input.dataset.healthFieldId)) : null;
        if (!field || typeof field.operation !== 'function') return;
        const numeric = Math.floor(Number(input.value));
        const floor = Number.isFinite(Number(field.min)) ? Number(field.min) : 0;
        const value = Math.max(floor, Number.isFinite(numeric) ? numeric : floor);
        api.health?.performActorOperation?.(input.dataset.healthActorId, field.operation(value));
        queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
      });

      const observer = new MutationObserver(() => queueMicrotask(() => { enhanceSheet(); enhanceInspector(); }));
      observer.observe(documentNode.body, { childList: true, subtree: true });
      api.selection?.subscribe?.(() => queueMicrotask(enhanceInspector));
      api.on('state:import', () => queueMicrotask(() => { enhanceSheet(); enhanceInspector(); }));
      api.on('state:commit', () => queueMicrotask(() => { enhanceSheet(); enhanceInspector(); }));
      api.on('health:change', () => queueMicrotask(() => { enhanceSheet(); enhanceInspector(); }));
      queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
    },
  };
}
