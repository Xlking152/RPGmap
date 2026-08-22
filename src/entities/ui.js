import { createActorFromImport, addFormToActor, currentForm } from './model.js';
import {
  resolveActor,
  setResourceCurrent,
  setResourceMaxOverride,
  setAttributeAdjustment,
  addCustomResource,
  removeCustomResource,
  setActorForm,
  cycleActorForm,
} from './resolver.js';
import { importCharacterXlsx } from './xlsx-importer.js';
import { imageToAvatarDataUrl } from './avatar.js';
import { EntityStore } from './store.js';
import { normalizeCharacterCard } from './schema.js';

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
    .entity-card-actions { display:flex; gap:6px; flex-wrap:wrap; }
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
    @keyframes entity-indicator { 0%{opacity:0;transform:translate(-50%,-6px)} 15%,75%{opacity:1;transform:translate(-50%,0)} 100%{opacity:0;transform:translate(-50%,-8px)} }
    @media (max-width:760px) { .entity-grid{grid-template-columns:1fr 1fr}.entity-sheet-backdrop{padding:8px}.entity-resource{grid-template-columns:1fr auto auto}.entity-resource .entity-resource-edit{grid-column:1/-1} }
  `;
  documentNode.head.append(style);
}

function avatarHtml(actor) {
  const form = currentForm(actor);
  const avatar = form?.avatarDataUrl;
  if (avatar) return `<span class="entity-avatar"><img src="${escapeHtml(avatar)}" alt=""></span>`;
  return `<span class="entity-avatar">${escapeHtml((actor?.name?.trim()?.[0] || '?').toUpperCase())}</span>`;
}

function blankImport() {
  return {
    formName: '默认形态',
    identity: { name: '新角色' },
    description: {},
    resources: { hp: { max: 0 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: [], checks: { skills: [], saves: [] }, combat: { attacks: [], defenses: [] },
    tokenAppearance: { color: '#3d9b63', scale: 1 }, source: { type: 'manual' }, avatarDataUrl: null,
  };
}

export function createEntityUiTool(options = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      installStyles(documentNode);
      const store = new EntityStore(api);
      const migration = store.load({ migrateLegacy: true, dropMarkers: options.dropLegacyMarkers !== false });
      let selectedTokenId = null;
      let pendingPlacementActorId = null;
      let pendingImportActorId = null;
      let openActorId = null;
      let openTab = 'overview';
      let renderingPanel = false;
      let importBusy = false;

      const characterTab = shell.querySelector('[data-tab="characters"]');
      if (characterTab) characterTab.textContent = '指示物';
      if (shell.querySelector('[data-tab="markers"].active')) characterTab?.click();
      const panel = shell.querySelector('[data-panel="characters"]');
      const toolbar = shell.querySelector('.toolbar-right');
      const importButton = documentNode.createElement('button');
      importButton.type = 'button';
      importButton.className = 'tool-button entity-toolbar-button';
      importButton.textContent = '导入角色卡';
      importButton.title = '导入 XLSX：仅读取角色概览与具体数值表';
      toolbar?.prepend(importButton);
      const xlsxInput = documentNode.createElement('input');
      xlsxInput.type = 'file'; xlsxInput.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; xlsxInput.hidden = true;
      toolbar?.append(xlsxInput);
      const avatarInput = documentNode.createElement('input');
      avatarInput.type = 'file'; avatarInput.accept = 'image/*'; avatarInput.hidden = true;
      toolbar?.append(avatarInput);

      function entityState() { return store.state; }
      function tokenCount(actorId) { return entityState().tokens.filter(token => String(token.actorId) === String(actorId)).length; }
      function setStatus(message) { const node = shell.querySelector('[data-role="map-status"]'); if (node) node.textContent = message; }
      function indicator(message) {
        const node = documentNode.createElement('div'); node.className = 'entity-indicator'; node.textContent = message;
        (mapElement.parentElement || mapElement).append(node); setTimeout(() => node.remove(), 1300);
      }
      function persistAndRender() { store.persist(); renderPanel(); renderSheet(); }

      function renderPanel() {
        if (!panel) return;
        renderingPanel = true;
        const actors = entityState().actors;
        panel.innerHTML = `
          <div class="entity-panel" data-entity-panel>
            <div class="entity-panel-head">
              <button type="button" class="small-button primary" data-entity-action="import">导入角色卡</button>
              <button type="button" class="small-button" data-entity-action="new">新建空白角色</button>
            </div>
            <div class="entity-help">Actor 保存角色数据；Token 只负责地图位置和表现。双击 Token 或按列表中的“角色卡”打开属性。选中有多个形态的 Token 后按 <b>V</b> 切换形态。</div>
            <div data-entity-list>${actors.length ? actors.map(actor => {
              const form = currentForm(actor);
              const count = tokenCount(actor.id);
              return `<article class="entity-card" data-actor-id="${escapeHtml(actor.id)}">
                <div class="entity-card-top">${avatarHtml(actor)}<div class="entity-card-copy"><strong>${escapeHtml(actor.name)}</strong><small>${escapeHtml(form?.name || '无形态')} · ${count ? `${count} 个 Token` : '未放置'}</small></div></div>
                <div class="entity-card-actions">
                  <button type="button" class="small-button" data-entity-action="open" data-id="${escapeHtml(actor.id)}">角色卡</button>
                  <button type="button" class="small-button" data-entity-action="place" data-id="${escapeHtml(actor.id)}">放置 Token</button>
                  <button type="button" class="small-button" data-entity-action="add-form" data-id="${escapeHtml(actor.id)}">导入新形态</button>
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
        const resolved = resolveActor(actor);
        const form = resolved?.form;
        if (!resolved || !form) return '<div class="entity-empty">角色没有可用形态。</div>';
        if (tab === 'overview') {
          const resources = resolved.resources.map(resource => {
            const ratio = resource.max > 0 ? Math.max(0, Math.min(100, resource.current / resource.max * 100)) : 0;
            return `<div class="entity-resource" data-resource-id="${escapeHtml(resource.id)}">
              <strong>${escapeHtml(resource.name)}</strong>
              <button type="button" class="small-button" data-resource-step="-1" data-resource-id="${escapeHtml(resource.id)}">−</button>
              <label><input type="number" step="1" value="${resource.current}" data-resource-current="${escapeHtml(resource.id)}"> / </label>
              <label class="entity-resource-edit"><input type="number" step="1" min="0" value="${resource.max}" data-resource-max="${escapeHtml(resource.id)}" title="当前最大值；核心资源改这里会建立运行时覆盖"> 最大</label>
              <div class="entity-resource-bar"><span style="width:${ratio}%"></span></div>
              ${resource.custom ? `<button type="button" class="small-button danger" data-resource-delete="${escapeHtml(resource.id)}">删除 ${escapeHtml(resource.name)}</button>` : ''}
            </div>`;
          }).join('');
          return `
            <section class="entity-section"><h3>核心资源</h3>${resources}<button type="button" class="small-button" data-sheet-action="add-resource">+ 添加特殊能量槽</button></section>
            <section class="entity-section"><h3>角色信息</h3><div class="entity-description">${escapeHtml([form.identity?.race, form.identity?.gender, form.identity?.age].filter(Boolean).join(' · '))}</div>${form.description?.summary ? `<p class="entity-description">${escapeHtml(form.description.summary)}</p>` : ''}</section>
            <section class="entity-section"><h3>当前形态描述</h3><div class="entity-description">${escapeHtml(form.description?.appearance || '暂无外貌描述')}</div>${form.description?.personality ? `<p class="entity-description">${escapeHtml(form.description.personality)}</p>` : ''}</section>`;
        }
        if (tab === 'attributes') {
          const cells = resolved.attributes.map(attribute => `<div class="entity-stat"><span>${escapeHtml(attribute.name)}</span><strong>${attribute.value}</strong><small>基础 ${attribute.base}${attribute.legendaryBonus ? ` · 传奇 ${attribute.legendaryBonus}` : ''}</small><label>临时 <input type="number" step="1" value="${actor.runtime?.attributeAdjustments?.[attribute.id] || 0}" data-attribute-adjust="${escapeHtml(attribute.id)}"></label></div>`).join('');
          return `<section class="entity-section"><h3>属性</h3><div class="entity-grid">${cells || '<div class="entity-empty">当前形态没有属性数据。</div>'}</div><p class="entity-help">Excel 值作为 Base 保留；“临时”只修改 Runtime，不会覆盖重新导入的基础值。</p></section>`;
        }
        if (tab === 'checks') {
          const skills = form.checks?.skills || [];
          const saves = form.checks?.saves || [];
          return `<section class="entity-section"><h3>技能鉴定</h3><table class="entity-check-table"><thead><tr><th>分类</th><th>技能</th><th>鉴定</th><th>等级 + 附加</th><th>专业</th></tr></thead><tbody>${skills.map(skill => `<tr><td>${escapeHtml(skill.category)}</td><td>${escapeHtml(skill.name)}</td><td><b>${skill.checkValue}</b></td><td>${skill.level} + ${skill.bonus}</td><td>${escapeHtml(skill.specialties || '')}</td></tr>`).join('')}</tbody></table></section>
            <section class="entity-section"><h3>豁免 / 抵抗鉴定</h3><table class="entity-check-table"><thead><tr><th>组合</th><th>轻度</th><th>严重</th><th>毁灭</th></tr></thead><tbody>${saves.map(save => `<tr><td>${escapeHtml(save.name)}</td><td><b>${save.light}</b></td><td>${save.severe}</td><td>${save.devastating}</td></tr>`).join('')}</tbody></table></section>`;
        }
        if (tab === 'combat') {
          return `<section class="entity-section"><h3>攻击</h3><div class="entity-empty">攻击结构已预留，暂不从 Excel 导入。</div></section><section class="entity-section"><h3>防御</h3><div class="entity-empty">防御结构已预留，后续单独设计规则。</div></section>`;
        }
        const tokens = entityState().tokens.filter(token => String(token.actorId) === String(actor.id));
        const appState = api.getState();
        return `<section class="entity-section"><h3>Token</h3>${tokens.length ? tokens.map(token => {
          const character = appState.characters?.find(item => String(item.id) === String(token.characterId));
          const pos = character?.location?.type === 'map' ? `${Math.round(character.location.x)}, ${Math.round(character.location.y)}` : character?.location?.type === 'building' ? `建筑 ${character.location.featureId}` : '未知';
          return `<div class="entity-card"><strong>Token ${escapeHtml(token.id)}</strong><small>位置：${escapeHtml(pos)}</small></div>`;
        }).join('') : '<div class="entity-empty">当前角色尚未放置 Token。</div>'}<button type="button" class="small-button" data-sheet-action="place-token">放置 Token</button></section>`;
      }

      function renderSheet() {
        const existing = documentNode.querySelector('.entity-sheet-backdrop');
        if (!openActorId) { existing?.remove(); return; }
        const actor = store.actor(openActorId);
        if (!actor) { openActorId = null; existing?.remove(); return; }
        const tabs = [['overview','概览'],['attributes','属性'],['checks','鉴定'],['combat','战斗'],['token','Token']];
        const html = `<div class="entity-sheet-backdrop"><div class="entity-sheet" role="dialog" aria-modal="true">
          <header class="entity-sheet-header">${avatarHtml(actor)}<div class="entity-sheet-title"><input type="text" maxlength="80" value="${escapeHtml(actor.name)}" data-actor-name><div class="entity-formbar"><span>当前形态</span><select data-form-select>${actor.forms.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === actor.currentFormId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select><button type="button" class="small-button primary" data-sheet-action="cycle-form">V · 切换</button><button type="button" class="small-button" data-sheet-action="add-form">+ 形态</button><button type="button" class="small-button" data-sheet-action="avatar">更换头像</button></div></div><button type="button" class="small-button" data-sheet-action="close">关闭</button></header>
          <nav class="entity-sheet-tabs">${tabs.map(([id,label]) => `<button type="button" class="entity-sheet-tab ${openTab === id ? 'active' : ''}" data-sheet-tab="${id}">${label}</button>`).join('')}</nav>
          <main class="entity-sheet-body">${actorSheetBody(actor, openTab)}</main>
        </div></div>`;
        if (existing) existing.outerHTML = html; else documentNode.body.insertAdjacentHTML('beforeend', html);
      }

      function openSheet(actorId, tab = openTab) { openActorId = actorId; openTab = tab; renderSheet(); }
      function closeSheet() { openActorId = null; renderSheet(); }

      async function parseImport(file, actorId = null) {
        if (!file || importBusy) return;
        importBusy = true; setStatus('正在读取角色卡…');
        try {
          const imported = normalizeCharacterCard(await importCharacterXlsx(file));
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
            if (actor.forms.some(form => form.name === formName)) formName += ` ${actor.forms.length + 1}`;
            addFormToActor(actor, imported, { name: formName });
            if (imported.avatarDataUrl) currentForm(actor).avatarDataUrl = imported.avatarDataUrl;
            store.persist();
            openSheet(actor.id);
            indicator(`${actor.name} · ${currentForm(actor).name}`);
            setStatus(`已导入 ${actor.name} 的新形态“${currentForm(actor).name}”`);
          } else {
            actor = createActorFromImport(imported);
            if (imported.avatarDataUrl) currentForm(actor).avatarDataUrl = imported.avatarDataUrl;
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
          importBusy = false; xlsxInput.value = ''; pendingImportActorId = null;
        }
      }

      function chooseImport(actorId = null) { pendingImportActorId = actorId; xlsxInput.click(); }
      function placeActor(actorId) {
        pendingPlacementActorId = actorId;
        api.setTool('character-place');
        setStatus(`放置 Token：请在地图上点击“${store.actor(actorId)?.name || '角色'}”的位置`);
      }

      function handlePanelClick(event) {
        const button = event.target.closest('[data-entity-action]'); if (!button) return;
        const action = button.dataset.entityAction; const id = button.dataset.id;
        if (action === 'import') chooseImport();
        else if (action === 'new') {
          const actor = createActorFromImport(blankImport()); entityState().actors.push(actor); store.persist(); renderPanel(); openSheet(actor.id);
        } else if (action === 'open') openSheet(id);
        else if (action === 'place') placeActor(id);
        else if (action === 'add-form') chooseImport(id);
      }
      panel?.addEventListener('click', handlePanelClick);
      importButton.addEventListener('click', () => chooseImport());
      xlsxInput.addEventListener('change', () => parseImport(xlsxInput.files?.[0], pendingImportActorId));

      documentNode.addEventListener('click', event => {
        const sheet = event.target.closest('.entity-sheet'); if (!sheet) return;
        const actor = store.actor(openActorId); if (!actor) return;
        const tab = event.target.closest('[data-sheet-tab]');
        if (tab) { openTab = tab.dataset.sheetTab; renderSheet(); return; }
        const actionNode = event.target.closest('[data-sheet-action]');
        if (actionNode) {
          const action = actionNode.dataset.sheetAction;
          if (action === 'close') closeSheet();
          else if (action === 'cycle-form') { const form = cycleActorForm(actor); if (form) { store.persist(); renderPanel(); renderSheet(); indicator(`${actor.name} · ${form.name}`); } }
          else if (action === 'add-form') chooseImport(actor.id);
          else if (action === 'avatar') avatarInput.click();
          else if (action === 'add-resource') {
            const name = prompt('特殊能量槽名称：', '特殊能量'); if (!name) return;
            const max = Number(prompt('最大值：', '10') || 0); const current = Number(prompt('当前值：', String(max)) || max);
            addCustomResource(actor, { name, max, current }); persistAndRender();
          } else if (action === 'place-token') placeActor(actor.id);
          return;
        }
        const step = event.target.closest('[data-resource-step]');
        if (step) { const id = step.dataset.resourceId; const current = resolveActor(actor).resources.find(r => r.id === id)?.current || 0; setResourceCurrent(actor, id, current + Number(step.dataset.resourceStep)); persistAndRender(); return; }
        const del = event.target.closest('[data-resource-delete]');
        if (del && confirm('删除这个特殊能量槽？')) { removeCustomResource(actor, del.dataset.resourceDelete); persistAndRender(); }
      });

      documentNode.addEventListener('change', event => {
        const sheet = event.target.closest('.entity-sheet'); if (!sheet) return;
        const actor = store.actor(openActorId); if (!actor) return;
        if (event.target.matches('[data-actor-name]')) { actor.name = String(event.target.value || '未命名角色').trim().slice(0,80) || '未命名角色'; persistAndRender(); }
        else if (event.target.matches('[data-form-select]')) { const form = setActorForm(actor, event.target.value); if (form) { store.persist(); renderPanel(); renderSheet(); indicator(`${actor.name} · ${form.name}`); } }
        else if (event.target.matches('[data-resource-current]')) { setResourceCurrent(actor, event.target.dataset.resourceCurrent, event.target.value); persistAndRender(); }
        else if (event.target.matches('[data-resource-max]')) { setResourceMaxOverride(actor, event.target.dataset.resourceMax, event.target.value); persistAndRender(); }
        else if (event.target.matches('[data-attribute-adjust]')) { setAttributeAdjustment(actor, event.target.dataset.attributeAdjust, event.target.value); persistAndRender(); }
      });

      avatarInput.addEventListener('change', async () => {
        const actor = store.actor(openActorId); const file = avatarInput.files?.[0]; if (!actor || !file) return;
        try { currentForm(actor).avatarDataUrl = await imageToAvatarDataUrl(file); store.persist(); renderPanel(); renderSheet(); }
        catch (error) { alert('头像处理失败：' + error.message); }
        finally { avatarInput.value = ''; }
      });

      documentNode.addEventListener('keydown', event => {
        if (event.defaultPrevented || editableTarget(event.target) || event.key.toLowerCase() !== 'v' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!selectedTokenId) return;
        const actor = store.actorForToken(selectedTokenId); if (!actor || actor.forms.length < 2) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const form = cycleActorForm(actor); store.persist(); renderPanel(); renderSheet(); indicator(`${actor.name} · ${form.name}`); setStatus(`形态切换：${actor.name} → ${form.name}`);
      }, true);

      mapElement.addEventListener('dblclick', event => {
        if (!event.target.closest?.('.rpg-character, .rpg-character-core')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        queueMicrotask(() => { const actor = selectedTokenId ? store.actorForToken(selectedTokenId) : null; if (actor) openSheet(actor.id); });
      }, true);

      api.on('character:select', event => { selectedTokenId = event.detail?.id || null; });
      api.on('character:create', event => {
        const characterId = event.detail?.id; if (!characterId) return;
        if (pendingPlacementActorId) {
          store.bindToken(pendingPlacementActorId, characterId);
          const actor = store.actor(pendingPlacementActorId);
          pendingPlacementActorId = null;
          store.persist(); selectedTokenId = characterId; api.selectCharacter?.(characterId);
          queueMicrotask(() => {
            documentNode.querySelectorAll('.character-modal').forEach(modal => modal.closest('.modal-backdrop')?.remove());
            renderPanel(); if (actor) openSheet(actor.id, 'overview');
          });
        } else if (!store.saving) {
          store.load({ migrateLegacy: true, dropMarkers: false }); renderPanel();
        }
      });
      api.on('character:delete', event => { if (event.detail?.id) { store.removeToken(event.detail.id); if (!store.saving) store.persist(); renderPanel(); } });
      api.on('state:import', () => {
        if (store.saving) return;
        store.load({ migrateLegacy: true, dropMarkers: true }); renderPanel(); renderSheet();
      });
      api.on('character:move', renderPanel);

      if (migration.droppedMarkers || migration.migratedCharacters) {
        setStatus(`Entity System 已启用：迁移 ${migration.migratedCharacters} 个旧角色${migration.droppedMarkers ? `，移除 ${migration.droppedMarkers} 个旧标记` : ''}`);
      }
      renderPanel();
    },
  };
}
