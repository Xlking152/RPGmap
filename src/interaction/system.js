import { createFeatureOperations } from './operations.js';

const CORE_BUTTON_CLASS = 'core-interaction-action';
const STYLE_ID = 'rpgmap-core-interaction-style';

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find((feature) => String(feature.id) === String(featureId)) || null;
}

function characterById(state, characterId) {
  return (state?.characters || []).find((character) => String(character.id) === String(characterId)) || null;
}

function characterFeatureId(character) {
  const type = character?.location?.type;
  if (type !== 'feature' && type !== 'building') return null;
  return character.location.featureId == null ? null : String(character.location.featureId);
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

      const operations = createFeatureOperations({
        mapPackage: api.mapPackage,
        getState: () => api.getState(),
        replaceState: (next) => api.importState(next),
        selectFeature: (featureId, options = {}) => api.selectFeature?.(featureId, {
          switchTab: true,
          focus: options.focus === true,
        }) !== false,
        planFeatureEntry: ({ feature, characterId, entrance }) => {
          api.setTool?.('character-move');
          api.planCharacterMove?.(
            characterId,
            { x: Number(entrance[0]), y: Number(entrance[1]) },
            // V1.4 runtime compatibility port. Feature Operations itself has no
            // knowledge of the legacy "building" location representation.
            { type: 'building', featureId: feature.id },
          );
          return true;
        },
        exitFeature: ({ characterId }) => {
          if (typeof api.exitFeature === 'function') return api.exitFeature(characterId);
          return api.exitBuilding?.(characterId) !== false;
        },
        restoreFeatures: (featureIds) => api.restoreFeatures?.(featureIds) === true,
        emit: (name, detail) => api.emit?.(name, detail),
      });

      const syncFeatureVisualState = () => {
        if (!shell?.querySelectorAll) return;
        for (const feature of api.mapPackage?.features || []) {
          const featureState = operations.stateForFeature(feature.id);
          if (!featureState) continue;
          for (const node of shell.querySelectorAll('[data-feature-id]')) {
            if (String(node.dataset?.featureId) !== String(feature.id)) continue;
            const openable = Boolean(feature.capabilities?.openable || feature.capabilities?.actions?.open || feature.capabilities?.actions?.close);
            node.classList.toggle('interaction-open', openable && featureState.open);
            node.classList.toggle('interaction-closed', openable && !featureState.open);
            node.setAttribute('data-feature-state', featureState.status);
            node.setAttribute('data-feature-damaged', featureState.damaged ? 'true' : 'false');
            if (openable) node.setAttribute('data-interaction-open', featureState.open ? 'true' : 'false');
            else node.removeAttribute('data-interaction-open');
          }
        }
      };

      const actionsForFeature = (featureId, context = {}) => operations.actionsForFeature(featureId, {
        characterId: context.characterId ?? selectedCharacterId,
      });

      const snapshot = (featureId, context = {}) => operations.snapshot(featureId, {
        characterId: context.characterId ?? selectedCharacterId,
      });

      const execute = (action, options = {}) => {
        const featureId = options.featureId ?? selectedFeatureId;
        const characterId = options.characterId ?? selectedCharacterId;
        const execution = operations.execute(action, { ...options, featureId, characterId });
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
        patchState(featureId, patch) {
          const featureState = operations.patchState(featureId, patch);
          syncFeatureVisualState();
          return featureState;
        },
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

      // V1.4.1 still renders several historical button/action names. Capture
      // them at the Runtime adapter boundary and route them through the generic
      // Feature Operations service instead of letting legacy UI own the rules.
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
