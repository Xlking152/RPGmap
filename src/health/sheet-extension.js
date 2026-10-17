import { deriveActorDocument, describeActorSheet } from '../actor/index.js';
import { resolveActorEffects } from '../status/model.js';
import { describeHealth, healthModeOptions, healthOperationPresentation } from './model.js';
import { renderUiIcon } from '../ui/icons.js';

const STYLE_ID = 'rpgmap-health-system-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function subjectFromSheet(api, sheet) {
  const actorId = sheet?.dataset.actorId;
  if (!actorId) return null;
  const baseActor = api.tokens?.getActor?.(actorId) || null;
  if (!baseActor || baseActor.audienceRestricted === true) return null;
  const tokenId = String(sheet.dataset.tokenId || '').trim() || null;
  if (!tokenId) return { actor: baseActor, actorId: String(actorId), tokenId: null };
  const actor = api.tokens?.resolveActor?.(tokenId)?.actor || null;
  return actor && actor.audienceRestricted !== true
    ? { actor, actorId: String(actorId), tokenId }
    : null;
}

function actorContext(api, actor) {
  return {
    ruleset: api?.ruleset,
    effects: resolveActorEffects(actor, api.status?.getDefinitions?.() || []),
  };
}

function mutationTouches(records, selector) {
  return records.some(record => {
    const target = record.target?.nodeType === 1 ? record.target : null;
    if (target?.closest?.(selector)) return true;
    return [...(record.addedNodes || [])].some(node => node.nodeType === 1
      && (node.matches?.(selector) || node.querySelector?.(selector)));
  });
}

