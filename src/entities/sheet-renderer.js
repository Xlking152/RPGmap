import { describeActor } from '../actor/index.js';
import { normalizeActorClassification } from '../actor/classification.js';

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

export function installEntityStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-tool="marker"], [data-tool="marker-select"], [data-action="clear-markers"],
    [data-tab="markers"] { display:none !important; }
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
    .token-config { padding:0; overflow:hidden; }
    .token-config > .entity-card-top { padding:10px 10px 2px; }
    .token-config-tabs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-bottom:1px solid #dce3e0; }
    .token-config-tabs button { min-width:0; border:0; border-top:1px solid #dce3e0; padding:9px 4px; background:#eef3ef; color:#526366; cursor:pointer; font-weight:750; }
    .token-config-tabs button.active { color:#176d76; background:#fff; box-shadow:inset 0 -3px #176d76; }
    .token-config-body { padding:10px; min-width:0; }
    .token-config-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; align-items:end; }
    .token-config-grid label { min-width:0; display:grid; gap:4px; color:#526366; font-size:12px; }
    .token-config-grid input:not([type="checkbox"]), .token-config-grid select { width:100%; min-width:0; box-sizing:border-box; }
    .token-config-grid select[multiple] { min-height:64px; }
    .token-config-check { display:flex !important; align-items:center; align-self:center; }
    .token-config-feedback { grid-column:1/-1; }
    .token-config-feedback.pending { color:#785d14; }
    .token-config-feedback.confirmed { color:#247346; }
    .token-config-feedback.error { color:#a12f2f; }
    .token-config-advanced { display:grid; gap:9px; }
    .token-config-advanced pre { max-height:180px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
    .entity-sheet-backdrop { position:fixed; inset:0; z-index:4200; background:rgba(18,23,24,.48); display:grid; place-items:center; padding:24px; }
    .entity-sheet-backdrop.entity-sheet-window { display:block; padding:0; background:transparent; pointer-events:none; }
    .entity-sheet-window > .entity-sheet { position:fixed; pointer-events:auto; }
    .entity-sheet { width:min(880px,94vw); max-height:90vh; overflow:auto; box-sizing:border-box; background:#f8faf7; border:1px solid rgba(40,70,70,.3); border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,.28); }
    .entity-sheet-header { position:sticky; top:0; z-index:3; display:flex; align-items:center; gap:14px; padding:14px 16px; background:rgba(248,250,247,.97); border-bottom:1px solid rgba(40,70,70,.18); cursor:default; }
    .entity-sheet-header .entity-avatar, .entity-sheet-header .entity-avatar img { width:64px; height:64px; }
    .entity-sheet-title { flex:1; min-width:0; }
    .entity-sheet-title input { width:100%; font-size:20px; font-weight:800; border:0; border-bottom:1px solid #aab5b3; background:transparent; padding:3px 0; }
    .entity-formbar { display:flex; gap:7px; align-items:center; flex-wrap:wrap; margin-top:7px; }
    .entity-formbar select { min-width:140px; }
    .entity-sheet-tabs { position:sticky; top:93px; z-index:2; display:flex; gap:2px; padding:0 12px; background:#eef3ef; border-bottom:1px solid rgba(40,70,70,.16); }
    .entity-sheet-tab { border:0; background:transparent; padding:10px 13px; cursor:pointer; font-weight:750; color:#4c5d5f; }
    .entity-sheet-tab.active { color:#176d76; box-shadow:inset 0 -3px #176d76; }
    .entity-sheet-body { padding:16px; display:grid; gap:14px; }
    .entity-section { border:1px solid rgba(60,80,80,.18); border-radius:10px; padding:12px; background:#fff; }
    .entity-section h3 { margin:0 0 10px; font-size:14px; }
    .entity-resource { display:grid; grid-template-columns:minmax(90px,1fr) auto auto auto; gap:7px; align-items:center; margin:7px 0; }
    .entity-resource-bar { grid-column:1/-1; height:5px; border-radius:4px; background:#e0e6e2; overflow:hidden; }
    .entity-resource-bar span { display:block; height:100%; background:#3d9b63; }
    .entity-resource input { width:74px; }
    .entity-grid { display:grid; grid-template-columns:repeat(3,minmax(150px,1fr)); gap:9px; }
    .entity-stat { border:1px solid #d8dfdc; border-radius:8px; padding:9px; display:grid; grid-template-columns:1fr auto; gap:5px 9px; align-items:center; }
    .entity-stat strong { font-size:16px; }
    .entity-stat small { grid-column:1/-1; color:#758082; }
    .entity-stat input { width:66px; }
    .entity-detection-ranges,.entity-detection-senses { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .entity-detection-range { display:grid; grid-template-columns:auto 76px; gap:3px 8px; align-items:center; }
    .entity-detection-range small { grid-column:1/-1; color:#758082; }
    .entity-detection-sense { display:inline-flex; gap:5px; align-items:center; padding:5px 7px; border:1px solid #d8dfdc; border-radius:7px; }
    .entity-check-table { width:100%; border-collapse:collapse; font-size:12px; }
    .entity-check-table th,.entity-check-table td { padding:7px 6px; border-bottom:1px solid #e0e5e2; text-align:left; vertical-align:top; }
    .entity-check-table th { color:#607073; font-size:11px; }
    .entity-description { white-space:pre-wrap; line-height:1.6; color:#4a5658; }
    .entity-empty { color:#7b8587; padding:16px 4px; text-align:center; }
    .entity-indicator { position:absolute; z-index:2600; left:50%; top:70px; transform:translateX(-50%); padding:7px 12px; border-radius:8px; color:#fff; background:rgba(23,109,118,.94); box-shadow:0 4px 16px rgba(0,0,0,.25); font-weight:800; pointer-events:none; animation:entity-indicator 1.2s ease forwards; }
    .entity-placement-hud { position:fixed; z-index:4300; left:50%; bottom:max(18px,env(safe-area-inset-bottom)); transform:translateX(-50%); display:flex; align-items:center; gap:10px; max-width:calc(100vw - 24px); padding:10px 12px; border:1px solid rgba(23,109,118,.45); border-radius:10px; background:#f8faf7; color:#25383a; box-shadow:0 10px 30px rgba(0,0,0,.24); font-weight:750; }
    .entity-placement-hud button { flex:0 0 auto; }
    .entity-sheet-readonly input, .entity-sheet-readonly select,
    .entity-sheet-readonly [data-sheet-action]:not([data-sheet-action="close"]) { pointer-events:none; opacity:.55; }
    .entity-sheet-v3 { min-width:560px; }
    .entity-sheet-v3-badges { display:flex; gap:5px; flex-wrap:wrap; align-items:center; margin-top:5px; }
    .entity-sheet-v3-badge { padding:2px 7px; border:1px solid #cbd6d2; border-radius:999px; background:#eef3ef; color:#536366; font-size:10px; font-weight:800; letter-spacing:.35px; }
    .entity-sheet-v3-mode-toggle { border:1px solid #176d76; border-radius:7px; padding:4px 8px; background:#fff; color:#176d76; cursor:pointer; font-size:11px; font-weight:800; }
    .entity-sheet-v3[data-sheet-interaction-mode="play"] [data-sheet-edit-only] { display:none !important; }
    .entity-sheet-v3[data-sheet-interaction-mode="play"] [data-actor-name] { border-bottom-color:transparent; color:inherit; opacity:1; cursor:default; }
    .entity-limited-sheet.entity-sheet-v3 { min-width:360px; width:min(520px,92vw); }
    .entity-limited-sheet.entity-sheet-v3 .entity-sheet-header .entity-avatar,
    .entity-limited-sheet.entity-sheet-v3 .entity-sheet-header .entity-avatar img { width:78px; height:78px; border-radius:10px; }
    .entity-public-profile-editor { display:grid; gap:10px; }
    .entity-public-profile-editor > label { display:grid; gap:5px; font-weight:700; color:#526366; }
    .entity-public-profile-editor textarea { width:100%; box-sizing:border-box; resize:vertical; }
    .entity-public-status-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px 10px; max-height:180px; overflow:auto; }
    .entity-public-status-option { display:flex; gap:5px; align-items:center; }
    .entity-public-profile-preview { display:grid; gap:10px; padding:10px; border:1px dashed #b8c6c1; border-radius:8px; background:#f5f7f4; }
    .entity-known-facts { margin:0; padding-left:20px; display:grid; gap:6px; }
    .entity-public-status-list { display:flex; gap:7px; flex-wrap:wrap; }
    .entity-public-status { display:inline-flex; align-items:center; gap:5px; padding:5px 8px; border:1px solid var(--status-color); border-radius:999px; background:#fff; }
    .entity-template-runtime-readonly [data-actor-operation],
    .entity-template-runtime-readonly [data-form-select],
    .entity-template-runtime-readonly [data-sheet-action="cycle-form"] { pointer-events:none; opacity:.55; }
    @keyframes entity-indicator { 0%{opacity:0;transform:translate(-50%,-6px)} 15%,75%{opacity:1;transform:translate(-50%,0)} 100%{opacity:0;transform:translate(-50%,-8px)} }
    @media(max-width:760px){
      .entity-sheet-v3{min-width:0;width:calc(100vw - 16px)!important;max-width:calc(100vw - 16px);left:8px!important;top:8px!important;height:calc(100vh - 16px)!important;max-height:calc(100vh - 16px)}
      .entity-public-status-options{grid-template-columns:1fr}
      .entity-grid{grid-template-columns:1fr 1fr}
      .entity-sheet-backdrop:not(.entity-sheet-window){padding:8px}
      .entity-sheet-window > .entity-sheet{max-width:calc(100vw - 16px);max-height:calc(100vh - 16px)}
      .entity-resource{grid-template-columns:1fr auto auto}
      .entity-resource .entity-resource-edit{grid-column:1/-1}
      .token-config-grid{grid-template-columns:1fr}
      .token-config-feedback{grid-column:1}
      .token-config-tabs button{font-size:12px;padding-inline:2px}
    }
  `;
  documentNode.head.append(style);
}

export function entityAvatarHtml(actor, ruleset) {
  const presentation = describeActor(actor, { ruleset }) || {};
  const avatar = presentation.avatarDataUrl;
  if (avatar) return `<span class="entity-avatar"><img src="${escapeEntityHtml(avatar)}" alt=""></span>`;
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
      return `<div class="entity-resource" data-sheet-role="${escapeEntityHtml(item.role || '')}">
        <strong>${escapeEntityHtml(item.label || item.id)}</strong>
        <button type="button" class="small-button"${operationData(item.decrementOperation)}>−</button>
        <label><input type="number" step="1" value="${escapeEntityHtml(item.current)}"${operationData(item.currentOperation)}> / </label>
        <label class="entity-resource-edit"><input type="number" step="1" min="0" value="${escapeEntityHtml(item.max)}" title="当前最大值；修改会建立运行时覆盖"${operationData(item.maxOperation)}> 最大</label>
        <div class="entity-resource-bar"><span style="width:${ratio}%"></span></div>
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
    return `<section class="entity-section" data-sheet-section-id="${escapeEntityHtml(section.id || '')}">${title}${help}<table class="entity-check-table"><thead><tr>${columns}</tr></thead><tbody>${body}</tbody></table></section>`;
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
