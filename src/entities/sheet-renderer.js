import { describeActor } from '../actor/index.js';
import { normalizeActorClassification } from '../actor/classification.js';
import { renderUiIcon } from '../ui/icons.js';

const STYLE_ID = 'rpgmap-entity-system-style';

export function escapeEntityHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

export function editableEntityTarget(target) {
  return target instanceof HTMLElement
    && Boolean(target.closest('input,textarea,select,[contenteditable="true"]'));
}

export function matchesEntitySearch(text, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  return !normalizedQuery || String(text || '').toLocaleLowerCase().includes(normalizedQuery);
}

export function installEntityStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-tool="marker"], [data-tool="marker-select"], [data-action="clear-markers"], [data-tab="markers"] { display:none !important; }
    .entity-toolbar-button { white-space:nowrap; }
    .entity-panel { display:grid; gap:10px; }
    .entity-panel-head { display:flex; gap:7px; flex-wrap:wrap; align-items:center; }
    .entity-help { font-size:12px; color:#687477; line-height:1.55; }
    .entity-card { border:1px solid rgba(70,90,90,.2); border-radius:10px; padding:10px; background:rgba(255,255,255,.72); display:grid; gap:8px; }
    .entity-card-top { display:flex; align-items:center; gap:9px; }
    .entity-avatar, .entity-avatar img { width:42px; height:42px; border-radius:50%; object-fit:cover; }
    .entity-avatar { display:grid; place-items:center; background:#3d9b63; color:#fff; font-weight:800; overflow:hidden; flex:0 0 auto; }
    .entity-card-copy { min-width:0; flex:1; }
    .entity-card-copy strong { display:block; font-size:14px; overflow:hidden; text-overflow:ellipsis; }
    .entity-card-copy small { color:#667477; }
    .entity-card-actions { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .entity-card-actions label { display:inline-flex; gap:5px; align-items:center; }
    .entity-card-actions input[type="number"] { width:72px; }
    .token-config { overflow:hidden; }
    .token-movement-adjudication { margin:6px 10px 0; padding:7px 9px; border-left:3px solid #a66b16; background:#fff4d8; color:#71470c; font-size:12px; overflow-wrap:anywhere; }
    .token-config-tabs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-bottom:1px solid #dce3e0; }
    .token-config-tabs button { min-width:0; border-top:1px solid #dce3e0; padding:9px 4px; cursor:pointer; font-weight:750; }
    .token-config-tabs button.active { background:#fff; }
    .token-config-body { min-width:0; }
    .token-config-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:end; }
    .token-config-grid label { min-width:0; display:grid; font-size:12px; }
    .token-config-grid input:not([type="checkbox"]), .token-config-grid select { width:100%; min-width:0; box-sizing:border-box; }
    .token-config-check { display:flex !important; align-items:center; align-self:center; }
    .token-config-feedback { grid-column:1/-1; }
    .token-config-feedback.pending { color:#785d14; }
    .token-config-feedback.confirmed { color:#247346; }
    .token-config-feedback.error { color:#a12f2f; }
    .token-config-advanced { display:grid; }
    .token-config-advanced pre { max-height:180px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
    .entity-sheet-backdrop { position:fixed; inset:0; z-index:4200; background:rgba(18,23,24,.48); display:grid; place-items:center; padding:24px; }
    .entity-sheet-backdrop.entity-sheet-window { display:block; padding:0; background:transparent; pointer-events:none; }
    .entity-sheet-window > .entity-sheet { position:fixed; pointer-events:auto; }
    .entity-sheet { width:min(880px,94vw); box-sizing:border-box; }
    .entity-sheet-header { position:sticky; top:0; z-index:3; display:flex; cursor:default; }
    .entity-sheet-header .entity-avatar, .entity-sheet-header .entity-avatar img { width:64px; height:64px; }
    .entity-sheet-title { flex:1; }
    .entity-sheet-title input { width:100%; font-size:20px; font-weight:800; border:0; border-bottom:1px solid #aab5b3; background:transparent; padding:3px 0; }
    .entity-formbar { display:flex; align-items:center; flex-wrap:wrap; }
    .entity-formbar select { min-width:140px; }
    .entity-sheet-tabs { display:flex; min-width:0; overflow-x:auto; }
    .entity-sheet-tab { white-space:nowrap; border:0; background:transparent; cursor:pointer; }
    .entity-sheet-body { display:grid; }
    .entity-resource { display:grid; align-items:center; }
    .entity-resource-bar { grid-column:1/-1; overflow:hidden; }
    .entity-resource-bar span { display:block; height:100%; }
    .entity-grid { display:grid; }
    .entity-stat { display:grid; grid-template-columns:1fr auto; gap:5px 9px; align-items:center; }
    .entity-stat small { grid-column:1/-1; }
    .entity-detection-ranges, .entity-detection-senses { display:flex; flex-wrap:wrap; align-items:center; }
    .entity-detection-range { display:grid; grid-template-columns:auto 76px; gap:3px 8px; align-items:center; }
    .entity-detection-range small { grid-column:1/-1; color:#758082; }
    .entity-detection-sense { display:inline-flex; gap:5px; align-items:center; border:1px solid #d8dfdc; }
    .entity-check-table { border-collapse:collapse; }
    .entity-check-table th, .entity-check-table td { border-bottom:1px solid #e0e5e2; text-align:left; vertical-align:top; }
    .entity-check-table th { font-size:11px; }
    .entity-description { white-space:pre-wrap; line-height:1.6; }
    .entity-empty { color:#7b8587; padding:16px 4px; text-align:center; }
    .entity-indicator { position:absolute; z-index:2600; left:50%; top:70px; transform:translateX(-50%); padding:7px 12px; border-radius:8px; color:#fff; background:rgba(23,109,118,.94); box-shadow:0 4px 16px rgba(0,0,0,.25); font-weight:800; pointer-events:none; animation:entity-indicator 1.2s ease forwards; }
    .entity-placement-hud { position:fixed; z-index:4300; left:50%; bottom:max(18px,env(safe-area-inset-bottom)); transform:translateX(-50%); display:flex; align-items:center; gap:10px; max-width:calc(100vw - 24px); padding:10px 12px; border:1px solid rgba(23,109,118,.45); border-radius:10px; background:#f8faf7; color:#25383a; box-shadow:0 10px 30px rgba(0,0,0,.24); font-weight:750; }
    .entity-placement-hud button { flex:0 0 auto; }
    .entity-sheet-readonly input, .entity-sheet-readonly select, .entity-sheet-readonly [data-sheet-action]:not([data-sheet-action="close"]) { pointer-events:none; opacity:.55; }
    .entity-sheet-v3 { min-width:560px; }
    .entity-sheet-v3-badges { display:flex; flex-wrap:wrap; align-items:center; }
    .entity-sheet-v3-badge { letter-spacing:.35px; }
    .entity-sheet-v3-mode-toggle { border-radius:7px; cursor:pointer; }
    .entity-sheet-v3[data-sheet-interaction-mode="play"] [data-sheet-edit-only] { display:none !important; }
    .entity-sheet-v3[data-sheet-interaction-mode="play"] [data-actor-name] { border-bottom-color:transparent; color:inherit; opacity:1; cursor:default; }
    .entity-limited-sheet.entity-sheet-v3 { min-width:360px; width:min(520px,92vw); }
    .entity-limited-sheet.entity-sheet-v3 .entity-sheet-header .entity-avatar, .entity-limited-sheet.entity-sheet-v3 .entity-sheet-header .entity-avatar img { width:78px; height:78px; border-radius:10px; }
    .entity-public-profile-editor { display:grid; }
    .entity-field-notices { position:sticky; bottom:0; z-index:4; padding:8px 12px; border-top:1px solid #d3b263; font-size:12px; }
    .entity-field-notices[hidden] { display:none; }
    .entity-field-notices > div { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:3px 0; }
    .entity-field-notices span { flex:1 1 160px; overflow-wrap:anywhere; }
    [data-sheet-field-state="conflict"] { outline:2px solid #ba741d; outline-offset:1px; }
    .entity-public-profile-editor > label { display:grid; gap:5px; }
    .entity-public-profile-editor textarea { width:100%; box-sizing:border-box; resize:vertical; font:inherit; padding:7px; border:1px solid #aab8b4; border-radius:4px; }
    .entity-public-status-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px 10px; max-height:180px; overflow:auto; }
    .entity-public-status-option { display:flex; gap:5px; align-items:center; }
    .entity-public-profile-preview { display:grid; gap:10px; padding:10px; border:1px dashed #b8c6c1; border-radius:8px; background:#f5f7f4; }
    .entity-known-facts { margin:0; padding-left:20px; display:grid; gap:6px; }
    .entity-public-status-list { display:flex; flex-wrap:wrap; }
    .entity-public-status { display:inline-flex; align-items:center; gap:5px; padding:5px 8px; border:1px solid var(--status-color); background:#fff; }
    .entity-template-runtime-readonly [data-actor-operation], .entity-template-runtime-readonly [data-form-select], .entity-template-runtime-readonly [data-sheet-action="cycle-form"] { pointer-events:none; opacity:.55; }
    @keyframes entity-indicator { 0%{opacity:0;transform:translate(-50%,-6px)} 15%,75%{opacity:1;transform:translate(-50%,0)} 100%{opacity:0;transform:translate(-50%,-8px)} }
    @media(max-width:760px){
      .entity-sheet-v3{min-width:0;width:calc(100vw - 16px)!important;max-width:calc(100vw - 16px);left:8px!important;top:8px!important;height:calc(100vh - 16px)!important;max-height:calc(100vh - 16px)}
      .entity-public-status-options{grid-template-columns:1fr}
      .entity-sheet-backdrop:not(.entity-sheet-window){padding:8px}
      .entity-sheet-window > .entity-sheet{max-width:calc(100vw - 16px);max-height:calc(100vh - 16px)}
      .entity-resource .entity-resource-edit{grid-column:1/-1}
      .token-config-grid{grid-template-columns:1fr}
      .token-config-feedback{grid-column:1}
      .token-config-tabs button{padding-inline:2px}
    }
  `;
  documentNode.head.append(style);
}

export function entityAvatarHtml(actor, ruleset) {
  const presentation = describeActor(actor, { ruleset }) || {};
  const avatar = presentation.avatarDataUrl;
  if (avatar) return `<span class="entity-avatar"><img ${contentImageAttributes(avatar, escapeEntityHtml)} alt=""></span>`;
  return `<span class="entity-avatar">${escapeEntityHtml((actor?.name?.trim()?.[0] || '?').toUpperCase())}</span>`;
}

export function encodeEntityData(value) {
  return escapeEntityHtml(encodeURIComponent(JSON.stringify(value || {})));
}

export function decodeEntityData(value) {
  try { return JSON.parse(decodeURIComponent(String(value || ''))); }
  catch { return null; }
}

function operationData(operation, extra = '') {
  return operation ? ` data-actor-operation="${encodeEntityData(operation)}"${extra}` : '';
}

function renderTableCell(cell) {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return `<td>${escapeEntityHtml(cell ?? '')}</td>`;
  if (!cell.input) return `<td>${escapeEntityHtml(cell.value ?? '')}</td>`;
  const levelClass = cell.level ? ` entity-value-${escapeEntityHtml(cell.level)}` : '';
  return `<td><input class="entity-table-input${levelClass}" type="number" step="1" min="${escapeEntityHtml(cell.min ?? '')}" value="${escapeEntityHtml(cell.value ?? 0)}"${operationData(cell.operation)}></td>`;
}

export function renderEntitySheetSection(section) {
  if (!section || typeof section !== 'object') return '';
  const title = section.title ? `<h3>${escapeEntityHtml(section.title)}</h3>` : '';
  const help = section.help ? `<p class="entity-help">${escapeEntityHtml(section.help)}</p>` : '';
  if (section.type === 'resources') {
    const items = (section.items || []).map(item => {
      const ratio = Number(item.max) > 0
        ? Math.max(0, Math.min(100, Number(item.current) / Number(item.max) * 100))
        : 0;
      return `<div class="entity-resource" data-sheet-role="${escapeEntityHtml(item.role || '')}" title="${escapeEntityHtml(item.explanation || '')}">
        <strong class="entity-resource-name">${escapeEntityHtml(item.label || item.id)}</strong>
        <button type="button" class="small-button entity-resource-decrement" title="减少${escapeEntityHtml(item.label || item.id)}" aria-label="减少${escapeEntityHtml(item.label || item.id)}"${operationData(item.decrementOperation)}>−</button>
        <label class="entity-resource-current"><span>当前</span><input aria-label="${escapeEntityHtml(item.label || item.id)}当前值" type="number" step="1" value="${escapeEntityHtml(item.current)}"${operationData(item.currentOperation)}></label>
        <label class="entity-resource-edit"><span>最大</span><input aria-label="${escapeEntityHtml(item.label || item.id)}最大值" type="number" step="1" min="0" value="${escapeEntityHtml(item.max)}" title="当前最大值；修改会建立运行时覆盖"${operationData(item.maxOperation)}></label>
        <div class="entity-resource-bar" aria-hidden="true"><span style="width:${ratio}%"></span></div>
        ${item.deleteOperation ? `<button type="button" class="small-button danger" data-operation-confirm="删除这个特殊能量槽？"${operationData(item.deleteOperation)}>删除 ${escapeEntityHtml(item.label || item.id)}</button>` : ''}
      </div>`;
    }).join('');
    const actions = (section.actions || []).map(action => `<button type="button" class="small-button" data-operation-prompts="${encodeEntityData(action.prompts || [])}"${operationData(action.operation)}>${escapeEntityHtml(action.label || '执行')}</button>`).join('');
    return `<section class="entity-section" data-sheet-section-id="${escapeEntityHtml(section.id || '')}">${title}${items}${actions}${help}</section>`;
  }
  if (section.type === 'stats') {
    const items = (section.items || []).map(item => `<div class="entity-stat"><span>${escapeEntityHtml(item.label || item.id)}</span><strong>${escapeEntityHtml(item.value)}</strong><small>${escapeEntityHtml(item.detail || '')}</small><label>临时 <input type="number" step="1" value="${escapeEntityHtml(item.adjustment || 0)}"${operationData(item.operation)}></label></div>`).join('');
    return `<section class="entity-section" data-sheet-section-id="${escapeEntityHtml(section.id || '')}">${title}<div class="entity-grid">${items || '<div class="entity-empty">暂无数据。</div>'}</div>${help}</section>`;
  }
  if (section.type === 'detection') {
    const ranges = (section.ranges || []).map(item => `<label class="entity-detection-range"><span>${escapeEntityHtml(item.label)}</span><input type="number" min="0" step="1" value="${escapeEntityHtml(item.value)}"${operationData(item.operation)}><small>形态基础 ${escapeEntityHtml(item.base)} m</small></label>`).join('');
    const senses = (section.senses || []).map(item => `<label class="entity-detection-sense"><input type="checkbox"${item.value ? ' checked' : ''}${operationData(item.operation)}> ${escapeEntityHtml(item.label)}<small>基础 ${item.base ? '是' : '否'}</small></label>`).join('');
    return `<section class="entity-section" data-sheet-section-id="${escapeEntityHtml(section.id || '')}">${title}<div class="entity-detection-ranges">${ranges}</div><div class="entity-detection-senses">${senses}</div>${help}</section>`;
  }
  if (section.type === 'table') {
    const columns = (section.columns || []).map(column => `<th>${escapeEntityHtml(column)}</th>`).join('');
    const rows = (section.rows || []).map(row => `<tr>${(Array.isArray(row) ? row : []).map(renderTableCell).join('')}</tr>`).join('');
    const body = rows || `<tr><td colspan="${Math.max(1, section.columns?.length || 1)}" class="entity-empty">${escapeEntityHtml(section.emptyMessage || '暂无数据。')}</td></tr>`;
    return `<section class="entity-section" data-sheet-section-id="${escapeEntityHtml(section.id || '')}">${title}${help}<div class="entity-table-scroll" role="region" aria-label="${escapeEntityHtml(section.title || '角色数据')}" tabindex="0"><table class="entity-check-table"><thead><tr>${columns}</tr></thead><tbody>${body}</tbody></table></div></section>`;
  }
  if (section.type === 'text') {
    const blocks = (section.blocks || []).map(block => `<p class="entity-description">${escapeEntityHtml(block)}</p>`).join('');
    return `<section class="entity-section" data-sheet-section-id="${escapeEntityHtml(section.id || '')}">${title}${blocks || '<div class="entity-empty">暂无数据。</div>'}${help}</section>`;
  }
  return `<section class="entity-section" data-sheet-section-id="${escapeEntityHtml(section.id || '')}">${title}<div class="entity-empty">${escapeEntityHtml(section.message || '暂无数据。')}</div>${help}</section>`;
}

export function renderEntitySheetSections(sections) {
  return (Array.isArray(sections) ? sections : []).map(renderEntitySheetSection).join('');
}

export function renderEntityPlayOverview({ sections = [], checks = [], statuses = [] } = {}) {
  const resources = sections.filter(section => section.type === 'resources');
  const resourceHtml = resources.map(section => `<section class="entity-section entity-play-resources" data-sheet-section-id="${escapeEntityHtml(section.id || '')}"><h3>${escapeEntityHtml(section.title || '资源')}</h3><div class="entity-play-resource-grid">${(section.items || []).map(item => {
    const ratio = Number(item.max) > 0 ? Math.max(0, Math.min(100, Number(item.current) / Number(item.max) * 100)) : 0;
    return `<div class="entity-play-resource" data-sheet-role="${escapeEntityHtml(item.role || '')}"><div class="entity-play-resource-heading"><strong>${escapeEntityHtml(item.label || item.id)}</strong><span>${escapeEntityHtml(item.current)} <small>/ ${escapeEntityHtml(item.max)}</small></span></div><div class="entity-resource-bar" aria-hidden="true"><span style="width:${ratio}%"></span></div>${item.currentOperation ? `<details class="entity-play-resource-adjust"><summary>调整</summary><div><button class="small-button" type="button" title="减少${escapeEntityHtml(item.label || item.id)}" aria-label="减少${escapeEntityHtml(item.label || item.id)}"${operationData(item.decrementOperation)}>${renderUiIcon('minus')}</button><label>当前 <input type="number" step="1" aria-label="${escapeEntityHtml(item.label || item.id)}当前值" value="${escapeEntityHtml(item.current)}"${operationData(item.currentOperation)}></label></div></details>` : ''}</div>`;
  }).join('')}</div></section>`).join('');
  const active = statuses.filter(status => status.enabled !== false);
  const statusHtml = `<section class="entity-section entity-play-statuses" data-sheet-section-id="play-statuses"><div class="entity-play-section-head"><h3>当前状态</h3><button type="button" class="small-button" data-sheet-overview-target="status">管理${renderUiIcon('chevron-right')}</button></div><div class="entity-play-status-list">${active.length ? active.map(status => `<div class="entity-play-status" data-status-id="${escapeEntityHtml(status.id || status.definitionId || '')}"><span class="entity-play-status-icon">${renderUiIcon(status.icon || 'circle-dot')}</span><strong>${escapeEntityHtml(status.label || status.name || '状态')}${Number(status.stacks) > 1 ? ` ×${Math.floor(Number(status.stacks))}` : ''}</strong>${status.duration ? `<small>剩余 ${escapeEntityHtml(status.duration.remaining)} ${status.duration.unit === 'rounds' ? '轮' : '回合'}</small>` : '<small>持续</small>'}</div>`).join('') : '<p class="entity-help">无持续状态</p>'}</div></section>`;
  const tables = checks.filter(section => section.type === 'table' && section.rows?.length);
  if (!resources.length && !tables.length) return `${renderEntitySheetSections(sections)}${statusHtml}`;
  const checksHtml = tables.length ? `<section class="entity-section entity-play-checks" data-sheet-section-id="play-checks"><div class="entity-play-section-head"><h3>常用鉴定</h3><button type="button" class="small-button" data-sheet-overview-target="checks">完整列表${renderUiIcon('chevron-right')}</button></div>${tables.slice(0, 2).map(table => `<div class="entity-play-check-group"><h4>${escapeEntityHtml(table.title || '')}</h4>${table.rows.slice(0, 4).map(row => `<div class="entity-play-check-row">${row.slice(0, Math.min(3, row.length)).map((cell, index) => `<span${index === 0 ? ' class="entity-play-check-label"' : ''}>${escapeEntityHtml(cell && typeof cell === 'object' ? cell.value ?? '' : cell ?? '')}</span>`).join('')}</div>`).join('')}</div>`).join('')}</section>` : '';
  const extra = sections.filter(section => section.type !== 'resources').map(section => {
    if (section.type !== 'detection') return renderEntitySheetSection(section);
    return `<section class="entity-section entity-play-detection" data-sheet-section-id="${escapeEntityHtml(section.id || '')}"><h3>${escapeEntityHtml(section.title || '侦测')}</h3><div>${(section.ranges || []).map(range => `<span>${escapeEntityHtml(range.label)} <strong>${escapeEntityHtml(range.value)} m</strong></span>`).join('')}</div>${(section.senses || []).filter(sense => sense.value).map(sense => `<small>${escapeEntityHtml(sense.label)}</small>`).join('')}</section>`;
  }).join('');
  return `${resourceHtml}${statusHtml}${checksHtml}<details class="entity-play-details" data-sheet-section-id="play-details"><summary>侦测与角色资料${renderUiIcon('chevron-down')}</summary>${extra}</details>`;
}

export function actorUiCapabilities(ruleset, sheetDescription = {}) {
  const variants = Array.isArray(sheetDescription?.variants) ? sheetDescription.variants : [];
  return Object.freeze({
    canImportXlsx: typeof ruleset?.importers?.xlsx?.importFile === 'function',
    hasVariants: variants.length > 0,
    canCycleVariants: variants.length > 1,
  });
}

export function classifyNewImportedActor(actor, actorType = 'pc') {
  const classification = normalizeActorClassification({
    type: actorType,
    partyId: String(actorType) === 'pc' ? actor?.partyId : null,
  });
  return { ...actor, type: classification.type, partyId: classification.partyId };
}
import { contentImageAttributes } from '../content/references.js';
