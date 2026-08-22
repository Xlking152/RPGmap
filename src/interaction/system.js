import {
  damageFeatureState,
  featureInteractionSnapshot,
  getFeatureInteractionState,
  listFeatureInteractions,
  setFeatureOpenState,
} from './model.js';

const CORE_BUTTON_CLASS = 'core-interaction-action';
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
  `;
  documentNode.head?.append(style);
}

function setFeedback(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node && message) node.textContent = message;
}

function actionResult(action, featureId, ok, reason = '') {
  return Object.freeze({ action, featureId: featureId == null ? null : String(featureId), ok: Boolean(ok), reason: String(reason || '') });
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

      const syncFeatureVisualState = () => {
        if (!shell?.querySelectorAll) return;
        const state = api.getState();
        for (const feature of api.mapPackage?.features || []) {
          const interactionState = getFeatureInteractionState(state, feature);
          for (const node of shell.querySelectorAll('[data-feature-id]')) {
            if (String(node.dataset?.featureId) !== String(feature.id)) continue;
            const openable = Boolean(feature.capabilities?.openable || feature.capabilities?.actions?.open || feature.capabilities?.actions?.close);
            node.classList.toggle('interaction-open', openable && interactionState.open);
            node.classList.toggle('interaction-closed', openable && !interactionState.open);
            if (openable) node.setAttribute('data-interaction-open', interactionState.open ? 'true' : 'false');
            else node.removeAttribute('data-interaction-open');
          }
        }
      };

      const actionsForFeature = (featureId, context = {}) => listFeatureInteractions({
        mapPackage: api.mapPackage,
        state: api.getState(),
        featureId,
        characterId: context.characterId ?? selectedCharacterId,
      });

      const snapshot = (featureId, context = {}) => featureInteractionSnapshot({
        mapPackage: api.mapPackage,
        state: api.getState(),
        featureId,
        characterId: context.characterId ?? selectedCharacterId,
      });

      const emitExecuted = (result, detail = {}) => {
        api.emit?.('interaction:executed', { ...result, ...detail });
        return result;
      };

      const execute = (action, options = {}) => {
        const featureId = options.featureId ?? selectedFeatureId;
        const state = api.getState();
        const feature = featureById(api.mapPackage, featureId);
        if (!feature) return emitExecuted(actionResult(action, featureId, false, 'Feature 不存在'));

        const characterId = options.characterId ?? selectedCharacterId;
        const available = listFeatureInteractions({ mapPackage: api.mapPackage, state, featureId: feature.id, characterId });
        const descriptor = available.find((entry) => entry.id === action);
        if (!descriptor) return emitExecuted(actionResult(action, feature.id, false, 'Feature 未声明该 Interaction Capability'));
        if (!descriptor.enabled) {
          setFeedback(shell, descriptor.reason || `${descriptor.label}当前不可用`);
          return emitExecuted(actionResult(action, feature.id, false, descriptor.reason));
        }

        try {
          if (action === 'inspect') {
            const ok = api.selectFeature?.(feature.id, { switchTab: true, focus: options.focus === true }) !== false;
            if (ok) setFeedback(shell, `检查：${feature.name || feature.id}`);
            return emitExecuted(actionResult(action, feature.id, ok), { characterId });
          }

          if (action === 'enter') {
            const entrance = feature.entrance;
            api.setTool?.('character-move');
            api.planCharacterMove?.(
              characterId,
              { x: Number(entrance[0]), y: Number(entrance[1]) },
              { type: 'building', featureId: feature.id },
            );
            setFeedback(shell, `前往进入：${feature.name || feature.id}`);
            return emitExecuted(actionResult(action, feature.id, true), { characterId });
          }

          if (action === 'exit') {
            const ok = api.exitBuilding?.(characterId) !== false;
            if (ok) setFeedback(shell, `离开：${feature.name || feature.id}`);
            return emitExecuted(actionResult(action, feature.id, ok), { characterId });
          }

          if (action === 'damage') {
            const next = damageFeatureState(state, api.mapPackage, feature.id);
            if (next === state) return emitExecuted(actionResult(action, feature.id, false, '对象当前无法继续破坏'));
            api.importState(next);
            const event = next.sceneEvents?.at?.(-1) || null;
            api.emit?.('scene:damage', event ? structuredClone(event) : null);
            setFeedback(shell, `已破坏：${feature.name || feature.id}`);
            return emitExecuted(actionResult(action, feature.id, true), { characterId, event });
          }

          if (action === 'restore') {
            const ok = api.restoreFeatures?.([feature.id]) === true;
            if (ok) setFeedback(shell, `已恢复：${feature.name || feature.id}`);
            return emitExecuted(actionResult(action, feature.id, ok, ok ? '' : '对象当前完整'), { characterId });
          }

          if (action === 'open' || action === 'close') {
            const open = action === 'open';
            const next = setFeatureOpenState(state, feature.id, open);
            api.importState(next);
            syncFeatureVisualState();
            setFeedback(shell, `${open ? '已打开' : '已关闭'}：${feature.name || feature.id}`);
            api.emit?.('interaction:state-change', { featureId: feature.id, open, characterId });
            return emitExecuted(actionResult(action, feature.id, true), { characterId, open });
          }

          return emitExecuted(actionResult(action, feature.id, false, '未知 Interaction Action'));
        } catch (error) {
          const reason = error?.message || String(error);
          setFeedback(shell, `Interaction 失败：${reason}`);
          return emitExecuted(actionResult(action, feature.id, false, reason), { characterId });
        }
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
        syncVisualState: syncFeatureVisualState,
        get selectedFeatureId() { return selectedFeatureId; },
        get selectedCharacterId() { return selectedCharacterId; },
      });
      api.interaction = interaction;

      const decorateInspectionPanel = () => {
        if (!shell?.querySelector) return;
        const panel = shell.querySelector('[data-panel="inspect"]');
        if (!panel || !selectedFeatureId) return;
        panel.querySelectorAll(`.${CORE_BUTTON_CLASS}`).forEach((node) => node.remove());
        const actions = actionsForFeature(selectedFeatureId);
        const actionRow = panel.querySelector('.button-row');
        if (!actionRow) return;

        const legacyActions = new Set(
          [...actionRow.querySelectorAll('[data-action]')].map((node) => node.dataset.action),
        );
        const shouldAdd = (action) => {
          if (action === 'inspect') return false;
          if (action === 'restore' && legacyActions.has('restore-feature')) return false;
          if (action === 'enter' && legacyActions.has('enter-building')) return false;
          return true;
        };

        for (const descriptor of actions.filter((entry) => shouldAdd(entry.id))) {
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
            execute(descriptor.id, { featureId: selectedFeatureId });
          });
          actionRow.append(button);
        }
      };

      const queueDecorate = () => queueMicrotask(() => {
        if (destroyed) return;
        syncFeatureVisualState();
        decorateInspectionPanel();
      });

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
          featureId = character?.location?.type === 'building' ? character.location.featureId : selectedFeatureId;
        }
        if (!featureId) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        execute(mapped, { featureId, characterId });
      };

      shell?.addEventListener?.('click', captureLegacyActions, true);

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
        api.on?.('state:import', queueDecorate),
        api.on?.('scene:damage', queueDecorate),
        api.on?.('scene:restore', queueDecorate),
      ].filter(Boolean);

      syncFeatureVisualState();

      api.on?.('app:destroy', () => {
        destroyed = true;
        shell?.removeEventListener?.('click', captureLegacyActions, true);
        unsubscribers.forEach((unsubscribe) => unsubscribe?.());
      });
    },
  };
}
