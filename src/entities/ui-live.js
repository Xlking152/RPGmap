import { createActorFromImport, addFormToActor } from './model.js';
import {
  describeActor,
  describeActorSheet as describeActorSheetDocument,
  performActorOperation as performActorDocumentOperation,
} from '../actor/index.js';
import { importActorXlsx } from './xlsx-importer.js';
import { imageToAvatarDataUrl } from './avatar.js';
import { EntityStore } from './store.js';
import { upsertCanonicalActor } from './actor-operations.js';
import { createEntityTokenController } from './token-controller.js';
import { createActorSheetManager } from './sheet-manager.js';
import { ActorSheet } from './sheet/actor-sheet.js';
import { normalizeActorPublicProfile } from '../actor/public-profile.js';
import {
  actorUiCapabilities,
  classifyNewImportedActor,
  decodeEntityData,
  editableEntityTarget,
  entityAvatarHtml,
  escapeEntityHtml,
  installEntityStyles,
  renderEntitySheetSections,
} from './sheet-renderer.js';
import {
  canManageStatusDefinitions,
  canManageStatuses,
  createStatusUiController,
  installStatusUiStyles,
  renderActorStatusSheet,
  renderStatusStrip,
  resolveStatusUiSnapshot,
} from '../status/ui.js';

function id(value) {
  return String(value ?? '').trim();
}

