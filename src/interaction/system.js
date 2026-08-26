import { latLngToWorld } from '../engine/geometry.js';
import { inspectableFeaturesAtPoint } from '../engine/feature-selection.js';
import { createFeatureOperations } from './operations.js';
import {
  characterFeatureId,
  charactersInsideFeature,
  featureCategoryLabel,
  featureDetailRows,
  featureEntranceText,
  featureLocationLabel,
  featureSubtypeLabel,
} from './ui-model.js';

const CORE_BUTTON_CLASS = 'core-interaction-action';
const GENERIC_DETAIL_CLASS = 'feature-generic-details';
const GENERIC_OCCUPANTS_CLASS = 'feature-generic-occupants';
const STYLE_ID = 'rpgmap-core-interaction-style';

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find((feature) => String(feature.id) === String(featureId)) || null;
}

function characterById(state, characterId) {
  return (state?.characters || []).find((character) => String(character.id) === String(characterId)) || null;
}

function installStyles(documentNode) {
  if (!documentNode || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-feature-id].interaction-open { opacity:.68; }
    [data-feature-id].interaction-closed { opacity:1; }
    .${CORE_BUTTON_CLASS}[data-interaction-action="damage"] { border-color:rgba(170,60,50,.45); color:#9d352f; }
    .${CORE_BUTTON_CLASS}[data-interaction-action="open"],
    .${CORE_BUTTON_CLASS}[data-interaction-action="close"] { border-color:rgba(35,105,115,.38); }
    .${GENERIC_DETAIL_CLASS}, .${GENERIC_OCCUPANTS_CLASS} { margin-top:12px; }
    .feature-detail-row { display:grid; grid-template-columns:minmax(58px,auto) 1fr; gap:10px; margin-top:6px; }
    .feature-detail-row strong { font-weight:650; }
  `;
  documentNode.head?.append(style);
}

function setFeedback(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node && message) node.textContent = message;
}

function replaceDefinitionValue(panel, term, value) {
  for (const node of panel?.querySelectorAll?.('dt') || []) {
    if (node.textContent !== term) continue;
    if (node.nextElementSibling) node.nextElementSibling.textContent = value;
    return;
  }
}

function replaceCheckChipText(input, text) {
  const label = input?.closest?.('label');
  if (!label) return;
  const textNode = [...label.childNodes].find((node) => node.nodeType === 3);
  if (textNode) textNode.textContent = text;
}

function replaceText(node, from, to) {
  if (!node?.textContent?.includes(from)) return;
  node.textContent = node.textContent.replace(from, to);
}

export function createFeatureInteractionSystem() {
  return {
    register(api) {
      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document || null;
      const shell = mapElement?.closest?.('.app-shell') || documentNode;
      installStyles(documentNode);

      let selectedCharacterId = null;
      let selectedFeatureId = null;
      let destroyed = false;
      let decorateQueued = false;
      let observer = null;

      const replaceRuntimeState = async (next, context = {}) => {
        const featureId = selectedFeatureId;
        const characterId = selectedCharacterId;
        const committed = typeof api.commitAuthoritativeState === 'function'
          ? await api.commitAuthoritativeState(next, {
            source: context.source || 'feature:operation',
            reason: context.source || 'feature:operation',
            render: true,
          })
          : await api.importState(next);
        if (characterId) api.selectCharacter?.(characterId);
        if (featureId) api.selectFeature?.(featureId, { switchTab: true });
        return committed;
      };

      const operations = createFeatureOperations({
        mapPackage: api.mapPackage,
        getState: () => api.getState(),
        replaceState: replaceRuntimeState,
        selectFeature: (featureId, options = {}) => api.selectFeature?.(featureId, {
          switchTab: true,
          focus: options.focus === true,
        }) !== false,
        resolveStatus: context => api.status?.resolve?.(context) || { statuses: [], capabilities: { canInteract: true } },
        getStatusDefinitions: () => api.status?.getDefinitions?.() || [],
        applyStatusMutations: (draft, mutations, context) => api.status?.applyOperationsToState?.(draft, mutations, context),
        planFeatureEntry: async ({ feature, characterId, entrance, statusMutations }) => {
          api.setTool?.('character-move');
          const route = await api.planCharacterMove?.(
            characterId,
            { x: Number(entrance[0]), y: Number(entrance[1]) },
            // V1.4 runtime compatibility port. The generic Feature model does
            // not expose this historical location type to maps or Operations.
            {
              type: 'building', featureId: feature.id, statusMutations, featureAction: 'enter',
              statusRule: feature.capabilities?.statusRules?.enter || null,
            },
          );
          return Boolean(route);
        },
        exitFeature: ({ characterId, feature, statusMutations }) => {
          const options = {
            statusMutations,
            authoritative: true,
            source: { type: 'feature', featureId: feature.id, action: 'exit' },
          };
          if (typeof api.exitFeature === 'function') return api.exitFeature(characterId, options);
          return api.exitBuilding?.(characterId, options) !== false;
        },
        restoreFeatures: (featureIds, options) => api.restoreFeatures?.(featureIds, options) === true,
        emit: (name, detail) => api.emit?.(name, detail),
      });

      const actionPermission = (action, characterId) => {
        const capabilities = api.multiplayer?.getCapabilities?.();
        if (!capabilities || capabilities.connected === false) return { ok: true, reason: '' };
        if (['damage', 'restore', 'open', 'close'].includes(action)) {
          return capabilities.canManageStructure === true
            ? { ok: true, reason: '' }
            : { ok: false, reason: '只有 GM 可以修改 Feature 与场景结构' };
        }
        if (['enter', 'exit'].includes(action)) {
          if (!characterId) return { ok: false, reason: '请先选择角色' };
          return api.multiplayer?.canControlCharacter?.(characterId) !== false
            ? { ok: true, reason: '' }
            : { ok: false, reason: '你没有该 Actor 的 OWNER 权限，或当前不在其战斗回合' };
        }
        return { ok: true, reason: '' };
      };

      const syncFeatureVisualState = () => {
        if (!shell?.querySelectorAll) return;
        const nodesById = new Map();
        for (const node of shell.querySelectorAll('[data-feature-id]')) {
          const id = String(node.dataset?.featureId ?? '');
          if (!id) continue;
          const list = nodesById.get(id) || [];
          list.push(node);
          nodesById.set(id, list);
        }
        for (const feature of api.mapPackage?.features || []) {
          const featureState = operations.stateForFeature(feature.id);
          if (!featureState) continue;
          const openable = Boolean(
            feature.capabilities?.openable
            || feature.capabilities?.actions?.open
            || feature.capabilities?.actions?.close
          );
          for (const node of nodesById.get(String(feature.id)) || []) {
            node.classList.toggle('interaction-open', openable && featureState.open);
            node.classList.toggle('interaction-closed', openable && !featureState.open);
            node.setAttribute('data-feature-state', featureState.status);
            node.setAttribute('data-feature-damaged', featureState.damaged ? 'true' : 'false');
            if (openable) node.setAttribute('data-interaction-open', featureState.open ? 'true' : 'false');
            else node.removeAttribute('data-interaction-open');
          }
        }
      };

      const actionsForFeature = (featureId, context = {}) => {
        const characterId = context.characterId ?? selectedCharacterId;
        return operations.actionsForFeature(featureId, { characterId }).map(descriptor => {
          const permission = actionPermission(descriptor.id, characterId);
          if (descriptor.enabled && !permission.ok) {
            return Object.freeze({ ...descriptor, enabled: false, reason: permission.reason });
          }
          return descriptor;
        });
      };

      const snapshot = (featureId, context = {}) => operations.snapshot(featureId, {
        characterId: context.characterId ?? selectedCharacterId,
      });

      const execute = async (action, options = {}) => {
        const featureId = options.featureId ?? selectedFeatureId;
        const characterId = options.characterId ?? selectedCharacterId;
        const permission = actionPermission(action, characterId);
        if (!permission.ok) {
          const denied = Object.freeze({ action, featureId, characterId, ok: false, reason: permission.reason });
          setFeedback(shell, permission.reason);
          api.emit?.('interaction:executed', denied);
          return denied;
        }
        const execution = await operations.execute(action, { ...options, featureId, characterId });
        if (execution.ok && execution.message) setFeedback(shell, execution.message);
        else if (!execution.ok && execution.reason) setFeedback(shell, execution.reason);
        syncFeatureVisualState();
        api.emit?.('interaction:executed', execution);
        return execution;
      };

      const interaction = Object.freeze({
        actionsForFeature,
        execute,
        inspect(featureId, options = {}) { return execute('inspect', { ...options, featureId }); },
        enter(featureId, characterId = selectedCharacterId) { return execute('enter', { featureId, characterId }); },
        exit(featureId, characterId = selectedCharacterId) { return execute('exit', { featureId, characterId }); },
        damage(featureId) { return execute('damage', { featureId }); },
        restore(featureId) { return execute('restore', { featureId }); },
        open(featureId) { return execute('open', { featureId }); },
        close(featureId) { return execute('close', { featureId }); },
        snapshot,
        stateForFeature(featureId) { return operations.stateForFeature(featureId); },
        async patchState(featureId, patch) {
          const featureState = await operations.patchState(featureId, patch);
          syncFeatureVisualState();
          return featureState;
        },
        syncVisualState: syncFeatureVisualState,
        get selectedFeatureId() { return selectedFeatureId; },
        get selectedCharacterId() { return selectedCharacterId; },
      });
      api.interaction = interaction;

      const createActionButton = (descriptor, featureId, characterId = selectedCharacterId) => {
        const button = documentNode.createElement('button');
        button.type = 'button';
        button.className = `small-button ${CORE_BUTTON_CLASS}`;
        button.dataset.interactionAction = descriptor.id;
        button.textContent = descriptor.label;
        button.disabled = !descriptor.enabled;
        if (descriptor.reason) button.title = descriptor.reason;
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          button.disabled = true;
          void execute(descriptor.id, { featureId, characterId }).finally(() => { button.disabled = !descriptor.enabled; });
        });
        return button;
      };

      const decorateInspectionPanel = () => {
        const panel = shell?.querySelector?.('[data-panel="inspect"]');
        if (!panel) return;

        panel.querySelectorAll(`.${CORE_BUTTON_CLASS}, .${GENERIC_DETAIL_CLASS}, .${GENERIC_OCCUPANTS_CLASS}`)
          .forEach((node) => node.remove());
        panel.querySelectorAll('.building-narrative, .building-occupants').forEach((node) => node.remove());

        if (!selectedFeatureId) {
          const prompt = panel.querySelector('.section p');
          if (prompt) prompt.textContent = '启用检查工具后，点击任何声明 inspect Capability 的地图 Feature；重叠时会优先选择更重要、更精确的对象。';
          return;
        }

        const feature = featureById(api.mapPackage, selectedFeatureId);
        if (!feature) return;
        replaceDefinitionValue(panel, '类别', featureCategoryLabel(api.mapPackage, feature));
        replaceDefinitionValue(panel, '地物类型', featureSubtypeLabel(api.mapPackage, feature));

        const actionRow = panel.querySelector('.button-row');
        if (!actionRow) return;
        actionRow.querySelectorAll('[data-action="restore-feature"], [data-action="enter-building"]')
          .forEach((node) => node.remove());

        const detailRows = [...featureDetailRows(api.mapPackage, feature)];
        const entrance = featureEntranceText(feature);
        if (entrance) detailRows.push({ key: 'entrance', label: '入口', value: entrance });
        if (detailRows.length) {
          const details = documentNode.createElement('div');
          details.className = GENERIC_DETAIL_CLASS;
          const heading = documentNode.createElement('h3');
          heading.textContent = 'Feature 详情';
          details.append(heading);
          detailRows.forEach((row) => {
            const item = documentNode.createElement('div');
            item.className = 'feature-detail-row';
            const label = documentNode.createElement('strong');
            const value = documentNode.createElement('span');
            label.textContent = row.label;
            value.textContent = row.value;
            item.append(label, value);
            details.append(item);
          });
          actionRow.before(details);
        }

        const occupants = charactersInsideFeature(api.getState(), feature.id);
        if (feature.capabilities?.enterable || occupants.length) {
          const occupantSection = documentNode.createElement('div');
          occupantSection.className = GENERIC_OCCUPANTS_CLASS;
          const heading = documentNode.createElement('h3');
          heading.textContent = `内部角色 · ${occupants.length}`;
          occupantSection.append(heading);
          if (!occupants.length) {
            const empty = documentNode.createElement('div');
            empty.className = 'empty-state compact';
            empty.textContent = '当前无人';
            occupantSection.append(empty);
          }
          occupants.forEach((character) => {
            const button = documentNode.createElement('button');
            button.type = 'button';
            button.className = 'occupant-button';
            button.dataset.action = 'select-character';
            button.dataset.id = character.id;
            button.textContent = character.name;
            occupantSection.append(button);
          });
          actionRow.before(occupantSection);
        }

        const actions = actionsForFeature(feature.id);
        for (const descriptor of actions.filter((entry) => entry.id !== 'inspect')) {
          actionRow.append(createActionButton(descriptor, feature.id));
        }
      };

      const decorateCharacterPanel = () => {
        const panel = shell?.querySelector?.('[data-panel="characters"]');
        if (!panel) return;

        const calculatingCopy = [...panel.querySelectorAll('.move-preview-card p')]
          .find((node) => node.textContent === '正在避开建筑、城墙、水域与弹坑。');
        if (calculatingCopy) calculatingCopy.textContent = '正在避开不可通行地物、水域与弹坑。';

        panel.querySelectorAll('[data-action="exit-building"]').forEach((legacyButton) => {
          const characterId = legacyButton.dataset.id || selectedCharacterId;
          const character = characterById(api.getState(), characterId);
          const featureId = characterFeatureId(character);
          if (!featureId) return;
          const feature = featureById(api.mapPackage, featureId);
          const section = legacyButton.closest('.section');
          const heading = section?.querySelector('h2');
          const location = section?.querySelector('p');
          if (heading) heading.textContent = 'Feature 内';
          if (location) location.textContent = featureLocationLabel(character, api.mapPackage) || `位于：${feature?.name || featureId}`;

          const descriptor = actionsForFeature(featureId, { characterId })
            .find((entry) => entry.id === 'exit');
          if (!descriptor) {
            legacyButton.remove();
            return;
          }
          legacyButton.replaceWith(createActionButton(descriptor, featureId, characterId));
        });
      };

      const decorateAreaPanel = () => {
        const panel = shell?.querySelector?.('[data-panel="areas"]');
        if (!panel) return;
        panel.querySelectorAll('[data-role="damage-category"]').forEach((input) => {
          replaceCheckChipText(input, featureCategoryLabel(api.mapPackage, input.value));
        });
        panel.querySelectorAll('.preview-target-button[data-id]').forEach((button) => {
          const feature = featureById(api.mapPackage, button.dataset.id);
          const meta = button.querySelector('.preview-target-meta');
          if (feature && meta) meta.textContent = featureCategoryLabel(api.mapPackage, feature);
        });
      };

      const normalizeLegacyCopy = () => {
        const status = shell?.querySelector?.('[data-role="map-status"]');
        replaceText(status, '检查地物：点击建筑、城墙、城门、树木或桥梁', '检查地物：点击可检查 Feature');
        replaceText(status, '角色已进入建筑', '角色已进入 Feature');

        for (const toast of shell?.querySelectorAll?.('.toast') || []) {
          if (toast.querySelector('button')) continue;
          replaceText(toast, '路径中的一段被建筑、城墙、水域或弹坑阻挡', '路径中的一段被不可通行地物、水域或弹坑阻挡');
          replaceText(toast, '建筑附近没有可用安全位置', 'Feature 附近没有可用安全位置');
          replaceText(toast, '已离开建筑', '已离开 Feature');
        }

        for (const message of shell?.querySelectorAll?.('[data-role="modal-root"] .modal p') || []) {
          if (!message.textContent.includes('恢复所有被破坏的建筑、城墙、植被、桥梁和地表')) continue;
          message.textContent = '这会恢复所有被破坏的 Feature，并永久清空全部破坏与恢复记录。此操作不可撤销；已保存的攻击范围和标记不会被删除。';
        }
      };

      const observePanels = () => {
        if (!observer) return;
        const targets = [
          shell?.querySelector?.('[data-panel="inspect"]'),
          shell?.querySelector?.('[data-panel="characters"]'),
          shell?.querySelector?.('[data-panel="areas"]'),
          shell?.querySelector?.('[data-role="map-status"]'),
          shell?.querySelector?.('[data-role="toasts"]'),
          shell?.querySelector?.('[data-role="modal-root"]'),
        ].filter(Boolean);
        targets.forEach((target) => observer.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
        }));
      };

      const decorate = () => {
        if (destroyed) return;
        observer?.disconnect();
        syncFeatureVisualState();
        decorateInspectionPanel();
        decorateCharacterPanel();
        decorateAreaPanel();
        normalizeLegacyCopy();
        observePanels();
      };

      const queueDecorate = () => {
        if (decorateQueued || destroyed) return;
        decorateQueued = true;
        queueMicrotask(() => {
          decorateQueued = false;
          decorate();
        });
      };

      const ejectDestroyedFeatureOccupants = () => {
        const state = api.getState();
        for (const character of state.characters || []) {
          const featureId = characterFeatureId(character);
          if (!featureId) continue;
          const feature = featureById(api.mapPackage, featureId);
          if (!feature?.capabilities?.enterable) continue;
          if (!operations.stateForFeature(featureId)?.destroyed) continue;
          operations.exit(featureId, character.id);
        }
      };

      // V1.4.1 compatibility names are captured only at this adapter boundary.
      // Maps and Feature Operations never need to know these historical actions.
      const captureLegacyActions = (event) => {
        const button = event.target?.closest?.('[data-action]');
        if (!button) return;
        const legacyAction = button.dataset.action;
        const mapped = legacyAction === 'restore-feature'
          ? 'restore'
          : legacyAction === 'enter-building'
            ? 'enter'
            : legacyAction === 'exit-building'
              ? 'exit'
              : null;
        if (!mapped) return;

        let featureId = button.dataset.id || selectedFeatureId;
        let characterId = selectedCharacterId;
        if (mapped === 'exit') {
          characterId = button.dataset.id || selectedCharacterId;
          const character = characterById(api.getState(), characterId);
          featureId = characterFeatureId(character) || selectedFeatureId;
        }
        if (!featureId) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void execute(mapped, { featureId, characterId });
      };

      const genericPanInspect = (event) => {
        const activeTool = shell?.querySelector?.('[data-tool].active')?.dataset?.tool;
        if (activeTool !== 'pan') return;
        const point = latLngToWorld(event.latlng, api.mapPackage.height);
        const feature = inspectableFeaturesAtPoint(point, api.mapPackage.features || [])[0];
        if (!feature || String(feature.id) === String(selectedFeatureId)) return;
        api.selectFeature?.(feature.id);
      };

      shell?.addEventListener?.('click', captureLegacyActions, true);
      api.map?.on?.('click', genericPanInspect);

      const unsubscribers = [
        api.on?.('character:select', (event) => {
          selectedCharacterId = event.detail?.id || null;
          queueDecorate();
        }),
        api.on?.('feature:select', (event) => {
          selectedFeatureId = event.detail?.id || null;
          if (selectedFeatureId) {
            const current = snapshot(selectedFeatureId);
            api.emit?.('interaction:inspect', current);
          }
          queueDecorate();
        }),
        api.on?.('state:import', () => {
          selectedCharacterId = null;
          selectedFeatureId = null;
          ejectDestroyedFeatureOccupants();
          queueDecorate();
        }),
        api.on?.('scene:damage', () => {
          ejectDestroyedFeatureOccupants();
          queueDecorate();
        }),
        api.on?.('scene:restore', queueDecorate),
        api.on?.('character:move', queueDecorate),
        api.on?.('character:eject', queueDecorate),
        api.on?.('status:change', queueDecorate),
        api.on?.('multiplayer:capabilities', queueDecorate),
      ].filter(Boolean);

      if (globalThis.MutationObserver && shell?.querySelector) {
        observer = new globalThis.MutationObserver(queueDecorate);
      }
      ejectDestroyedFeatureOccupants();
      decorate();

      api.on?.('app:destroy', () => {
        destroyed = true;
        observer?.disconnect();
        shell?.removeEventListener?.('click', captureLegacyActions, true);
        api.map?.off?.('click', genericPanInspect);
        unsubscribers.forEach((unsubscribe) => unsubscribe?.());
      });
    },
  };
}
