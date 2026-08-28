import { createActorFromImport, addFormToActor } from './model.js';
import {
  setActorForm,
  cycleActorForm,
} from './resolver.js';
import { describeActor, describeActorSheet, performActorOperation } from '../actor/index.js';
import { importCharacterXlsx } from './xlsx-importer.js';
import { imageToAvatarDataUrl } from './avatar.js';
import { EntityStore } from './store.js';
import { createEntityTokenController } from './token-controller.js';
import {
  canManageStatuses,
  createStatusUiController,
  installStatusUiStyles,
  renderActorStatusSheet,
  renderStatusStrip,
  resolveStatusUiSnapshot,
} from '../status/ui.js';

const STYLE_ID = 'rpgmap-entity-system-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function editableTarget(target) {
  return target instanceof HTMLElement && Boolean(target.closest('input,textarea,select,[contenteditable="true"]'));
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-tool="marker"], [data-tool="marker-select"], [data-action="clear-markers"],
    [data-tab="markers"], [data-panel="markers"] { display: none !important; }
    .entity-toolbar-button { white-space: nowrap; }
    .entity-panel { display: grid; gap: 10px; }
    .entity-panel-head { display:flex; gap:7px; flex-wrap:wrap; align-items:center; }
    .entity-help { font-size: 12px; color:#687477; line-height:1.55; }
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
    .entity-sheet-backdrop { position:fixed; inset:0; z-index:4200; background:rgba(18,23,24,.48); display:grid; place-items:center; padding:24px; }
    .entity-sheet { width:min(880px,94vw); max-height:90vh; overflow:auto; background:#f8faf7; border:1px solid rgba(40,70,70,.3); border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,.28); }
    .entity-sheet-header { position:sticky; top:0; z-index:3; display:flex; align-items:center; gap:14px; padding:14px 16px; background:rgba(248,250,247,.97); border-bottom:1px solid rgba(40,70,70,.18); }
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
    .entity-check-table { width:100%; border-collapse:collapse; font-size:12px; }
    .entity-check-table th,.entity-check-table td { padding:7px 6px; border-bottom:1px solid #e0e5e2; text-align:left; vertical-align:top; }
    .entity-check-table th { color:#607073; font-size:11px; }
    .entity-description { white-space:pre-wrap; line-height:1.6; color:#4a5658; }
    .entity-empty { color:#7b8587; padding:16px 4px; text-align:center; }
    .entity-indicator { position:absolute; z-index:2600; left:50%; top:70px; transform:translateX(-50%); padding:7px 12px; border-radius:8px; color:#fff; background:rgba(23,109,118,.94); box-shadow:0 4px 16px rgba(0,0,0,.25); font-weight:800; pointer-events:none; animation:entity-indicator 1.2s ease forwards; }
    .entity-placement-hud { position:fixed; z-index:4300; left:50%; bottom:max(18px, env(safe-area-inset-bottom)); transform:translateX(-50%); display:flex; align-items:center; gap:10px; max-width:calc(100vw - 24px); padding:10px 12px; border:1px solid rgba(23,109,118,.45); border-radius:10px; background:#f8faf7; color:#25383a; box-shadow:0 10px 30px rgba(0,0,0,.24); font-weight:750; }
    .entity-placement-hud button { flex:0 0 auto; }
    .entity-sheet-readonly input, .entity-sheet-readonly select,
    .entity-sheet-readonly [data-sheet-action]:not([data-sheet-action="close"]) { pointer-events:none; opacity:.55; }
    @keyframes entity-indicator { 0%{opacity:0;transform:translate(-50%,-6px)} 15%,75%{opacity:1;transform:translate(-50%,0)} 100%{opacity:0;transform:translate(-50%,-8px)} }
    @media (max-width:760px) { .entity-grid{grid-template-columns:1fr 1fr}.entity-sheet-backdrop{padding:8px}.entity-resource{grid-template-columns:1fr auto auto}.entity-resource .entity-resource-edit{grid-column:1/-1} }
  `;
  documentNode.head.append(style);
}

function avatarHtml(actor, ruleset) {
  const presentation = describeActor(actor, { ruleset }) || {};
  const avatar = presentation.avatarDataUrl;
  if (avatar) return `<span class="entity-avatar"><img src="${escapeHtml(avatar)}" alt=""></span>`;
  return `<span class="entity-avatar">${escapeHtml((actor?.name?.trim()?.[0] || '?').toUpperCase())}</span>`;
}

function encodeData(value) {
  return escapeHtml(encodeURIComponent(JSON.stringify(value || {})));
}

function decodeData(value) {
  try { return JSON.parse(decodeURIComponent(String(value || ''))); }
  catch { return null; }
}

function operationData(operation, extra = '') {
  return operation ? ` data-actor-operation="${encodeData(operation)}"${extra}` : '';
}

function renderTableCell(cell) {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return `<td>${escapeHtml(cell ?? '')}</td>`;
  if (!cell.input) return `<td>${escapeHtml(cell.value ?? '')}</td>`;
  const levelClass = cell.level ? ` entity-value-${escapeHtml(cell.level)}` : '';
  return `<td><input class="entity-table-input${levelClass}" type="number" step="1" min="${escapeHtml(cell.min ?? '')}" value="${escapeHtml(cell.value ?? 0)}"${operationData(cell.operation)}></td>`;
}

function renderSheetSection(section) {
  if (!section || typeof section !== 'object') return '';
  const title = section.title ? `<h3>${escapeHtml(section.title)}</h3>` : '';
  const help = section.help ? `<p class="entity-help">${escapeHtml(section.help)}</p>` : '';
  if (section.type === 'resources') {
    const items = (section.items || []).map(item => {
      const ratio = Number(item.max) > 0
        ? Math.max(0, Math.min(100, Number(item.current) / Number(item.max) * 100))
        : 0;
      return `<div class="entity-resource" data-sheet-role="${escapeHtml(item.role || '')}">
        <strong>${escapeHtml(item.label || item.id)}</strong>
        <button type="button" class="small-button"${operationData(item.decrementOperation)}>−</button>
        <label><input type="number" step="1" value="${escapeHtml(item.current)}"${operationData(item.currentOperation)}> / </label>
        <label class="entity-resource-edit"><input type="number" step="1" min="0" value="${escapeHtml(item.max)}" title="当前最大值；修改会建立运行时覆盖"${operationData(item.maxOperation)}> 最大</label>
        <div class="entity-resource-bar"><span style="width:${ratio}%"></span></div>
        ${item.deleteOperation ? `<button type="button" class="small-button danger" data-operation-confirm="删除这个特殊能量槽？"${operationData(item.deleteOperation)}>删除 ${escapeHtml(item.label || item.id)}</button>` : ''}
      </div>`;
    }).join('');
    const actions = (section.actions || []).map(action => `<button type="button" class="small-button" data-operation-prompts="${encodeData(action.prompts || [])}"${operationData(action.operation)}>${escapeHtml(action.label || '执行')}</button>`).join('');
    return `<section class="entity-section" data-sheet-section-id="${escapeHtml(section.id || '')}">${title}${items}${actions}${help}</section>`;
  }
  if (section.type === 'stats') {
    const items = (section.items || []).map(item => `<div class="entity-stat"><span>${escapeHtml(item.label || item.id)}</span><strong>${escapeHtml(item.value)}</strong><small>${escapeHtml(item.detail || '')}</small><label>临时 <input type="number" step="1" value="${escapeHtml(item.adjustment || 0)}"${operationData(item.operation)}></label></div>`).join('');
    return `<section class="entity-section" data-sheet-section-id="${escapeHtml(section.id || '')}">${title}<div class="entity-grid">${items || '<div class="entity-empty">暂无数据。</div>'}</div>${help}</section>`;
  }
  if (section.type === 'table') {
    const columns = (section.columns || []).map(column => `<th>${escapeHtml(column)}</th>`).join('');
    const rows = (section.rows || []).map(row => `<tr>${(Array.isArray(row) ? row : []).map(renderTableCell).join('')}</tr>`).join('');
    const body = rows || `<tr><td colspan="${Math.max(1, section.columns?.length || 1)}" class="entity-empty">${escapeHtml(section.emptyMessage || '暂无数据。')}</td></tr>`;
    return `<section class="entity-section" data-sheet-section-id="${escapeHtml(section.id || '')}">${title}${help}<table class="entity-check-table"><thead><tr>${columns}</tr></thead><tbody>${body}</tbody></table></section>`;
  }
  if (section.type === 'text') {
    const blocks = (section.blocks || []).map(block => `<p class="entity-description">${escapeHtml(block)}</p>`).join('');
    return `<section class="entity-section" data-sheet-section-id="${escapeHtml(section.id || '')}">${title}${blocks || '<div class="entity-empty">暂无数据。</div>'}${help}</section>`;
  }
  return `<section class="entity-section" data-sheet-section-id="${escapeHtml(section.id || '')}">${title}<div class="entity-empty">${escapeHtml(section.message || '暂无数据。')}</div>${help}</section>`;
}

function renderSheetSections(sections) {
  return (Array.isArray(sections) ? sections : []).map(renderSheetSection).join('');
}

export function actorUiCapabilities(ruleset, sheetDescription = {}) {
  const variants = Array.isArray(sheetDescription?.variants) ? sheetDescription.variants : [];
  return Object.freeze({
    canImportXlsx: typeof ruleset?.importers?.xlsx?.importFile === 'function',
    hasVariants: variants.length > 0,
    canCycleVariants: variants.length > 1,
  });
}

export function createEntityUiTool(options = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      installStyles(documentNode);
      installStatusUiStyles(documentNode);
      const store = new EntityStore(api, { canonicalTokenReads: true });
      const migration = store.load({ migrateLegacy: true, dropMarkers: options.dropLegacyMarkers !== false });
      let selectedTokenId = null;
      let pendingImportActorId = null;
      let openActorId = null;
      let openTab = 'overview';
      let renderingPanel = false;
      let importBusy = false;
      const rulesetCapabilities = actorUiCapabilities(api.ruleset);

      const panel = api.uiPanels?.actors;
      if (!panel) throw new Error('Entity UI requires canonical Actor panel ownership');
      const toolbar = shell.querySelector('.toolbar-right');
      const importButton = documentNode.createElement('button');
      importButton.type = 'button';
      importButton.className = 'tool-button entity-toolbar-button';
      importButton.textContent = '导入角色卡';
      importButton.title = '导入 XLSX：仅读取角色概览与具体数值表';
      toolbar?.prepend(importButton);
      const xlsxInput = documentNode.createElement('input');
      xlsxInput.type = 'file';
      xlsxInput.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      xlsxInput.hidden = true;
      toolbar?.append(xlsxInput);
      const avatarInput = documentNode.createElement('input');
      avatarInput.type = 'file';
      avatarInput.accept = 'image/*';
      avatarInput.hidden = true;
      toolbar?.append(avatarInput);

      function entityState() { return store.state; }
      function canonicalTokens() { return api.tokens?.list?.() || []; }
      function tokenCount(actorId) { return canonicalTokens().filter(token => String(token.actorId) === String(actorId)).length; }
      function setStatus(message) { const node = shell.querySelector('[data-role="map-status"]'); if (node) node.textContent = message; }
      function indicator(message) {
        const node = documentNode.createElement('div');
        node.className = 'entity-indicator';
        node.textContent = message;
        (mapElement.parentElement || mapElement).append(node);
        setTimeout(() => node.remove(), 1300);
      }
      function persistAndRender(options = {}) { store.persist(options); renderPanel(); renderSheet(); }
      function capabilities() {
        return api.multiplayer?.getCapabilities?.() || {
          canManageStructure: true,
          canImportActors: true,
          canEditActor: () => true,
          canPlaceActor: () => true,
        };
      }
      function requireStructure(message = '只有 GM 可以修改角色或 Token 结构') {
        if (capabilities().canManageStructure) return true;
        setStatus(message);
        return false;
      }
      function requireActorEdit(actorId) {
        if (capabilities().canEditActor?.(actorId)) return true;
        setStatus('当前只能查看该角色：需要 OWNER 权限且必须轮到该角色行动');
        return false;
      }

      const statusUi = createStatusUiController({
        api,
        documentNode,
        getContext: () => {
          const actor = store.actor(openActorId);
          const allTokens = canonicalTokens();
          return {
            actor,
            allTokens,
            tokens: actor ? allTokens.filter(token => String(token.actorId) === String(actor.id)) : [],
          };
        },
        render: () => { renderPanel(); renderSheet(); },
        setStatus,
      });

      const tokenController = createEntityTokenController({
        api,
        documentNode,
        mapElement,
        store,
        capabilities,
        setStatus,
        closeSheet,
        renderPanel,
        renderSheet,
        onSelectToken(tokenId) { selectedTokenId = tokenId ? String(tokenId) : null; },
      });

      function renderPanel() {
        if (!panel) return;
        renderingPanel = true;
        const actors = entityState().actors;
        const canManageStructure = capabilities().canManageStructure;
        const legacyMarkerCount = Array.isArray(api.getState().markers) ? api.getState().markers.length : 0;
        importButton.hidden = !canManageStructure || !rulesetCapabilities.canImportXlsx;
        panel.innerHTML = `
          <div class="entity-panel" data-entity-panel>
            <div class="entity-panel-head">
              ${canManageStructure && rulesetCapabilities.canImportXlsx ? '<button type="button" class="small-button primary" data-entity-action="import">导入角色卡</button>' : ''}${canManageStructure ? '<button type="button" class="small-button" data-entity-action="new">新建空白角色</button>' : ''}
              ${canManageStructure && legacyMarkerCount ? `<button type="button" class="small-button" data-entity-action="migrate-markers">迁移 ${legacyMarkerCount} 个旧标记</button>` : ''}
            </div>
            <div class="entity-help">Actor 保存角色数据；Token 的位置、大小、显示、旋转、高度和删除均由当前 Scene 的 canonical Token Runtime 管理。${legacyMarkerCount ? `检测到 ${legacyMarkerCount} 个旧标记；它们会保留，只有 GM 确认迁移后才会删除。` : '双击 Token 或按列表中的“角色卡”打开属性。选中有多个形态的 Token 后按 <b>V</b> 切换形态。'}</div>
            <div data-entity-list>${actors.length ? actors.map(actor => {
              const presentation = describeActor(actor, { ruleset: api.ruleset }) || {};
              const sheetCapabilities = actorUiCapabilities(api.ruleset, describeActorSheet(actor, { ruleset: api.ruleset }));
              const count = tokenCount(actor.id);
              const canEditActor = capabilities().canEditActor?.(actor.id);
              const canPlaceActor = capabilities().canPlaceActor?.(actor.id);
              const statusSnapshot = resolveStatusUiSnapshot(api, { actorId: actor.id });
              return `<article class="entity-card" data-actor-id="${escapeHtml(actor.id)}">
                <div class="entity-card-top">${avatarHtml(actor, api.ruleset)}<div class="entity-card-copy"><strong>${escapeHtml(actor.name)}</strong><small>${escapeHtml(presentation.variantLabel || '无形态')} · ${count ? `${count} 个 Token` : '未放置'}</small></div></div>
                <div class="entity-card-status">${renderStatusStrip([...statusSnapshot.actorStatuses, ...statusSnapshot.derivedStatuses], { limit: 4, emptyText: '无状态' })}</div>
                <div class="entity-card-actions">
                  <button type="button" class="small-button" data-entity-action="open" data-id="${escapeHtml(actor.id)}">角色卡</button>
                  ${canPlaceActor ? `<button type="button" class="small-button" data-entity-action="place" data-id="${escapeHtml(actor.id)}">放置 Token</button>` : ''}
                  ${canManageStructure && sheetCapabilities.hasVariants && sheetCapabilities.canImportXlsx ? `<button type="button" class="small-button" data-entity-action="add-form" data-id="${escapeHtml(actor.id)}">导入新形态</button>` : ''}${canManageStructure ? `<button type="button" class="small-button danger" data-entity-action="delete" data-id="${escapeHtml(actor.id)}">删除角色</button>` : ''}
                  ${!canEditActor ? '<small>只读</small>' : ''}
                </div>
              </article>`;
            }).join('') : '<div class="entity-empty">还没有角色。可直接导入 XLSX 角色卡。</div>'}</div>
          </div>`;
        queueMicrotask(() => { renderingPanel = false; });
      }

      const panelObserver = panel ? new MutationObserver(() => {
        if (!renderingPanel && !panel.querySelector('[data-entity-panel]')) queueMicrotask(renderPanel);
      }) : null;
      panelObserver?.observe(panel, { childList: true, subtree: false });

      function actorSheetBody(actor, tab) {
        if (tab === 'status') {
          const allTokens = canonicalTokens();
          const tokens = allTokens.filter(token => String(token.actorId) === String(actor.id));
          return renderActorStatusSheet({
            api,
            actor,
            tokens,
            allTokens,
            selectedTokenIds: api.selection?.getSelectedTokenIds?.() || (selectedTokenId ? [selectedTokenId] : []),
            canManage: canManageStatuses(api),
            pendingKeys: statusUi.pendingKeys,
          });
        }
        if (tab === 'token') return tokenController.renderActorTokenSection(actor);
        const description = describeActorSheet(actor, { ruleset: api.ruleset }) || {};
        const tabDescription = (description.tabs || []).find(item => String(item.id) === String(tab));
        return tabDescription ? renderSheetSections(tabDescription.sections) : '<div class="entity-empty">规则包没有提供这个角色卡页签。</div>';
      }

      function renderSheet() {
        const existing = documentNode.querySelector('.entity-sheet-backdrop');
        if (!openActorId) { existing?.remove(); return; }
        const actor = store.actor(openActorId);
        if (!actor) { openActorId = null; existing?.remove(); return; }
        const sheetDescription = describeActorSheet(actor, { ruleset: api.ruleset }) || { variants: [], tabs: [] };
        const sheetCapabilities = actorUiCapabilities(api.ruleset, sheetDescription);
        const tabs = [...(sheetDescription.tabs || []).map(item => [item.id, item.label]), ['status','状态'], ['token','Token']];
        if (!tabs.some(([id]) => id === openTab)) openTab = tabs[0]?.[0] || 'status';
        const canEdit = capabilities().canEditActor?.(actor.id);
        const actorTokens = tokenController.actorTokens(actor.id);
        const selectedToken = actorTokens.find(token => String(token.id) === String(selectedTokenId));
        const titleSnapshot = resolveStatusUiSnapshot(api, {
          actorId: actor.id,
          ...(selectedToken ? { tokenId: selectedToken.id } : {}),
        });
        const html = `<div class="entity-sheet-backdrop"><div class="entity-sheet ${canEdit ? '' : 'entity-sheet-readonly'}" data-actor-id="${escapeHtml(actor.id)}" role="dialog" aria-modal="true">
          <header class="entity-sheet-header">${avatarHtml(actor, api.ruleset)}<div class="entity-sheet-title"><input type="text" maxlength="80" value="${escapeHtml(actor.name)}" data-actor-name><div class="entity-formbar">${sheetCapabilities.hasVariants ? `<span>当前形态</span><select data-form-select>${(sheetDescription.variants || []).map(item => `<option value="${escapeHtml(item.id)}" ${String(item.id) === String(sheetDescription.currentVariantId) ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>${sheetCapabilities.canCycleVariants ? '<button type="button" class="small-button primary" data-sheet-action="cycle-form">V · 切换</button>' : ''}${sheetCapabilities.canImportXlsx ? '<button type="button" class="small-button" data-sheet-action="add-form">+ 形态</button>' : ''}` : ''}<button type="button" class="small-button" data-sheet-action="avatar">更换头像</button></div><div class="status-title-band">${renderStatusStrip(titleSnapshot.statuses, { limit: 8, emptyText: '无机械状态' })}</div></div><button type="button" class="small-button" data-sheet-action="close">关闭</button></header>
          <nav class="entity-sheet-tabs">${tabs.map(([id,label]) => `<button type="button" class="entity-sheet-tab ${openTab === id ? 'active' : ''}" data-sheet-tab="${id}">${label}</button>`).join('')}</nav>
          <main class="entity-sheet-body">${actorSheetBody(actor, openTab)}</main>
        </div></div>`;
        if (existing) existing.outerHTML = html;
        else documentNode.body.insertAdjacentHTML('beforeend', html);
      }

      function openSheet(actorId, tab = openTab) { openActorId = actorId; openTab = tab; renderSheet(); }
      function closeSheet() { openActorId = null; renderSheet(); }

      async function parseImport(file, actorId = null) {
        if (!requireStructure('只有 GM 可以导入角色卡或形态')) return;
        if (!file || importBusy) return;
        importBusy = true;
        setStatus('正在读取角色卡…');
        try {
          const imported = await importCharacterXlsx(file, { ruleset: api.ruleset });
          if (imported.avatarImage) {
            try { imported.avatarDataUrl = await imageToAvatarDataUrl(imported.avatarImage); }
            catch (error) { console.warn('Excel 头像导入失败，保留空头像', error); }
          }
          let actor = actorId ? store.actor(actorId) : null;
          if (!actor) {
            const sameName = entityState().actors.find(item => item.name === imported.identity.name);
            if (sameName && window.confirm(`检测到已有角色“${sameName.name}”。是否把“${imported.formName}”添加为该角色的新形态？`)) actor = sameName;
          }
          if (actor) {
            let formName = imported.formName;
            const beforeSheet = describeActorSheet(actor, { ruleset: api.ruleset }) || { variants: [] };
            if (beforeSheet.variants.some(variant => variant.label === formName)) formName += ` ${beforeSheet.variants.length + 1}`;
            const form = addFormToActor(actor, imported, { name: formName, ruleset: api.ruleset });
            store.persist();
            openSheet(actor.id);
            indicator(`${actor.name} · ${form?.name || formName}`);
            setStatus(`已导入 ${actor.name} 的新形态“${form?.name || formName}”`);
          } else {
            actor = createActorFromImport(imported, { ruleset: api.ruleset });
            entityState().actors.push(actor);
            store.persist();
            openSheet(actor.id);
            setStatus(`已创建 Actor“${actor.name}” · 可点击“放置 Token”放到地图`);
          }
          renderPanel();
        } catch (error) {
          console.error(error);
          alert('角色卡导入失败：' + error.message);
          setStatus('角色卡导入失败');
        } finally {
          importBusy = false;
          xlsxInput.value = '';
          pendingImportActorId = null;
        }
      }

      function chooseImport(actorId = null) {
        if (!requireStructure('只有 GM 可以导入角色卡或形态')) return;
        pendingImportActorId = actorId;
        xlsxInput.click();
      }

      function migrateLegacyMarkers() {
        if (!requireStructure('只有 GM 可以迁移旧标记')) return;
        const next = api.getState();
        const markers = Array.isArray(next.markers) ? next.markers : [];
        if (!markers.length) return;
        if (!confirm(`迁移会删除 ${markers.length} 个旧标记，并把关联范围保留在当前坐标作为自由锚点。服务器会先建立备份。是否继续？`)) return;
        const markerById = new Map(markers.map(marker => [String(marker.id), marker]));
        for (const area of next.attackAreas || []) {
          if (area.anchor?.type !== 'marker') continue;
          const marker = markerById.get(String(area.anchor.markerId));
          if (marker) area.origin = { x: marker.x, y: marker.y };
          area.anchor = { type: 'free', markerId: null };
        }
        next.markers = [];
        store.persist({ appState: next });
        setStatus('旧标记已迁移；关联范围已转换为自由锚点');
      }

      function handlePanelClick(event) {
        const button = event.target.closest('[data-entity-action]');
        if (!button) return;
        const action = button.dataset.entityAction;
        const id = button.dataset.id;
        if (action === 'import') chooseImport();
        else if (action === 'new') {
          if (!requireStructure()) return;
          const actor = createActorFromImport({}, { ruleset: api.ruleset });
          entityState().actors.push(actor);
          store.persist();
          renderPanel();
          openSheet(actor.id);
        } else if (action === 'open') openSheet(id);
        else if (action === 'place') tokenController.beginPlacement(id);
        else if (action === 'add-form') chooseImport(id);
        else if (action === 'delete') tokenController.removeActor(id).catch(error => {
          console.error('[RPGmap Entity UI] Actor delete failed', error);
          setStatus(`删除失败：${error?.message || error}`);
        });
        else if (action === 'migrate-markers') migrateLegacyMarkers();
      }

      panel.addEventListener('click', handlePanelClick);
      importButton.addEventListener('click', () => chooseImport());
      xlsxInput.addEventListener('change', () => parseImport(xlsxInput.files?.[0], pendingImportActorId));

      documentNode.addEventListener('click', async event => {
        if (statusUi.handleClick(event)) return;
        if (event.target.closest?.('[data-entity-placement-cancel]')) {
          event.preventDefault();
          tokenController.clearPlacement({ message: '已取消 Token 放置' });
          return;
        }
        const sheet = event.target.closest('.entity-sheet');
        if (!sheet) return;
        const actor = store.actor(openActorId);
        if (!actor) return;
        const operationNode = event.target.closest('[data-actor-operation]');
        if (operationNode && operationNode.tagName !== 'INPUT') {
          if (!requireActorEdit(actor.id)) return;
          const operation = decodeData(operationNode.dataset.actorOperation);
          if (!operation) return;
          const confirmation = operationNode.dataset.operationConfirm;
          if (confirmation && !confirm(confirmation)) return;
          const prompts = decodeData(operationNode.dataset.operationPrompts);
          if (Array.isArray(prompts)) {
            const answers = {};
            for (const field of prompts) {
              const fallback = field.defaultFrom ? answers[field.defaultFrom] : field.defaultValue;
              const answer = prompt(field.label || `${field.key}：`, fallback ?? '');
              if (answer === null) return;
              answers[field.key] = field.number ? Number(answer || 0) : answer;
            }
            Object.assign(operation, answers);
          }
          const result = performActorOperation(actor, operation, { ruleset: api.ruleset });
          if (result.changed) persistAndRender({ source: 'entities:actor-operation', immediate: true });
          return;
        }
        const tab = event.target.closest('[data-sheet-tab]');
        if (tab) { openTab = tab.dataset.sheetTab; renderSheet(); return; }
        const actionNode = event.target.closest('[data-sheet-action]');
        if (actionNode) {
          if (await tokenController.handleSheetAction(actionNode, actor)) return;
          const action = actionNode.dataset.sheetAction;
          if (action === 'close') closeSheet();
          else if (action === 'cycle-form') {
            if (!requireActorEdit(actor.id)) return;
            const form = cycleActorForm(actor, 1, { ruleset: api.ruleset });
            if (form) {
              store.persist();
              renderPanel();
              renderSheet();
              indicator(`${actor.name} · ${form.name}`);
            }
          } else if (action === 'add-form') chooseImport(actor.id);
          else if (action === 'avatar') {
            if (requireActorEdit(actor.id)) avatarInput.click();
          }
          return;
        }
      });

      documentNode.addEventListener('submit', event => { statusUi.handleSubmit(event); });

      documentNode.addEventListener('change', async event => {
        if (statusUi.handleChange(event)) return;
        if (await tokenController.handleChange(event.target)) return;
        const sheet = event.target.closest('.entity-sheet');
        if (!sheet) return;
        const actor = store.actor(openActorId);
        if (!actor) return;
        if (!requireActorEdit(actor.id)) { renderSheet(); return; }
        if (event.target.matches('[data-actor-name]')) {
          actor.name = String(event.target.value || '未命名角色').trim().slice(0, 80) || '未命名角色';
          persistAndRender();
        } else if (event.target.matches('[data-form-select]')) {
          const form = setActorForm(actor, event.target.value, { ruleset: api.ruleset });
          if (form) {
            store.persist();
            renderPanel();
            renderSheet();
            indicator(`${actor.name} · ${form.name}`);
          }
        } else if (event.target.matches('[data-actor-operation]')) {
          const operation = decodeData(event.target.dataset.actorOperation);
          if (!operation) return;
          operation.value = event.target.value;
          const result = performActorOperation(actor, operation, { ruleset: api.ruleset });
          if (result.changed) persistAndRender({ source: 'entities:actor-operation', immediate: true });
        }
      });

      avatarInput.addEventListener('change', async () => {
        const actor = store.actor(openActorId);
        const file = avatarInput.files?.[0];
        if (!actor || !file) return;
        try {
          const result = performActorOperation(actor, {
            type: 'avatar.set',
            avatarDataUrl: await imageToAvatarDataUrl(file),
          }, { ruleset: api.ruleset });
          if (result.changed) {
            store.persist();
            renderPanel();
            renderSheet();
          }
        } catch (error) {
          alert('头像处理失败：' + error.message);
        } finally {
          avatarInput.value = '';
        }
      });

      documentNode.addEventListener('keydown', event => {
        if (tokenController.handleKeydown(event)) return;
        if (event.defaultPrevented || editableTarget(event.target) || event.key.toLowerCase() !== 'v' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!selectedTokenId) return;
        const token = api.tokens.get?.(selectedTokenId);
        const actor = token ? store.actor(token.actorId) : null;
        if (!actor || (describeActorSheet(actor, { ruleset: api.ruleset })?.variants?.length || 0) < 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const form = cycleActorForm(actor, 1, { ruleset: api.ruleset });
        store.persist();
        renderPanel();
        renderSheet();
        indicator(`${actor.name} · ${form.name}`);
        setStatus(`形态切换：${actor.name} → ${form.name}`);
      }, true);

      mapElement.addEventListener('dblclick', event => {
        if (!event.target.closest?.('.rpg-token-v2')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        queueMicrotask(() => {
          const token = selectedTokenId ? api.tokens.get?.(selectedTokenId) : null;
          if (token?.actorId) openSheet(token.actorId);
        });
      }, true);
      mapElement.addEventListener('click', tokenController.handleMapClick, true);

      api.on('token:select', event => {
        selectedTokenId = event.detail?.tokenId || event.detail?.id || null;
        renderSheet();
      });
      api.on('token:create', () => { renderPanel(); renderSheet(); });
      api.on('token:delete', event => {
        if (selectedTokenId && String(event.detail?.tokenId || event.detail?.id) === String(selectedTokenId)) selectedTokenId = null;
        renderPanel();
        renderSheet();
      });
      api.on('token:move', () => { renderPanel(); renderSheet(); });
      api.on('token:property-change', () => { renderPanel(); renderSheet(); });
      api.on('elevation:token-change', () => { renderPanel(); renderSheet(); });
      api.on('state:commit', () => {
        if (store.saving) return;
        store.load({ migrateLegacy: false, dropMarkers: false });
        renderPanel();
        renderSheet();
      });
      api.on('state:import', () => {
        tokenController.clearPlacement({ restoreTool: false });
        if (store.saving) return;
        store.load({ migrateLegacy: false, dropMarkers: false });
        renderPanel();
        renderSheet();
      });
      api.on('app:destroy', () => {
        tokenController.destroy();
        statusUi.closeDefinitionEditor();
        mapElement.removeEventListener('click', tokenController.handleMapClick, true);
        panelObserver?.disconnect();
      });
      api.on('status:change', () => { renderPanel(); renderSheet(); });
      api.on('multiplayer:capabilities', () => { renderPanel(); renderSheet(); });

      if (migration.droppedMarkers || migration.migratedCharacters || migration.migratedTokenLocations || migration.blockedTokenLocations) {
        setStatus(`Entity System 已启用：迁移 ${migration.migratedCharacters} 个旧角色${migration.migratedTokenLocations ? `，吸附 ${migration.migratedTokenLocations} 个 Token 到 1m 格子` : ''}${migration.blockedTokenLocations ? `，${migration.blockedTokenLocations} 个 Token 位于阻挡格，需 GM 重新放置` : ''}${migration.droppedMarkers ? `，移除 ${migration.droppedMarkers} 个旧标记` : ''}`);
      }
      renderPanel();
    },
  };
}
