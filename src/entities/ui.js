import { createActorFromImport, addFormToActor } from './model.js';
import { describeActor, describeActorSheet as describeActorSheetDocument, performActorOperation as performActorDocumentOperation } from '../actor/index.js';
import { importActorXlsx } from './xlsx-importer.js';
import { normalizeActorClassification } from '../actor/classification.js';
import { imageToAvatarDataUrl } from './avatar.js';
import { EntityStore } from './store.js';
import { upsertCanonicalActor } from './actor-operations.js';
import { createEntityTokenController } from './token-controller.js';
import {
  canManageStatusDefinitions,
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
    [data-tab="markers"] { display: none !important; }
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
    .entity-placement-hud { position:fixed; z-index:4300; left:50%; bottom:max(18px, env(safe-area-inset-bottom)); transform:translateX(-50%); display:flex; align-items:center; gap:10px; max-width:calc(100vw - 24px); padding:10px 12px; border:1px solid rgba(23,109,118,.45); border-radius:10px; background:#f8faf7; color:#25383a; box-shadow:0 10px 30px rgba(0,0,0,.24); font-weight:750; }
    .entity-placement-hud button { flex:0 0 auto; }
    .entity-sheet-readonly input, .entity-sheet-readonly select,
    .entity-sheet-readonly [data-sheet-action]:not([data-sheet-action="close"]) { pointer-events:none; opacity:.55; }
    .entity-template-runtime-readonly [data-actor-operation],
    .entity-template-runtime-readonly [data-form-select],
    .entity-template-runtime-readonly [data-sheet-action="cycle-form"] { pointer-events:none; opacity:.55; }
    @keyframes entity-indicator { 0%{opacity:0;transform:translate(-50%,-6px)} 15%,75%{opacity:1;transform:translate(-50%,0)} 100%{opacity:0;transform:translate(-50%,-8px)} }
    @media (max-width:760px) { .entity-grid{grid-template-columns:1fr 1fr}.entity-sheet-backdrop{padding:8px}.entity-resource{grid-template-columns:1fr auto auto}.entity-resource .entity-resource-edit{grid-column:1/-1}.token-config-grid{grid-template-columns:1fr}.token-config-feedback{grid-column:1}.token-config-tabs button{font-size:12px;padding-inline:2px} }
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
  if (section.type === 'detection') {
    const ranges = (section.ranges || []).map(item => `<label class="entity-detection-range"><span>${escapeHtml(item.label)}</span><input type="number" min="0" step="1" value="${escapeHtml(item.value)}"${operationData(item.operation)}><small>形态基础 ${escapeHtml(item.base)} m</small></label>`).join('');
    const senses = (section.senses || []).map(item => `<label class="entity-detection-sense"><input type="checkbox"${item.value ? ' checked' : ''}${operationData(item.operation)}> ${escapeHtml(item.label)}<small>基础 ${item.base ? '是' : '否'}</small></label>`).join('');
    return `<section class="entity-section" data-sheet-section-id="${escapeHtml(section.id || '')}">${title}<div class="entity-detection-ranges">${ranges}</div><div class="entity-detection-senses">${senses}</div>${help}</section>`;
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

export function classifyNewImportedActor(actor, actorType = 'pc') {
  const classification = normalizeActorClassification({
    type: actorType,
    partyId: String(actorType) === 'pc' ? actor?.partyId : null,
  });
  return { ...actor, type: classification.type, partyId: classification.partyId };
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
      const describeActorSheet = actor => describeActorSheetDocument(actor, store.actorContext(actor));
      const performActorOperation = (actor, operation) => performActorDocumentOperation(actor, operation, store.actorContext(actor));
      let selectedTokenId = null;
      let openTokenId = null;
      let pendingImportActorId = null;
      let pendingImportActorType = 'pc';
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
      async function persistActorAndRender(actor, { source = 'entities:actor.edit', render = false } = {}) {
        try {
          await upsertCanonicalActor(api, actor, { source, render });
          return true;
        } catch (error) {
          console.error('[RPGmap Entity UI] canonical Actor update failed', error);
          setStatus(`角色更新失败：${error?.message || error}`);
          return false;
        } finally {
          // Actor edits mutate an editor draft before submission. Always reload
          // the canonical World projection so a rejected LAN/revision write
          // cannot remain visible as an uncommitted local Actor value.
          store.load({ migrateLegacy: false, dropMarkers: false });
          renderPanel();
          renderSheet();
        }
      }
      function openToken() {
        const token = openTokenId ? api.tokens?.get?.(openTokenId) : null;
        return token && String(token.actorId) === String(openActorId) ? token : null;
      }
      function sheetActor() {
        const token = openToken();
        if (!token || token.actorLink !== false) return store.actor(openActorId);
        try { return api.tokens.resolveActor(token.id).actor; }
        catch { return store.actor(openActorId); }
      }
      async function performCanonicalRuntimeOperation(operation, {
        source = 'actor.runtime.perform',
        tokenId = openToken()?.id || null,
        actorId = openActorId,
      } = {}) {
        const token = tokenId ? api.tokens?.get?.(tokenId) : null;
        const actor = store.actor(actorId || token?.actorId);
        if (!actor) return false;
        const payload = token
          ? { sceneId: api.world.get().activeSceneId, tokenId: token.id, operation }
          : { sceneId: api.world.get().activeSceneId, actorId: actor.id, operation };
        try {
          await api.world.performOperations([{ type: 'actor.runtime.perform', payload }], { source });
          return true;
        } catch (error) {
          setStatus(`角色运行状态更新失败：${error?.message || error}`);
          return false;
        } finally {
          store.load({ migrateLegacy: false, dropMarkers: false });
          renderPanel();
          renderSheet();
        }
      }
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
      function requireRuntimeEdit(actor) {
        const token = openToken();
        if (token) {
          const connected = api.multiplayer?.getStatus?.()?.connected;
          if (!connected || api.multiplayer?.canControlToken?.(token.id) === true) return true;
          setStatus('当前没有该 Token 实例的控制权限');
          return false;
        }
        if (['monster', 'npc', 'summon'].includes(String(actor?.type || ''))) {
          setStatus('怪物、NPC 与召唤物的运行状态必须从地图 Token 实例卡修改');
          return false;
        }
        return requireActorEdit(actor?.id);
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
        const actors = entityState().actors.filter(actor => String(actor.type || 'pc') === 'pc');
        const canManageStructure = capabilities().canManageStructure;
        const legacyMarkerCount = Array.isArray(api.getState().markers) ? api.getState().markers.length : 0;
        importButton.hidden = !canManageStructure || !rulesetCapabilities.canImportXlsx;
        panel.innerHTML = `
          <div class="entity-panel" data-entity-panel>
            <div class="entity-panel-head">
              ${canManageStructure && rulesetCapabilities.canImportXlsx ? '<button type="button" class="small-button primary" data-entity-action="import">导入角色卡</button>' : ''}${canManageStructure ? '<button type="button" class="small-button" data-entity-action="new">新建空白角色</button>' : ''}
              ${canManageStructure && legacyMarkerCount ? `<button type="button" class="small-button" data-entity-action="migrate-markers">迁移 ${legacyMarkerCount} 个旧标记</button>` : ''}
            </div>
            <div class="entity-help">角色资料与地图棋子分别管理；同一角色可以放置多个棋子，独立棋子也可以保留自己的状态。${legacyMarkerCount ? `检测到 ${legacyMarkerCount} 个旧标记；它们会保留，只有 GM 确认迁移后才会删除。` : '双击地图棋子或按列表中的“角色卡”打开属性。选中有多个形态的棋子后按 <b>V</b> 切换形态。'}</div>
            <div data-entity-list>${actors.length ? actors.map(actor => {
              const presentation = describeActor(actor, { ruleset: api.ruleset }) || {};
              const sheetCapabilities = actorUiCapabilities(api.ruleset, describeActorSheet(actor, { ruleset: api.ruleset }));
              const count = tokenCount(actor.id);
              const canEditActor = capabilities().canEditActor?.(actor.id);
              const canPlaceActor = capabilities().canPlaceActor?.(actor.id);
              const statusSnapshot = actor.audienceRestricted ? { actorStatuses: [], derivedStatuses: [] }
                : resolveStatusUiSnapshot(api, { actorId: actor.id });
              const typeLabel = ({ pc: 'PC', monster: '怪物', npc: 'NPC', summon: '召唤物', other: '其他' })[actor.type] || 'PC';
              return `<article class="entity-card" data-actor-id="${escapeHtml(actor.id)}">
                <div class="entity-card-status"><small>${escapeHtml(typeLabel)} · ${['monster', 'npc', 'summon'].includes(String(actor.type)) ? '独立实例' : '共享角色'}</small></div>
                <div class="entity-card-top">${avatarHtml(actor, api.ruleset)}<div class="entity-card-copy"><strong>${escapeHtml(actor.name)}</strong><small>${escapeHtml(presentation.variantLabel || '无形态')} · ${count ? `${count} 个 Token` : '未放置'}</small></div></div>
                <div class="entity-card-status">${renderStatusStrip([...statusSnapshot.actorStatuses, ...statusSnapshot.derivedStatuses], { limit: 4, emptyText: '无状态' })}</div>
                <div class="entity-card-actions">
                  ${actor.audienceRestricted ? '' : `<button type="button" class="small-button" data-entity-action="open" data-id="${escapeHtml(actor.id)}">角色卡</button>`}
                  ${canPlaceActor ? `<label><input type="checkbox" data-entity-share checked> 共享角色数据</label><button type="button" class="small-button" data-entity-action="place" data-id="${escapeHtml(actor.id)}">放置 Token</button>` : ''}
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
          const instanceToken = openToken();
          const tokens = instanceToken
            ? [instanceToken]
            : allTokens.filter(token => String(token.actorId) === String(actor.id));
          const statusTargetAllowed = instanceToken
            ? capabilities().canControlToken?.(instanceToken.id) !== false
            : capabilities().canEditActor?.(actor.id) !== false;
          return renderActorStatusSheet({
            api,
            actor,
            tokens,
            allTokens,
            selectedTokenIds: api.selection?.getSelectedTokenIds?.() || (selectedTokenId ? [selectedTokenId] : []),
            canManage: canManageStatuses(api) && statusTargetAllowed,
            canManageDefinitions: canManageStatusDefinitions(api),
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
        const actor = sheetActor();
        if (!actor) { openActorId = null; existing?.remove(); return; }
        const sheetDescription = describeActorSheet(actor, { ruleset: api.ruleset }) || { variants: [], tabs: [] };
        const sheetCapabilities = actorUiCapabilities(api.ruleset, sheetDescription);
        const tabs = [...(sheetDescription.tabs || []).map(item => [item.id, item.label]), ['status','状态'], ['token','Token']];
        if (!tabs.some(([id]) => id === openTab)) openTab = tabs[0]?.[0] || 'status';
        const instanceToken = openToken();
        const instanceMode = instanceToken?.actorLink === false;
        const independentTemplate = !instanceMode && ['monster', 'npc', 'summon'].includes(String(actor.type));
        const canEdit = actor.audienceRestricted !== true && (instanceMode
          ? (api.multiplayer?.getStatus?.()?.connected ? api.multiplayer?.canControlToken?.(instanceToken.id) === true : true)
          : capabilities().canEditActor?.(actor.id));
        const actorTokens = tokenController.actorTokens(actor.id);
        const selectedToken = actorTokens.find(token => String(token.id) === String(selectedTokenId));
        const titleSnapshot = resolveStatusUiSnapshot(api, {
          actorId: actor.id,
          ...(selectedToken ? { tokenId: selectedToken.id } : {}),
        });
        const classificationControls = !instanceMode && capabilities().canManageStructure
          ? `<div class="entity-formbar"><label>类型<select data-actor-type><option value="pc" ${actor.type === 'pc' ? 'selected' : ''}>PC</option><option value="monster" ${actor.type === 'monster' ? 'selected' : ''}>怪物</option><option value="npc" ${actor.type === 'npc' ? 'selected' : ''}>NPC</option><option value="summon" ${actor.type === 'summon' ? 'selected' : ''}>召唤物</option><option value="other" ${actor.type === 'other' ? 'selected' : ''}>其他</option></select></label><label>队伍<input data-actor-party maxlength="80" value="${escapeHtml(actor.partyId || '')}"></label></div>`
          : '';
        const html = `<div class="entity-sheet-backdrop"><div class="entity-sheet ${canEdit ? '' : 'entity-sheet-readonly'} ${independentTemplate ? 'entity-template-runtime-readonly' : ''}" data-actor-id="${escapeHtml(actor.id)}" data-token-id="${escapeHtml(instanceToken?.id || '')}" data-sheet-mode="${instanceMode ? 'instance' : 'template'}" role="dialog" aria-modal="true">
          <header class="entity-sheet-header">${avatarHtml(actor, api.ruleset)}<div class="entity-sheet-title"><input type="text" maxlength="80" value="${escapeHtml(actor.name)}" data-actor-name ${instanceMode || actor.audienceRestricted ? 'disabled' : ''}><div class="entity-formbar"><strong>${instanceMode ? 'Token 实例卡' : 'Actor 模板卡'}</strong>${sheetCapabilities.hasVariants ? `<span>当前形态</span><select data-form-select>${(sheetDescription.variants || []).map(item => `<option value="${escapeHtml(item.id)}" ${String(item.id) === String(sheetDescription.currentVariantId) ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>${sheetCapabilities.canCycleVariants ? '<button type="button" class="small-button primary" data-sheet-action="cycle-form">V · 切换</button>' : ''}${!instanceMode && sheetCapabilities.canImportXlsx ? '<button type="button" class="small-button" data-sheet-action="add-form">+ 形态</button>' : ''}` : ''}${instanceMode ? '' : '<button type="button" class="small-button" data-sheet-action="avatar">更换头像</button>'}</div><div class="status-title-band">${renderStatusStrip(titleSnapshot.statuses, { limit: 8, emptyText: '无机械状态' })}</div></div><button type="button" class="small-button" data-sheet-action="close">关闭</button></header>
          ${classificationControls}<nav class="entity-sheet-tabs">${tabs.map(([id,label]) => `<button type="button" class="entity-sheet-tab ${openTab === id ? 'active' : ''}" data-sheet-tab="${id}">${label}</button>`).join('')}</nav>
          <main class="entity-sheet-body">${actorSheetBody(actor, openTab)}</main>
        </div></div>`;
        if (existing) existing.outerHTML = html;
        else documentNode.body.insertAdjacentHTML('beforeend', html);
      }

      function openSheet(actorId, tab = openTab, tokenId = null) { openActorId = actorId; openTokenId = tokenId; openTab = tab; renderSheet(); }
      function closeSheet() { openActorId = null; openTokenId = null; renderSheet(); }
      api.entities = {
        openActor(actorId, tab) {
          const actor = store.actor(actorId);
          if (!actor || actor.audienceRestricted === true) {
            api.showToast?.('当前身份无权读取该 Actor 模板卡', 'error');
            return false;
          }
          openSheet(actorId, tab, null);
          return true;
        },
        openToken(tokenId, tab) {
          const token = api.tokens?.get?.(tokenId);
          if (!token) return false;
          let resolved = null;
          try { resolved = api.tokens?.resolveActor?.(token.id)?.actor || store.actor(token.actorId); }
          catch { resolved = store.actor(token.actorId); }
          if (!resolved || resolved.audienceRestricted === true) {
            api.showToast?.('当前身份无权读取该 Token 的角色卡', 'error');
            return false;
          }
          openSheet(token.actorId, tab, token.id);
          return true;
        },
        placeActor(actorId, options = {}) { tokenController.beginPlacement(actorId, options); },
        requestImport(actorType = 'pc') { chooseImport(null, actorType); },
        canImportXlsx: rulesetCapabilities.canImportXlsx,
        closeSheet,
      };

      async function parseImport(file, actorId = null, actorType = 'pc') {
        if (!requireStructure('只有 GM 可以导入角色卡或形态')) return;
        if (!file || importBusy) return;
        importBusy = true;
        setStatus('正在读取角色卡…');
        try {
          const imported = await importActorXlsx(file, { ruleset: api.ruleset });
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
            if (!await persistActorAndRender(actor, { source: 'entities:actor.form.import' })) return;
            openSheet(actor.id);
            indicator(`${actor.name} · ${form?.name || formName}`);
            setStatus(`已导入 ${actor.name} 的新形态“${form?.name || formName}”`);
          } else {
            actor = classifyNewImportedActor(createActorFromImport(imported, { ruleset: api.ruleset }), actorType);
            if (!await persistActorAndRender(actor, { source: 'entities:actor.create' })) return;
            openSheet(actor.id);
            setStatus(`已创建角色“${actor.name}” · 可点击“放置棋子”放到地图`);
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
          pendingImportActorType = 'pc';
        }
      }

      function chooseImport(actorId = null, actorType = 'pc') {
        if (!requireStructure('只有 GM 可以导入角色卡或形态')) return;
        pendingImportActorId = actorId;
        pendingImportActorType = actorType;
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

      async function handlePanelClick(event) {
        const button = event.target.closest('[data-entity-action]');
        if (!button) return;
        const action = button.dataset.entityAction;
        const id = button.dataset.id;
        if (action === 'import') chooseImport();
        else if (action === 'new') {
          if (!requireStructure()) return;
          const actor = createActorFromImport({}, { ruleset: api.ruleset });
          if (!await persistActorAndRender(actor, { source: 'entities:actor.create' })) return;
          openSheet(actor.id);
        } else if (action === 'open') openSheet(id);
        else if (action === 'place') {
          const shared = button.closest('[data-actor-id]')?.querySelector('[data-entity-share]')?.checked !== false;
          tokenController.beginPlacement(id, { actorLink: shared });
        }
        else if (action === 'add-form') chooseImport(id);
        else if (action === 'delete') tokenController.removeActor(id).catch(error => {
          console.error('[RPGmap Entity UI] Actor delete failed', error);
          setStatus(`删除失败：${error?.message || error}`);
        });
        else if (action === 'migrate-markers') migrateLegacyMarkers();
      }

      panel.addEventListener('click', handlePanelClick);
      importButton.addEventListener('click', () => chooseImport());
      xlsxInput.addEventListener('change', () => parseImport(xlsxInput.files?.[0], pendingImportActorId, pendingImportActorType));

      documentNode.addEventListener('click', async event => {
        if (statusUi.handleClick(event)) return;
        if (event.target.closest?.('[data-entity-placement-cancel]')) {
          event.preventDefault();
          tokenController.clearPlacement({ message: '已取消 Token 放置' });
          return;
        }
        const sheet = event.target.closest('.entity-sheet');
        if (!sheet) return;
        const actor = sheetActor();
        if (!actor) return;
        const operationNode = event.target.closest('[data-actor-operation]');
        if (operationNode && operationNode.tagName !== 'INPUT') {
          if (!requireRuntimeEdit(actor)) return;
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
          await performCanonicalRuntimeOperation(operation, { source: 'entities:actor.operation' });
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
            if (!requireRuntimeEdit(actor)) return;
            await performCanonicalRuntimeOperation({ type: 'variant.cycle', direction: 1 }, {
              source: 'entities:actor.form.cycle',
            });
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
        const actor = sheetActor();
        if (!actor) return;
        if (event.target.matches('[data-actor-name]')) {
          const baseActor = store.actor(openActorId);
          if (!baseActor || openToken() || !requireActorEdit(baseActor.id)) { renderSheet(); return; }
          baseActor.name = String(event.target.value || '未命名角色').trim().slice(0, 80) || '未命名角色';
          await persistActorAndRender(baseActor, { source: 'entities:actor.rename' });
        } else if (event.target.matches('[data-actor-type]')) {
          const baseActor = store.actor(openActorId);
          if (!baseActor || openToken() || !requireStructure()) { renderSheet(); return; }
          const nextType = String(event.target.value || 'pc');
          try {
            if (['monster', 'npc', 'summon'].includes(nextType)) {
              await api.world.performOperations([{ type: 'actor.instances.detach', payload: {
                actorId: baseActor.id,
                actorType: nextType,
                partyId: baseActor.partyId,
              } }], { source: 'entities:actor.instances.detach' });
            } else {
              baseActor.type = nextType;
              await persistActorAndRender(baseActor, { source: 'entities:actor.classification' });
            }
          } catch (error) {
            setStatus(`Actor 类型更新失败：${error?.message || error}`);
          } finally {
            store.load({ migrateLegacy: false, dropMarkers: false });
            renderPanel();
            renderSheet();
          }
        } else if (event.target.matches('[data-actor-party]')) {
          const baseActor = store.actor(openActorId);
          if (!baseActor || openToken() || !requireStructure()) { renderSheet(); return; }
          baseActor.partyId = String(event.target.value || '').trim().slice(0, 80) || null;
          await persistActorAndRender(baseActor, { source: 'entities:actor.party' });
        } else if (event.target.matches('[data-form-select]')) {
          if (!requireRuntimeEdit(actor)) { renderSheet(); return; }
          await performCanonicalRuntimeOperation({ type: 'variant.set', variantId: event.target.value }, {
            source: 'entities:actor.form.select',
          });
        } else if (event.target.matches('[data-actor-operation]')) {
          if (!requireRuntimeEdit(actor)) { renderSheet(); return; }
          const operation = decodeData(event.target.dataset.actorOperation);
          if (!operation) return;
          operation.value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
          await performCanonicalRuntimeOperation(operation, { source: 'entities:actor.operation' });
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
            await persistActorAndRender(actor, { source: 'entities:actor.avatar' });
          }
        } catch (error) {
          alert('头像处理失败：' + error.message);
        } finally {
          avatarInput.value = '';
        }
      });

      documentNode.addEventListener('keydown', async event => {
        if (tokenController.handleKeydown(event)) return;
        if (event.defaultPrevented || editableTarget(event.target) || event.key.toLowerCase() !== 'v' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!selectedTokenId) return;
        const token = api.tokens.get?.(selectedTokenId);
        const actor = token ? store.actor(token.actorId) : null;
        if (!actor || (describeActorSheet(actor, { ruleset: api.ruleset })?.variants?.length || 0) < 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        await performCanonicalRuntimeOperation({ type: 'variant.cycle', direction: 1 }, {
          source: 'entities:actor.form.shortcut', tokenId: token.id, actorId: actor.id,
        });
      }, true);

      mapElement.addEventListener('dblclick', event => {
        if (!event.target.closest?.('.rpg-token-v2')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        queueMicrotask(() => {
          const token = selectedTokenId ? api.tokens.get?.(selectedTokenId) : null;
          if (token?.actorId) api.entities.openToken(token.id, openTab);
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
        setStatus(`角色系统已就绪：迁移 ${migration.migratedCharacters} 个旧角色${migration.migratedTokenLocations ? `，吸附 ${migration.migratedTokenLocations} 个棋子到 1m 格子` : ''}${migration.blockedTokenLocations ? `，${migration.blockedTokenLocations} 个棋子位于阻挡格，需 GM 重新放置` : ''}${migration.droppedMarkers ? `，移除 ${migration.droppedMarkers} 个旧标记` : ''}`);
      }
      renderPanel();
    },
  };
}