function worldStorageId(api) {
  return String(api.world?.get?.()?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function activeSceneId(api) {
  return id(api.world?.get?.()?.activeSceneId);
}

export function createEntityUiTool(options = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const windowNode = documentNode.defaultView || globalThis;
      const shell = mapElement.closest('.app-shell') || documentNode;
      installEntityStyles(documentNode);
      installStatusUiStyles(documentNode);

      const store = new EntityStore(api, { canonicalTokenReads: true });
      const migration = store.load({
        migrateLegacy: true,
        dropMarkers: options.dropLegacyMarkers !== false,
      });
      const describeActorSheet = actor => describeActorSheetDocument(actor, store.actorContext(actor));
      const performActorOperation = (actor, operation) => performActorDocumentOperation(
        actor,
        operation,
        store.actorContext(actor),
      );
      const sheetManager = createActorSheetManager({
        storage: windowNode?.localStorage || null,
        storageKey: `rpgmap.ui.actor-sheets.v1.${worldStorageId(api)}`,
      });

      let selectedTokenId = null;
      let activeSheetKey = null;
      let pendingAvatarSheetKey = null;
      let renderingPanel = false;
      let importBusy = false;
      let destroyed = false;
      const publicProfilePending = new Set();
      const publicProfilePreview = new Set();
      const publicProfileDrafts = new Map();
      const publicProfileFeedback = new Map();
      const sheetInstances = new Map();
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

      const avatarInput = documentNode.createElement('input');
      avatarInput.type = 'file';
      avatarInput.accept = 'image/*';
      avatarInput.hidden = true;
      toolbar?.append(avatarInput);

      function entityState() { return store.state; }
      function canonicalTokens() { return api.tokens?.list?.() || []; }
      function tokenCount(actorId) {
        return canonicalTokens().filter(token => id(token.actorId) === id(actorId)).length;
      }
      function setStatus(message) {
        const node = shell.querySelector('[data-role="map-status"]');
        if (node) node.textContent = message;
      }
      function indicator(message) {
        const node = documentNode.createElement('div');
        node.className = 'entity-indicator';
        node.textContent = message;
        (mapElement.parentElement || mapElement).append(node);
        windowNode.setTimeout?.(() => node.remove(), 1300);
      }
      function backdropForKey(key) {
        return [...documentNode.querySelectorAll('.entity-sheet-backdrop[data-sheet-window-key]')]
          .find(node => node.dataset.sheetWindowKey === String(key || '')) || null;
      }
      function recordForSheet(sheet) {
        return sheetManager.get(sheet?.dataset?.sheetWindowKey || '') || null;
      }
      function recordForNode(node) {
        return recordForSheet(node?.closest?.('.entity-sheet'));
      }
      function resolveSheetRecord(record) {
        if (!record) return null;
        const baseActor = store.actor(record.actorId);
        if (!baseActor) return null;
        if (!record.tokenId) return { record, actor: baseActor, baseActor, token: null };
        if (id(record.sceneId) !== activeSceneId(api)) return null;
        const token = api.tokens?.get?.(record.tokenId);
        if (!token || id(token.actorId) !== id(record.actorId)) return null;
        if (token.actorLink !== false) return { record, actor: baseActor, baseActor, token };
        try {
          const actor = api.tokens?.resolveActor?.(token.id)?.actor || baseActor;
          return { record, actor, baseActor, token };
        } catch {
          return { record, actor: baseActor, baseActor, token };
        }
      }
      function activeSheetContext() {
        return resolveSheetRecord(sheetManager.get(activeSheetKey));
      }
      function contextForNode(node) {
        return resolveSheetRecord(recordForNode(node)) || activeSheetContext();
      }
      function refreshZOrder() {
        for (const record of sheetManager.list()) {
          const backdrop = backdropForKey(record.key);
          if (backdrop) backdrop.style.zIndex = String(record.zIndex);
        }
      }
      function focusSheet(key) {
        const record = sheetManager.activate(key);
        if (!record) return false;
        activeSheetKey = record.key;
        refreshZOrder();
        return true;
      }
      function applyGeometry(record) {
        const backdrop = backdropForKey(record?.key);
        const sheet = backdrop?.querySelector?.('.entity-sheet');
        if (!backdrop || !sheet || !record) return;
        backdrop.style.zIndex = String(record.zIndex);
        if (record.left != null) sheet.style.left = `${Math.round(record.left)}px`;
        if (record.top != null) sheet.style.top = `${Math.round(record.top)}px`;
        if (record.width != null) sheet.style.width = `${Math.round(record.width)}px`;
        if (record.height != null) sheet.style.height = `${Math.round(record.height)}px`;
      }
      function captureSheetGeometry(key, rect = {}) {
        const record = sheetManager.capture(key, rect);
        if (record) applyGeometry(record);
        return Boolean(record);
      }
      function closeSheet(key = activeSheetKey) {
        const target = String(key || '');
        if (!target) return false;
        backdropForKey(target)?.remove();
        sheetInstances.get(target)?.dispose?.();
        sheetInstances.delete(target);
        const closed = sheetManager.close(target);
        if (!closed) return false;
        if (activeSheetKey === target) activeSheetKey = sheetManager.list().at(-1)?.key || null;
        refreshZOrder();
        return true;
      }

      function applySheetParts(record, html, actorSheet) {
        const template = documentNode.createElement('template');
        template.innerHTML = String(html || '').trim();
        const incomingBackdrop = template.content.firstElementChild;
        const incomingSheet = incomingBackdrop?.querySelector?.('.entity-sheet');
        if (!incomingBackdrop || !incomingSheet) return false;
        let backdrop = backdropForKey(record.key);
        if (!backdrop) {
          documentNode.body.append(incomingBackdrop);
          backdrop = incomingBackdrop;
        } else {
          const currentSheet = backdrop.querySelector('.entity-sheet');
          backdrop.className = incomingBackdrop.className;
          for (const attribute of [...incomingBackdrop.attributes]) {
            if (attribute.name !== 'style') backdrop.setAttribute(attribute.name, attribute.value);
          }
          if (!currentSheet) backdrop.append(incomingSheet);
          else {
            currentSheet.className = incomingSheet.className;
            for (const attribute of [...currentSheet.attributes]) {
              if (attribute.name !== 'style' && !incomingSheet.hasAttribute(attribute.name)) currentSheet.removeAttribute(attribute.name);
            }
            for (const attribute of [...incomingSheet.attributes]) {
              if (attribute.name !== 'style') currentSheet.setAttribute(attribute.name, attribute.value);
            }
            const selectors = [
              ':scope > .entity-sheet-header',
              ':scope > [data-sheet-edit-only]',
              ':scope > .entity-sheet-tabs',
              ':scope > .entity-sheet-body',
            ];
            for (const selector of selectors) {
              const currentPart = currentSheet.querySelector(selector);
              const incomingPart = incomingSheet.querySelector(selector);
              if (!incomingPart) currentPart?.remove();
              else if (!currentPart) currentSheet.append(incomingPart);
              else if (currentPart.innerHTML !== incomingPart.innerHTML) currentPart.replaceChildren(...[...incomingPart.childNodes]);
            }
          }
        }
        const previous = sheetInstances.get(record.key);
        if (previous !== actorSheet) previous?.dispose?.();
        sheetInstances.set(record.key, actorSheet);
        applyGeometry(sheetManager.get(record.key) || record);
        return true;
      }
      function closeAllSheets() {
        for (const record of [...sheetManager.list()]) closeSheet(record.key);
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
          store.load({ migrateLegacy: false, dropMarkers: false });
          renderPanel();
          renderRelatedSheets({ actorIds: [actor?.id].filter(Boolean) });
        }
      }

      async function performCanonicalRuntimeOperation(operation, {
        source = 'actor.runtime.perform',
        record = null,
        tokenId = null,
        actorId = null,
        sceneId = null,
      } = {}) {
        const context = record ? resolveSheetRecord(record) : null;
        const targetTokenId = id(tokenId || context?.token?.id) || null;
        const targetActorId = id(actorId || context?.record?.actorId) || null;
        const targetSceneId = id(sceneId || context?.record?.sceneId || activeSceneId(api));
        const token = targetTokenId && targetSceneId === activeSceneId(api)
          ? api.tokens?.get?.(targetTokenId)
          : null;
        const actor = store.actor(targetActorId || token?.actorId);
        if (!actor) return false;
        const payload = targetTokenId
          ? { sceneId: targetSceneId, tokenId: targetTokenId, operation }
          : { sceneId: targetSceneId, actorId: actor.id, operation };
        try {
          await api.world.performOperations([{ type: 'actor.runtime.perform', payload }], { source });
          return true;
        } catch (error) {
          setStatus(`角色运行状态更新失败：${error?.message || error}`);
          return false;
        } finally {
          store.load({ migrateLegacy: false, dropMarkers: false });
          renderPanel();
          renderRelatedSheets({
            actorIds: [targetActorId, actor?.id].filter(Boolean),
            tokenIds: [targetTokenId].filter(Boolean),
          });
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
      function requireActorStructureEdit(record) {
        if (!record || record.tokenId || record.interactionMode !== 'edit') {
          setStatus('请先切换到“编辑卡片”模式');
          return false;
        }
        return requireActorEdit(record.actorId);
      }

      function sheetPermissionLevel(actor) {
        if (actor?.audienceRestricted === true) return 'limited';
        return api.permissions?.actorLevel?.(actor?.id)
          || (api.multiplayer?.getStatus?.()?.session?.role === 'gm' ? 'gm' : 'owner');
      }

      function createLiveActorSheet(actor, token, record, { canRuntimeEdit = false } = {}) {
        return new ActorSheet({
          actor,
          token,
          permissionLevel: sheetPermissionLevel(actor),
          mode: record?.interactionMode || 'play',
          canRuntimeEdit,
          canTokenEdit: token ? api.permissions?.can?.('token.edit', { token }) === true : false,
        });
      }
      function requireRuntimeEdit(actor, record) {
        const context = resolveSheetRecord(record);
        if (context?.token) {
          const connected = api.multiplayer?.getStatus?.()?.connected;
          if (!connected || api.multiplayer?.canControlToken?.(context.token.id) === true) return true;
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
        getContext: node => {
          const context = contextForNode(node);
          const actor = context?.actor || null;
          const allTokens = canonicalTokens();
          return {
            actor,
            allTokens,
            tokens: context?.token
              ? [context.token]
              : actor
                ? allTokens.filter(token => id(token.actorId) === id(actor.id))
                : [],
          };
        },
        render: renderPanel,
        setStatus,
      });

      const tokenController = createEntityTokenController({
        api,
        documentNode,
        mapElement,
        store,
        capabilities,
        setStatus,
        // Multi-window sheets no longer need to disappear while the map is in
        // placement mode. The wrapper is deliberately a no-op.
        closeSheet: () => {},
        renderPanel,
        renderSheet: renderAllSheets,
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
              const sheetCapabilities = actorUiCapabilities(api.ruleset, describeActorSheet(actor));
              const count = tokenCount(actor.id);
              const canEditActor = capabilities().canEditActor?.(actor.id);
              const canPlaceActor = capabilities().canPlaceActor?.(actor.id);
              const statusSnapshot = actor.audienceRestricted
                ? { actorStatuses: [], derivedStatuses: [] }
                : resolveStatusUiSnapshot(api, { actorId: actor.id });
              const typeLabel = ({ pc: 'PC', monster: '怪物', npc: 'NPC', summon: '召唤物', other: '其他' })[actor.type] || 'PC';
              return `<article class="entity-card" data-actor-id="${escapeEntityHtml(actor.id)}">
                <div class="entity-card-status"><small>${escapeEntityHtml(typeLabel)} · ${['monster', 'npc', 'summon'].includes(String(actor.type)) ? '独立实例' : '共享角色'}</small></div>
                <div class="entity-card-top">${entityAvatarHtml(actor, api.ruleset)}<div class="entity-card-copy"><strong>${escapeEntityHtml(actor.name)}</strong><small>${escapeEntityHtml(presentation.variantLabel || '无形态')} · ${count ? `${count} 个 Token` : '未放置'}</small></div></div>
                <div class="entity-card-status">${renderStatusStrip([...statusSnapshot.actorStatuses, ...statusSnapshot.derivedStatuses], { limit: 4, emptyText: '无状态' })}</div>
                <div class="entity-card-actions">
                  <button type="button" class="small-button" data-entity-action="open" data-id="${escapeEntityHtml(actor.id)}">${actor.audienceRestricted ? '公开摘要' : '角色卡'}</button>
                  ${canPlaceActor ? `<label><input type="checkbox" data-entity-share checked> 共享角色数据</label><button type="button" class="small-button" data-entity-action="place" data-id="${escapeEntityHtml(actor.id)}">放置 Token</button>` : ''}
                  ${canManageStructure && sheetCapabilities.hasVariants && sheetCapabilities.canImportXlsx ? `<button type="button" class="small-button" data-entity-action="add-form" data-id="${escapeEntityHtml(actor.id)}">导入新形态</button>` : ''}${canManageStructure ? `<button type="button" class="small-button danger" data-entity-action="delete" data-id="${escapeEntityHtml(actor.id)}">删除角色</button>` : ''}
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

      function actorSheetBody(context, tab, actorSheet) {
        const { actor, token } = context;
        if (tab === 'public-profile') {
          const draft = publicProfileDrafts.get(context.record.key);
          const editorActor = draft ? { ...actor, publicProfile: draft } : actor;
          const editorSheet = createLiveActorSheet(editorActor, null, context.record);
          return editorSheet.renderPublicProfileEditor({
            statusDefinitions: api.world?.get?.()?.statusDefinitions || [],
            pending: publicProfilePending.has(context.record.key),
            feedback: publicProfileFeedback.get(context.record.key) || '',
            preview: publicProfilePreview.has(context.record.key),
          });
        }
        if (tab === 'status') {
          const allTokens = canonicalTokens();
          const tokens = token
            ? [token]
            : allTokens.filter(item => id(item.actorId) === id(actor.id));
          const statusTargetAllowed = token
            ? capabilities().canControlToken?.(token.id) !== false
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
        const description = describeActorSheet(actor) || {};
        const tabDescription = (description.tabs || []).find(item => id(item.id) === id(tab));
        return tabDescription
          ? renderEntitySheetSections(tabDescription.sections)
          : '<div class="entity-empty">规则包没有提供这个角色卡页签。</div>';
      }

      function publicProfileFromSheet(record) {
        const root = backdropForKey(record?.key)?.querySelector('[data-public-profile-editor]');
        if (!root) return null;
        return normalizeActorPublicProfile({
          summary: root.querySelector('[name="summary"]')?.value || '',
          appearance: root.querySelector('[name="appearance"]')?.value || '',
          knownFacts: String(root.querySelector('[name="knownFacts"]')?.value || '').split(/\r?\n/),
          visibleStatusDefinitionIds: [...root.querySelectorAll('[name="visibleStatusDefinitionIds"]:checked')].map(input => input.value),
        }, { statusDefinitionIds: (api.world?.get?.()?.statusDefinitions || []).map(definition => definition.id) });
      }

      async function savePublicProfile(record) {
        const actor = record && !record.tokenId ? store.actor(record.actorId) : null;
        const profile = publicProfileFromSheet(record);
        if (!actor || !profile || !api.permissions?.can?.('actor.editPublicProfile', { actorId: actor.id, actor })) {
          setStatus('只有 GM 可以修改公开资料');
          return false;
        }
        if (publicProfilePending.has(record.key)) return false;
        publicProfilePending.add(record.key);
        publicProfileFeedback.set(record.key, '正在等待服务器确认…');
        renderSheetRecord(record);
        try {
          await api.world.performOperations([{ type: 'actor.publicProfile.update', payload: { actorId: actor.id, publicProfile: profile } }], { source: 'entities:actor.public-profile' });
          publicProfileDrafts.delete(record.key);
          publicProfileFeedback.set(record.key, '已由服务器确认');
          setStatus(`${actor.name} 的公开资料已更新`);
          return true;
        } catch (error) {
          publicProfileDrafts.delete(record.key);
          publicProfileFeedback.set(record.key, `保存失败：${error?.message || error}`);
          setStatus(`公开资料保存失败：${error?.message || error}`);
          return false;
        } finally {
          publicProfilePending.delete(record.key);
          store.load({ migrateLegacy: false, dropMarkers: false });
          renderPanel();
          renderAllSheets();
        }
      }

      function renderSheetRecord(record) {
        if (destroyed || !record) return false;
        const context = resolveSheetRecord(record);
        if (!context) {
          closeSheet(record.key);
          return false;
        }
        const { actor, token } = context;
        const runtimeAllowed = token
          ? (!api.multiplayer?.getStatus?.()?.connected || api.permissions?.can?.('token.control', { token }) === true)
          : api.permissions?.can?.('actor.edit', { actorId: actor.id, actor }) === true;
        const actorSheet = createLiveActorSheet(actor, token, record, { canRuntimeEdit: runtimeAllowed });
        const windowAttrs = `data-sheet-window-key="${escapeEntityHtml(record.key)}" data-scene-id="${escapeEntityHtml(record.sceneId || '')}"`;
        if (actor.audienceRestricted === true) {
          const typeLabel = ({ pc: 'PC', monster: '怪物', npc: 'NPC', summon: '召唤物', other: '其他' })[actor.type] || '其他';
          const html = `<div class="entity-sheet-backdrop entity-sheet-window" ${windowAttrs}><div class="entity-sheet entity-sheet-v3 entity-limited-sheet" ${windowAttrs} data-actor-id="${escapeEntityHtml(actor.id)}" data-token-id="${escapeEntityHtml(token?.id || '')}" data-sheet-mode="limited" data-sheet-interaction-mode="limited" role="dialog" aria-modal="false">
            <header class="entity-sheet-header">${entityAvatarHtml(actor, api.ruleset)}<div class="entity-sheet-title"><strong>${escapeEntityHtml(actor.name)}</strong><div class="entity-formbar"><span>${escapeEntityHtml(typeLabel)}</span><strong>公开摘要</strong></div>${actorSheet.renderBadges()}</div><button type="button" class="small-button" data-sheet-action="close">关闭</button></header>
            <main class="entity-sheet-body">${actorSheet.renderLimited()}</main>
          </div></div>`;
          return applySheetParts(record, html, actorSheet);
        }

        const sheetDescription = describeActorSheet(actor) || { variants: [], tabs: [] };
        const sheetKind = String(sheetDescription.kind || ({ pc: 'character', monster: 'monster', npc: 'npc', summon: 'monster' })[actor.type] || 'generic');
        const sheetCapabilities = actorUiCapabilities(api.ruleset, sheetDescription);
        const tabs = [...(sheetDescription.tabs || []).map(item => [item.id, item.label]), ['status', '状态'], ['token', 'Token']];
        if (!token && api.permissions?.can?.('actor.editPublicProfile', { actorId: actor.id, actor })) tabs.push(['public-profile', '公开资料']);
        let tab = record.tab;
        if (!tabs.some(([tabId]) => id(tabId) === id(tab))) {
          tab = tabs[0]?.[0] || 'status';
          sheetManager.update(record.key, { tab });
        }
        const instanceMode = token?.actorLink === false;
        const independentTemplate = !instanceMode && ['monster', 'npc', 'summon'].includes(String(actor.type));
        const canEdit = actor.audienceRestricted !== true && (instanceMode
          ? (api.multiplayer?.getStatus?.()?.connected ? api.multiplayer?.canControlToken?.(token.id) === true : true)
          : capabilities().canEditActor?.(actor.id));
        const actorTokens = tokenController.actorTokens(actor.id);
        const statusToken = token || actorTokens.find(item => id(item.id) === id(selectedTokenId));
        const titleSnapshot = resolveStatusUiSnapshot(api, {
          actorId: actor.id,
          ...(statusToken ? { tokenId: statusToken.id } : {}),
        });
        const classificationControls = !instanceMode && actorSheet.context.editable && capabilities().canManageStructure
          ? `<div class="entity-formbar" data-sheet-edit-only><label>类型<select data-actor-type><option value="pc" ${actor.type === 'pc' ? 'selected' : ''}>PC</option><option value="monster" ${actor.type === 'monster' ? 'selected' : ''}>怪物</option><option value="npc" ${actor.type === 'npc' ? 'selected' : ''}>NPC</option><option value="summon" ${actor.type === 'summon' ? 'selected' : ''}>召唤物</option><option value="other" ${actor.type === 'other' ? 'selected' : ''}>其他</option></select></label><label>队伍<input data-actor-party maxlength="80" value="${escapeEntityHtml(actor.partyId || '')}"></label></div>`
          : '';
        const deleteTemplateDanger = !instanceMode
          && actorSheet.context.editable
          && capabilities().canManageStructure
          && ['monster', 'npc', 'summon', 'other'].includes(String(actor.type))
          ? `<section class="entity-section entity-danger-zone" data-sheet-edit-only><h3>危险操作</h3><div class="entity-help">删除模板会同时删除所有 Scene 中的关联 Token，并清理战斗引用。</div><button type="button" class="small-button danger" data-sheet-action="delete-template">删除模板</button></section>`
          : '';
        const html = `<div class="entity-sheet-backdrop entity-sheet-window" ${windowAttrs}><div class="entity-sheet entity-sheet-v3 ${canEdit ? '' : 'entity-sheet-readonly'} ${independentTemplate ? 'entity-template-runtime-readonly' : ''}" ${windowAttrs} data-actor-id="${escapeEntityHtml(actor.id)}" data-token-id="${escapeEntityHtml(token?.id || '')}" data-sheet-kind="${escapeEntityHtml(sheetKind)}" data-sheet-mode="${instanceMode ? 'instance' : 'template'}" data-sheet-interaction-mode="${actorSheet.context.mode}" role="dialog" aria-modal="false">
          <header class="entity-sheet-header">${entityAvatarHtml(actor, api.ruleset)}<div class="entity-sheet-title"><input type="text" maxlength="80" value="${escapeEntityHtml(actor.name)}" data-actor-name ${actorSheet.context.editable ? '' : 'disabled'}><div class="entity-formbar"><strong>${instanceMode ? 'Token 实例卡' : 'Actor 模板卡'}</strong>${sheetCapabilities.hasVariants ? `<span>当前形态</span><select data-form-select>${(sheetDescription.variants || []).map(item => `<option value="${escapeEntityHtml(item.id)}" ${id(item.id) === id(sheetDescription.currentVariantId) ? 'selected' : ''}>${escapeEntityHtml(item.label)}</option>`).join('')}</select>${sheetCapabilities.canCycleVariants ? '<button type="button" class="small-button primary" data-sheet-action="cycle-form">V · 切换</button>' : ''}${!instanceMode && sheetCapabilities.canImportXlsx && actorSheet.context.editable ? '<button type="button" class="small-button" data-sheet-edit-only data-sheet-action="add-form">+ 形态</button>' : ''}` : ''}${!instanceMode && actorSheet.context.editable ? '<button type="button" class="small-button" data-sheet-edit-only data-sheet-action="avatar">更换头像</button>' : ''}</div>${actorSheet.renderBadges(sheetDescription)}<div class="status-title-band">${renderStatusStrip(titleSnapshot.statuses, { limit: 8, emptyText: '无机械状态' })}</div></div><button type="button" class="small-button" data-sheet-action="close">关闭</button></header>
          ${classificationControls}<nav class="entity-sheet-tabs">${tabs.map(([tabId, label]) => `<button type="button" class="entity-sheet-tab ${id(tab) === id(tabId) ? 'active' : ''}" data-sheet-tab="${escapeEntityHtml(tabId)}">${escapeEntityHtml(label)}</button>`).join('')}</nav>
          <main class="entity-sheet-body">${actorSheetBody(context, tab, actorSheet)}${deleteTemplateDanger}</main>
        </div></div>`;
        return applySheetParts(record, html, actorSheet);
      }

      function renderAllSheets() {
        for (const record of [...sheetManager.list()]) renderSheetRecord(record);
        refreshZOrder();
      }

      function renderRelatedSheets({ actorIds = [], tokenIds = [] } = {}) {
        const actors = new Set(actorIds.map(String));
        const tokens = new Set(tokenIds.map(String));
        for (const record of [...sheetManager.list()]) {
          if (actors.has(String(record.actorId)) || (record.tokenId && tokens.has(String(record.tokenId)))) {
            renderSheetRecord(record);
          }
        }
        refreshZOrder();
      }

      function openSheet(actorId, tab = null, tokenId = null) {
        const sceneId = tokenId ? activeSceneId(api) : null;
        const opened = sheetManager.open({ actorId, tokenId, sceneId, tab });
        if (!opened.record) return false;
        activeSheetKey = opened.record.key;
        renderSheetRecord(opened.record);
        focusSheet(opened.record.key);
        return true;
      }

      api.entities = {
        ...api.entities,
        openActor(actorId, tab = null) {
          const actor = store.actor(actorId);
          if (!actor) return false;
          return openSheet(actor.id, tab, null);
        },
        openToken(tokenId, tab = null) {
          const token = api.tokens?.get?.(tokenId);
          if (!token) return false;
          let resolved = null;
          try { resolved = api.tokens?.resolveActor?.(token.id)?.actor || store.actor(token.actorId); }
          catch { resolved = store.actor(token.actorId); }
          if (!resolved) return false;
          return openSheet(token.actorId, tab, token.id);
        },
        placeActor(actorId, placementOptions = {}) { tokenController.beginPlacement(actorId, placementOptions); },
        importFile(file, context = {}) {
          return parseImport(file, context.actorId || null, context.actorType || 'pc');
        },
        removeActor(actorId) { return tokenController.removeActor(actorId); },
        canImportXlsx: rulesetCapabilities.canImportXlsx,
        closeSheet,
        focusSheet,
        captureSheetGeometry,
        listOpenSheets() { return sheetManager.list().map(record => ({ ...record })); },
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
            if (sameName && windowNode.confirm?.(`检测到已有角色“${sameName.name}”。是否把“${imported.formName}”添加为该角色的新形态？`)) actor = sameName;
          }
          if (actor) {
            let formName = imported.formName;
            const beforeSheet = describeActorSheet(actor) || { variants: [] };
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
          windowNode.alert?.('角色卡导入失败：' + error.message);
          setStatus('角色卡导入失败');
        } finally {
          importBusy = false;
        }
      }

      function migrateLegacyMarkers() {
        if (!requireStructure('只有 GM 可以迁移旧标记')) return;
        const next = api.getState();
        const markers = Array.isArray(next.markers) ? next.markers : [];
        if (!markers.length) return;
        if (!windowNode.confirm?.(`迁移会删除 ${markers.length} 个旧标记，并把关联范围保留在当前坐标作为自由锚点。服务器会先建立备份。是否继续？`)) return;
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
        const actorId = button.dataset.id;
        if (action === 'import') api.entities.requestImport({ actorId: null, actorType: 'pc' });
        else if (action === 'new') {
          if (!requireStructure()) return;
          const actor = createActorFromImport({}, { ruleset: api.ruleset });
          if (!await persistActorAndRender(actor, { source: 'entities:actor.create' })) return;
          openSheet(actor.id);
        } else if (action === 'open') api.entities.openActor(actorId);
        else if (action === 'place') {
          const shared = button.closest('[data-actor-id]')?.querySelector('[data-entity-share]')?.checked !== false;
          tokenController.beginPlacement(actorId, { actorLink: shared });
        } else if (action === 'add-form') api.entities.requestImport({ actorId, actorType: 'pc' });
        else if (action === 'delete') tokenController.removeActor(actorId).catch(error => {
          console.error('[RPGmap Entity UI] Actor delete failed', error);
          setStatus(`删除失败：${error?.message || error}`);
        });
        else if (action === 'migrate-markers') migrateLegacyMarkers();
      }

      panel.addEventListener('click', handlePanelClick);
      importButton.addEventListener('click', () => api.entities.requestImport({ actorId: null, actorType: 'pc' }));

      function activateEventSheet(event) {
        const record = recordForNode(event.target);
        if (record) focusSheet(record.key);
        return record;
      }

      documentNode.addEventListener('pointerdown', activateEventSheet, true);

      documentNode.addEventListener('click', async event => {
        const record = activateEventSheet(event);
        if (statusUi.handleClick(event)) return;
        if (event.target.closest?.('[data-entity-placement-cancel]')) {
          event.preventDefault();
          tokenController.clearPlacement({ message: '已取消 Token 放置' });
          return;
        }
        if (!record) return;
        const context = resolveSheetRecord(record);
        const actor = context?.actor;
        if (!actor) return;

        const modeToggle = event.target.closest('[data-sheet-mode-toggle]');
        if (modeToggle) {
          sheetManager.update(record.key, { interactionMode: record.interactionMode === 'edit' ? 'play' : 'edit' });
          renderSheetRecord(sheetManager.get(record.key));
          return;
        }
        if (event.target.closest('[data-public-profile-preview]')) {
          const draft = publicProfileFromSheet(record);
          if (draft) publicProfileDrafts.set(record.key, draft);
          if (publicProfilePreview.has(record.key)) publicProfilePreview.delete(record.key);
          else publicProfilePreview.add(record.key);
          renderSheetRecord(record);
          return;
        }
        if (event.target.closest('[data-public-profile-save]')) {
          await savePublicProfile(record);
          return;
        }

        const operationNode = event.target.closest('[data-actor-operation]');
        if (operationNode && operationNode.tagName !== 'INPUT') {
          if (!requireRuntimeEdit(actor, record)) return;
          const operation = decodeEntityData(operationNode.dataset.actorOperation);
          if (!operation) return;
          const confirmation = operationNode.dataset.operationConfirm;
          if (confirmation && !windowNode.confirm?.(confirmation)) return;
          const prompts = decodeEntityData(operationNode.dataset.operationPrompts);
          if (Array.isArray(prompts)) {
            const answers = {};
            for (const field of prompts) {
              const fallback = field.defaultFrom ? answers[field.defaultFrom] : field.defaultValue;
              const answer = windowNode.prompt?.(field.label || `${field.key}：`, fallback ?? '');
              if (answer === null || answer === undefined) return;
              answers[field.key] = field.number ? Number(answer || 0) : answer;
            }
            Object.assign(operation, answers);
          }
          await performCanonicalRuntimeOperation(operation, {
            source: 'entities:actor.operation',
            record,
          });
          return;
        }

        const tab = event.target.closest('[data-sheet-tab]');
        if (tab) {
          sheetManager.update(record.key, { tab: tab.dataset.sheetTab });
          renderSheetRecord(sheetManager.get(record.key));
          return;
        }

        const actionNode = event.target.closest('[data-sheet-action]');
        if (!actionNode) return;
        if (await tokenController.handleSheetAction(actionNode, actor)) return;
        const action = actionNode.dataset.sheetAction;
        if (action === 'close') closeSheet(record.key);
        else if (action === 'delete-template') {
          if (!record.tokenId && requireActorStructureEdit(record) && requireStructure()) {
            await tokenController.removeActor(record.actorId);
          }
        }
        else if (action === 'cycle-form') {
          if (!requireRuntimeEdit(actor, record)) return;
          await performCanonicalRuntimeOperation({ type: 'variant.cycle', direction: 1 }, {
            source: 'entities:actor.form.cycle',
            record,
          });
        } else if (action === 'add-form') {
          if (requireActorStructureEdit(record)) api.entities.requestImport({ actorId: record.actorId, actorType: 'pc' });
        }
        else if (action === 'avatar') {
          if (!record.tokenId && requireActorStructureEdit(record)) {
            pendingAvatarSheetKey = record.key;
            avatarInput.click();
          }
        }
      });

      documentNode.addEventListener('submit', event => { statusUi.handleSubmit(event); });

      documentNode.addEventListener('change', async event => {
        const record = activateEventSheet(event);
        if (statusUi.handleChange(event)) return;
        if (await tokenController.handleChange(event.target)) return;
        if (!record) return;
        const context = resolveSheetRecord(record);
        const actor = context?.actor;
        if (!actor) return;

        if (event.target.matches('[data-actor-name]')) {
          const baseActor = store.actor(record.actorId);
          if (!baseActor || record.tokenId || !requireActorStructureEdit(record)) { renderSheetRecord(record); return; }
          baseActor.name = String(event.target.value || '未命名角色').trim().slice(0, 80) || '未命名角色';
          await persistActorAndRender(baseActor, { source: 'entities:actor.rename' });
        } else if (event.target.matches('[data-actor-type]')) {
          const baseActor = store.actor(record.actorId);
          if (!baseActor || record.tokenId || !requireActorStructureEdit(record) || !requireStructure()) { renderSheetRecord(record); return; }
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
            renderAllSheets();
          }
        } else if (event.target.matches('[data-actor-party]')) {
          const baseActor = store.actor(record.actorId);
          if (!baseActor || record.tokenId || !requireActorStructureEdit(record) || !requireStructure()) { renderSheetRecord(record); return; }
          baseActor.partyId = String(event.target.value || '').trim().slice(0, 80) || null;
          await persistActorAndRender(baseActor, { source: 'entities:actor.party' });
        } else if (event.target.matches('[data-form-select]')) {
          if (!requireRuntimeEdit(actor, record)) { renderSheetRecord(record); return; }
          await performCanonicalRuntimeOperation({ type: 'variant.set', variantId: event.target.value }, {
            source: 'entities:actor.form.select',
            record,
          });
        } else if (event.target.matches('[data-actor-operation]')) {
          if (!requireRuntimeEdit(actor, record)) { renderSheetRecord(record); return; }
          const operation = decodeEntityData(event.target.dataset.actorOperation);
          if (!operation) return;
          operation.value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
          await performCanonicalRuntimeOperation(operation, {
            source: 'entities:actor.operation',
            record,
          });
        }
      });

      avatarInput.addEventListener('change', async () => {
        const record = sheetManager.get(pendingAvatarSheetKey);
        const actor = record && !record.tokenId ? store.actor(record.actorId) : null;
        const file = avatarInput.files?.[0];
        if (!actor || !file) {
          avatarInput.value = '';
          pendingAvatarSheetKey = null;
          return;
        }
        try {
          const result = performActorOperation(actor, {
            type: 'avatar.set',
            avatarDataUrl: await imageToAvatarDataUrl(file),
          });
          if (result.changed) await persistActorAndRender(actor, { source: 'entities:actor.avatar' });
        } catch (error) {
          windowNode.alert?.('头像处理失败：' + error.message);
        } finally {
          avatarInput.value = '';
          pendingAvatarSheetKey = null;
        }
      });

      documentNode.addEventListener('keydown', async event => {
        if (tokenController.handleKeydown(event)) return;
        if (event.defaultPrevented || editableEntityTarget(event.target)
          || event.key.toLowerCase() !== 'v' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!selectedTokenId) return;
        const token = api.tokens.get?.(selectedTokenId);
        const actor = token ? store.actor(token.actorId) : null;
        if (!actor || (describeActorSheet(actor)?.variants?.length || 0) < 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        await performCanonicalRuntimeOperation({ type: 'variant.cycle', direction: 1 }, {
          source: 'entities:actor.form.shortcut',
          tokenId: token.id,
          actorId: actor.id,
          sceneId: activeSceneId(api),
        });
      }, true);

      mapElement.addEventListener('dblclick', event => {
        if (!event.target.closest?.('.rpg-token-v2')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        queueMicrotask(() => {
          const token = selectedTokenId ? api.tokens.get?.(selectedTokenId) : null;
          if (token?.actorId) api.entities.openToken(token.id);
        });
      }, true);
      mapElement.addEventListener('click', tokenController.handleMapClick, true);

      api.on('token:select', event => {
        selectedTokenId = event.detail?.tokenId || event.detail?.id || null;
        renderAllSheets();
      });
      api.on('token:create', event => {
        renderPanel();
        renderRelatedSheets({ actorIds: [event.detail?.actorId].filter(Boolean), tokenIds: [event.detail?.tokenId || event.detail?.id].filter(Boolean) });
      });
      api.on('token:delete', event => {
        if (selectedTokenId && id(event.detail?.tokenId || event.detail?.id) === id(selectedTokenId)) selectedTokenId = null;
        renderPanel();
        renderRelatedSheets({ actorIds: [event.detail?.actorId].filter(Boolean), tokenIds: [event.detail?.tokenId || event.detail?.id].filter(Boolean) });
      });
      api.on('token:move', event => { renderPanel(); renderRelatedSheets({ actorIds: [event.detail?.actorId].filter(Boolean), tokenIds: [event.detail?.tokenId || event.detail?.id].filter(Boolean) }); });
      api.on('token:property-change', event => { renderPanel(); renderRelatedSheets({ actorIds: [event.detail?.actorId].filter(Boolean), tokenIds: [event.detail?.tokenId || event.detail?.id].filter(Boolean) }); });
      api.on('elevation:token-change', event => { renderPanel(); renderRelatedSheets({ tokenIds: [event.detail?.tokenId || event.detail?.id].filter(Boolean) }); });
      api.on('state:commit', event => {
        if (store.saving) return;
        store.load({ migrateLegacy: false, dropMarkers: false });
        renderPanel();
        if (String(event.detail?.source || '').startsWith('document.')) return;
        renderAllSheets();
      });
      api.on('state:import', () => {
        tokenController.clearPlacement({ restoreTool: false });
        if (store.saving) return;
        store.load({ migrateLegacy: false, dropMarkers: false });
        renderPanel();
        renderAllSheets();
      });
      api.on('status:change', event => {
        renderPanel();
        renderRelatedSheets({
          actorIds: [...(event.detail?.actorIds || []), event.detail?.actorId].filter(Boolean),
          tokenIds: [...(event.detail?.tokenIds || []), event.detail?.tokenId].filter(Boolean),
        });
      });
      for (const eventName of ['document:create', 'document:update', 'document:delete', 'document:move']) {
        api.on(eventName, event => {
          const address = event.detail?.document || {};
          store.applyDocumentChange(event.detail);
          if (address.type === 'Actor') renderRelatedSheets({ actorIds: [address.id] });
          if (address.type === 'Token') renderRelatedSheets({ tokenIds: [address.id] });
        });
      }
      api.on('multiplayer:capabilities', () => { renderPanel(); renderAllSheets(); });
      api.on('app:destroy', () => {
        destroyed = true;
        tokenController.destroy();
        statusUi.closeDefinitionEditor();
        statusUi.closeDetailEditor();
        closeAllSheets();
        documentNode.removeEventListener('pointerdown', activateEventSheet, true);
        mapElement.removeEventListener('click', tokenController.handleMapClick, true);
        panel.removeEventListener('click', handlePanelClick);
        panelObserver?.disconnect();
      });

      if (migration.droppedMarkers || migration.migratedCharacters
        || migration.migratedTokenLocations || migration.blockedTokenLocations) {
        setStatus(`角色系统已就绪：迁移 ${migration.migratedCharacters} 个旧角色${migration.migratedTokenLocations ? `，吸附 ${migration.migratedTokenLocations} 个棋子到 1m 格子` : ''}${migration.blockedTokenLocations ? `，${migration.blockedTokenLocations} 个棋子位于阻挡格，需 GM 重新放置` : ''}${migration.droppedMarkers ? `，移除 ${migration.droppedMarkers} 个旧标记` : ''}`);
      }
      renderPanel();
    },
  };
}