function resolveActorHealth(actor, api) {
  if (!api?.ruleset?.health) return null;
  return deriveActorDocument(actor, actorContext(api, actor))?.health || null;
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
    .entity-health-head h3 { margin:0; display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; }
    .entity-health-compact { font-size:18px; color:#344548; letter-spacing:.2px; }
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

function canEditHealth(api, actor, tokenId = null) {
  if (!tokenId && ['monster', 'npc', 'summon'].includes(String(actor?.type || ''))) return false;
  if (tokenId && api.multiplayer?.getStatus?.()?.connected) {
    return api.multiplayer?.canControlToken?.(tokenId) === true;
  }
  const capabilities = api.multiplayer?.getCapabilities?.();
  return !capabilities || capabilities.canEditActor?.(actor.id) !== false;
}

function canEditTemplateHealthMode(api, actor, sheet) {
  if (!['monster', 'npc', 'summon'].includes(String(actor?.type || ''))) return false;
  if (sheet?.dataset?.sheetMode !== 'template' || sheet?.dataset?.sheetInteractionMode !== 'edit') return false;
  const multiplayer = api.multiplayer?.getStatus?.();
  if (multiplayer?.connected && multiplayer.session?.role !== 'gm') return false;
  if (api.permissions?.can) return api.permissions.can('actor.edit', { actorId: actor.id, actor }) === true;
  return true;
}

function disabledReason(actor, tokenId = null) {
  if (!tokenId && ['monster', 'npc', 'summon'].includes(String(actor?.type || ''))) {
    return '怪物、NPC 与召唤物模板的生命只能从 Token 实例修改';
  }
  return tokenId ? '当前没有该 Token 实例的控制权限' : '需要该 Actor 的 OWNER 权限';
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
    view.compactSummary,
    view.status,
    ...(view.segments || []).flatMap(segment => [segment.id, segment.value]),
    ...(view.fields || []).flatMap(field => [field.id, field.value]),
  ].join('|');
}

function healthInput(field, actorId, tokenId, disabled) {
  const min = Number.isFinite(Number(field.min)) ? ` min="${escapeHtml(field.min)}"` : '';
  const max = Number.isFinite(Number(field.max)) ? ` max="${escapeHtml(field.max)}"` : '';
  return `<input type="number"${min}${max} step="1" value="${escapeHtml(field.value)}" data-health-field-id="${escapeHtml(field.id)}" data-health-actor-id="${escapeHtml(actorId)}" data-health-token-id="${escapeHtml(tokenId || '')}" aria-label="${escapeHtml(field.label || field.id)}"${disabled}>`;
}

export function renderActorHealthPanel(api, actor, { actorId = actor.id, tokenId = null, sheet = null } = {}) {
  if (actor?.audienceRestricted === true) return '';
  const health = resolveActorHealth(actor, api);
  if (!health) return '';
  const view = describeHealth(health, { ruleset: api.ruleset });
  const editable = canEditHealth(api, actor, tokenId);
  const disabled = editable ? '' : ` disabled title="${escapeHtml(disabledReason(actor, tokenId))}"`;
  const independentTemplate = !tokenId && ['monster', 'npc', 'summon'].includes(String(actor?.type || ''));
  const modeEditable = editable || canEditTemplateHealthMode(api, actor, sheet);
  const modeDisabled = modeEditable ? '' : ` disabled title="${escapeHtml(independentTemplate ? '请以 GM 身份切换到“编辑卡片”修改新实例的默认生命规则' : disabledReason(actor, tokenId))}"`;
  const width = value => health.max > 0 ? Math.max(0, Number(value) / health.max * 100) : 0;
  const fields = new Map((view.fields || []).map(field => [String(field.id), field]));
  const segmentIds = new Set((view.segments || []).map(segment => String(segment.id)));
  const segmentValues = (view.segments || []).map(segment => {
    const field = fields.get(String(segment.id));
    return `<label class="entity-health-value">${escapeHtml(segment.label || segment.id)}<b>${escapeHtml(segment.value)}</b>${field ? healthInput(field, actorId, tokenId, disabled) : ''}</label>`;
  });
  const extraValues = (view.fields || [])
    .filter(field => !segmentIds.has(String(field.id)))
    .map(field => `<label class="entity-health-value">${escapeHtml(field.label || field.id)}<b>${escapeHtml(field.value)}</b>${healthInput(field, actorId, tokenId, disabled)}</label>`);
  const values = [...segmentValues, ...extraValues].join('');
  const valuesHtml = values ? `<div class="entity-health-values">${values}</div>` : '';
  const play = sheet?.dataset?.sheetInteractionMode === 'play';
  const adjustments = play && valuesHtml
    ? `<details class="entity-health-adjustments"><summary>修正生命数值</summary>${valuesHtml}</details>`
    : valuesHtml;
  const legend = play && (view.segments || []).length > 1
    ? `<div class="entity-health-legend">${view.segments.map(segment => `<span>${escapeHtml(segment.label || segment.id)} <strong>${escapeHtml(segment.value)}</strong></span>`).join('')}</div>`
    : '';
  const bar = (view.segments || []).length
    ? `<div class="entity-health-bar" title="${escapeHtml(view.summary)}">${view.segments.map(segment => `<span style="width:${width(segment.value)}%;background:${escapeHtml(segment.color || '#4b9f69')}" title="${escapeHtml(segment.label || segment.id)}"></span>`).join('')}</div>`
    : '';
  const actionRows = tokenId && editable ? ['damage', 'healing'].map(operation => {
    const config = healthOperationPresentation(operation, { ruleset: api.ruleset });
    const types = Array.isArray(config.types) ? config.types : [];
    return `<div class="entity-play-health-action" data-sheet-health-row="${operation}"><label><span>${operation === 'damage' ? '伤害' : '恢复'}</span><input type="number" min="1" step="1" value="1" data-sheet-health-amount aria-label="${operation === 'damage' ? '伤害' : '恢复'}数值"></label>${types.length ? `<select data-sheet-health-type aria-label="${operation === 'damage' ? '伤害' : '恢复'}类型">${types.map(type => `<option value="${escapeHtml(type.id)}" ${String(type.id) === String(config.defaultType) ? 'selected' : ''}>${escapeHtml(type.label || type.id)}</option>`).join('')}</select>` : ''}<button type="button" class="small-button" data-sheet-health-action="${operation}" title="${operation === 'damage' ? '施加伤害' : '恢复生命'}" aria-label="${operation === 'damage' ? '施加伤害' : '恢复生命'}">${renderUiIcon(operation === 'damage' ? 'minus' : 'plus')}</button></div>`;
  }).join('') : '';
  return `<section class="entity-section entity-health-panel" data-health-panel>
    <div class="entity-health-head"><h3>${escapeHtml(view.title || '生命系统')}${view.compactSummary ? `<span class="entity-health-compact">${escapeHtml(view.compactSummary)}</span>` : ''}</h3><label data-sheet-edit-only>${independentTemplate ? '默认生命规则（新实例）' : '模式'} <select data-health-mode="${escapeHtml(actorId)}" data-health-token-id="${escapeHtml(tokenId || '')}"${modeDisabled}>${modeOptionsHtml(health.mode, api.ruleset)}</select></label></div>
    ${bar}
    ${legend}
    ${actionRows ? `<div class="entity-play-health-actions">${actionRows}</div><div class="entity-play-health-feedback" data-sheet-health-feedback role="status"></div>` : ''}
    ${view.status ? `<div class="entity-health-status ${view.danger ? 'is-danger' : ''}">${escapeHtml(view.status)}</div>` : ''}
    ${adjustments}
    ${view.help ? `<div class="entity-help" data-sheet-edit-only>${escapeHtml(view.help)}</div>` : ''}
    ${independentTemplate ? '<div class="entity-help">此设置只影响之后创建的独立 Token；现有实例的生命规则和当前生命不会改变。实例当前生命请从 Token 卡修改。</div>' : ''}
  </section>`;
}

export async function applySheetHealthAction(api, { actorId, tokenId }, operation, { amount, type }) {
  const token = tokenId && api.tokens?.get?.(tokenId);
  if (!token || String(token.actorId) !== String(actorId)) throw new Error('生命操作需要有效的棋子实例');
  const actor = api.tokens?.resolveActor?.(tokenId)?.actor;
  if (!actor || actor.audienceRestricted === true || !canEditHealth(api, actor, tokenId)) throw new Error('没有该棋子的生命修改权限');
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('请输入大于 0 的整数');
  const method = operation === 'damage' ? 'applyDamageToTokenIds' : operation === 'healing' ? 'applyHealingToTokenIds' : null;
  if (!method || typeof api.health?.[method] !== 'function') throw new Error('当前规则不支持此生命操作');
  return api.health[method]([String(tokenId)], { amount: value, type: String(type || '') });
}

function sheetShowsHealth(sheet, actor) {
  if (!sheet || !actor || sheet.dataset.sheetMode === 'limited' || actor.audienceRestricted === true) return false;
  const activeTab = String(sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '');
  if (activeTab === 'overview') return true;
  return activeTab === 'combat' && ['monster', 'summon'].includes(String(actor.type || ''));
}

export function createHealthSheetExtension() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      installStyles(documentNode);
      let enhancing = false;
      const pendingSubjects = new Set();

      function enhanceSheet(sheet) {
        if (enhancing || !sheet) return;
        const body = sheet.querySelector('.entity-sheet-body');
        if (!body) return;
        const subject = subjectFromSheet(api, sheet);
        const actor = subject?.actor;
        if (!sheetShowsHealth(sheet, actor)) {
          body.querySelector('[data-health-panel]')?.remove();
          return;
        }
        const health = resolveActorHealth(actor, api);
        if (!health) {
          body.querySelector('[data-health-panel]')?.remove();
          return;
        }
        const view = describeHealth(health, { ruleset: api.ruleset });
        const variantId = describeActorSheet(actor, actorContext(api, actor))?.currentVariantId || '';
        const pending = pendingSubjects.has(subject.tokenId);
        const signature = `${healthSignature(subject.tokenId || actor.id, health, view, variantId)}|${sheet.dataset.sheetInteractionMode}|${canEditHealth(api, actor, subject.tokenId)}|${pending}`;
        const existing = body.querySelector('[data-health-panel]');
        if (existing?.dataset.healthSignature === signature) return;
        enhancing = true;
        try {
          existing?.remove();
          body.insertAdjacentHTML('afterbegin', renderActorHealthPanel(api, actor, { ...subject, sheet }));
          const panel = body.querySelector('[data-health-panel]');
          if (panel) {
            panel.dataset.healthSignature = signature;
            panel.dataset.healthPending = String(pending);
            panel.querySelectorAll('[data-sheet-health-action]').forEach(control => { control.disabled = pending; });
          }
        } finally {
          enhancing = false;
        }
      }

      documentNode.addEventListener('click', async event => {
        const button = event.target.closest?.('[data-sheet-health-action]');
        if (!button) return;
        const sheet = button.closest('.entity-sheet');
        const subject = subjectFromSheet(api, sheet);
        if (!subject?.tokenId || pendingSubjects.has(subject.tokenId)) return;
        const row = button.closest('[data-sheet-health-row]');
        const panel = button.closest('[data-health-panel]');
        const feedback = panel.querySelector('[data-sheet-health-feedback]');
        pendingSubjects.add(subject.tokenId);
        panel.dataset.healthPending = 'true';
        panel.querySelectorAll('[data-sheet-health-action]').forEach(control => { control.disabled = true; });
        feedback.textContent = '正在结算…';
        try {
          await applySheetHealthAction(api, subject, button.dataset.sheetHealthAction, {
            amount: row.querySelector('[data-sheet-health-amount]')?.value,
            type: row.querySelector('[data-sheet-health-type]')?.value || '',
          });
          feedback.textContent = '已确认';
        } catch (error) {
          feedback.textContent = `未应用：${error?.message || error}`;
          api.showToast?.(feedback.textContent, 'error');
        } finally {
          pendingSubjects.delete(subject.tokenId);
          panel.dataset.healthPending = 'false';
          panel.querySelectorAll('[data-sheet-health-action]').forEach(control => { control.disabled = false; });
          queueMicrotask(enhanceSheets);
        }
      });

      function enhanceSheets() {
        for (const sheet of documentNode.querySelectorAll('.entity-sheet')) enhanceSheet(sheet);
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
        node.innerHTML = `<strong>生命 · ${escapeHtml(view.compactSummary || view.summary)}</strong><small>${escapeHtml(view.status)}</small>`;
        firstCard.querySelector('.ui-inspector-head')?.insertAdjacentElement('afterend', node);
      }

      documentNode.addEventListener('change', async event => {
        const select = event.target.closest?.('[data-health-mode]');
        if (select) {
          const sheet = select.closest('.entity-sheet');
          try {
            await api.health?.setMode?.(select.dataset.healthMode, select.value, {
              tokenId: String(select.dataset.healthTokenId || '').trim() || null,
            });
          } catch (error) {
            console.error('[RPGmap Health UI] mode update failed', error);
            api.showToast?.(`生命规则保存失败：${error?.message || error}`, 'error');
          } finally {
            sheet?.querySelector('[data-health-panel]')?.remove();
            queueMicrotask(() => { enhanceSheet(sheet); enhanceInspector(); });
          }
          return;
        }
        const input = event.target.closest?.('[data-health-field-id]');
        if (!input) return;
        const sheet = input.closest('.entity-sheet');
        const subject = subjectFromSheet(api, sheet);
        const actor = subject?.actor;
        const health = actor ? resolveActorHealth(actor, api) : null;
        const field = health ? describeHealth(health, { ruleset: api.ruleset }).fields?.find(item => String(item.id) === String(input.dataset.healthFieldId)) : null;
        if (!field || typeof field.operation !== 'function') return;
        const numeric = Math.floor(Number(input.value));
        const floor = Number.isFinite(Number(field.min)) ? Number(field.min) : 0;
        const value = Math.max(floor, Number.isFinite(numeric) ? numeric : floor);
        try {
          await api.health?.performActorOperation?.(input.dataset.healthActorId, field.operation(value), {
            tokenId: String(input.dataset.healthTokenId || '').trim() || null,
          });
        } catch (error) {
          console.error('[RPGmap Health UI] runtime update failed', error);
        } finally {
          queueMicrotask(() => { enhanceSheet(sheet); enhanceInspector(); });
        }
      });

      const observer = new MutationObserver(records => {
        if (mutationTouches(records, '.entity-sheet')) queueMicrotask(enhanceSheets);
        if (mutationTouches(records, '.ui-current-inspector')) queueMicrotask(enhanceInspector);
      });
      observer.observe(documentNode.body, { childList: true, subtree: true });
      api.selection?.subscribe?.(() => queueMicrotask(enhanceInspector));
      api.on('state:import', () => queueMicrotask(() => { enhanceSheets(); enhanceInspector(); }));
      api.on('state:commit', () => queueMicrotask(() => { enhanceSheets(); enhanceInspector(); }));
      api.on('health:change', () => queueMicrotask(() => { enhanceSheets(); enhanceInspector(); }));
      queueMicrotask(() => { enhanceSheets(); enhanceInspector(); });
    },
  };
}
