import { latLngToWorld } from '../engine/geometry.js';
import { inspectableFeaturesAtPoint } from '../engine/feature-selection.js';
import { createFeatureOperations } from './operations.js';
import {
  featureCategoryLabel,
  featureDetailRows,
  featureEntranceText,
  featureSubtypeLabel,
  tokensInsideFeature,
} from './ui-model.js';
import { describeActor } from '../actor/index.js';

const CORE_BUTTON_CLASS = 'core-interaction-action';
const STYLE_ID = 'rpgmap-core-interaction-style';

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find(feature => String(feature.id) === String(featureId)) || null;
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
    .feature-generic-details, .feature-generic-occupants { margin-top:12px; }
    .feature-detail-row { display:grid; grid-template-columns:minmax(58px,auto) 1fr; gap:10px; margin-top:6px; }
    .feature-detail-row strong { font-weight:650; }
    .feature-token-copy { display:flex; flex-direction:column; min-width:0; }
    .feature-token-copy small { color:#6e7b7d; }
  `;
  documentNode.head?.append(style);
}

function setFeedback(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node && message) node.textContent = message;
}

function createElement(documentNode, tag, className = '', text = null) {
  const node = documentNode.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function tokenDisplay(api, token) {
  try {
    const resolved = api.tokens.resolveActor(token.id);
    const actor = resolved.actor;
    const presentation = describeActor(actor, { ruleset: api.ruleset }) || {};
    return {
      name: String(presentation.name || actor?.name || token.id),
      avatarDataUrl: presentation.avatarDataUrl || null,
      color: presentation.color || '#3d9b63',
      synthetic: resolved.synthetic === true,
    };
  } catch {
    return { name: String(token.id), avatarDataUrl: null, color: '#3d9b63', synthetic: false };
  }
}

function portrait(documentNode, view) {
  const node = createElement(documentNode, 'span', 'token-portrait small');
  node.style.setProperty('--token-color', view.color || '#3d9b63');
  if (view.avatarDataUrl) {
    const image = documentNode.createElement('img');
    image.src = view.avatarDataUrl;
    image.alt = '';
    node.append(image);
  } else {
    node.textContent = (Array.from(String(view.name || '?').trim())[0] || '?').toUpperCase();
  }
  return node;
}

export function createFeatureInteractionSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.tokens?.list || !api?.tokens?.resolveActor || !api?.movement?.canonicalSceneTokens) {
        throw new Error('Feature Interaction V2 requires canonical Token and Movement runtimes');
      }
      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document || null;
      const shell = mapElement?.closest?.('.app-shell') || documentNode;
      const panel = api.uiPanels?.get?.('inspect') || shell?.querySelector?.('[data-panel="inspect"]');
      installStyles(documentNode);

      let selectedFeatureId = null;
      let destroyed = false;
      const off = [];

      const selectedTokenId = () => api.selection?.getPrimaryTokenId?.() || null;

      const replaceRuntimeState = async (next, context = {}) => {
        const featureId = selectedFeatureId;
        const committed = typeof api.commitAuthoritativeState === 'function'
          ? await api.commitAuthoritativeState(next, {
            source: context.source || 'feature:operation',
            reason: context.source || 'feature:operation',
            render: true,
          })
          : await api.importState(next);
        if (featureId) api.selectFeature?.(featureId, { switchTab: true });
        return committed;
      };

      const operations = createFeatureOperations({
        mapPackage: api.mapPackage,
        getState: () => api.getState(),
        replaceState: replaceRuntimeState,
        performOperations: (worldOperations, options = {}) => api.world.performOperations(worldOperations, options),
        selectFeature: (featureId, options = {}) => api.selectFeature?.(featureId, {
          switchTab: true,
          focus: options.focus === true,
        }) !== false,
        resolveStatus: context => api.status?.resolve?.(context) || { statuses: [], capabilities: { canInteract: true } },
        getStatusDefinitions: () => api.status?.getDefinitions?.() || [],
        applyStatusMutations: (draft, mutations, context) => api.status?.applyOperationsToState?.(draft, mutations, context),
        planFeatureEntry: async ({ feature, tokenId, entrance, statusMutations }) => {
          const route = await api.movement.planTokenMove(
            tokenId,
            { x: Number(entrance[0]), y: Number(entrance[1]) },
            {
              type: 'feature',
              featureId: feature.id,
              statusMutations,
              featureAction: 'enter',
              statusRule: feature.capabilities?.statusRules?.enter || null,
            },
          );
          // Feature entry is an explicit button action, not a drag preview. The
          // destination has already been checked by Movement Runtime, so commit
          // the prepared plan immediately through the same authoritative path.
          return route ? api.movement.commitTokenMove() : false;
        },
        exitFeature: ({ tokenId, feature, statusMutations }) => api.movement.exitFeature(tokenId, {
          statusMutations,
          authoritative: true,
          source: { type: 'feature', featureId: feature.id, action: 'exit' },
        }),
        restoreFeatures: (featureIds, options) => api.restoreFeatures?.(featureIds, options) === true,
        emit: (name, detail) => api.emit?.(name, detail),
      });

      function actionPermission(action, tokenId) {
        const capabilities = api.multiplayer?.getCapabilities?.();
        if (!capabilities || capabilities.connected === false) return { ok: true, reason: '' };
        if (['damage', 'restore', 'open', 'close'].includes(action)) {
          return capabilities.canManageStructure === true
            ? { ok: true, reason: '' }
            : { ok: false, reason: '只有 GM 可以修改 Feature 与场景结构' };
        }
        if (['enter', 'exit'].includes(action)) {
          if (!tokenId) return { ok: false, reason: '请先选择 Token' };
          const token = api.tokens.get?.(tokenId);
          if (!token) return { ok: false, reason: 'Token 不存在' };
          const allowed = api.permissions?.can
            ? api.permissions.can('token.move', { token, tokenId: token.id })
            : api.multiplayer?.canControlToken?.(token.id) !== false;
          return allowed
            ? { ok: true, reason: '' }
            : { ok: false, reason: '当前 Token 没有移动权限，或受到锁定、状态、战斗回合限制' };
        }
        return { ok: true, reason: '' };
      }

      function syncFeatureVisualState() {
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
          const openable = Boolean(feature.capabilities?.openable
            || feature.capabilities?.actions?.open || feature.capabilities?.actions?.close);
          for (const node of nodesById.get(String(feature.id)) || []) {
            node.classList.toggle('interaction-open', openable && featureState.open);
            node.classList.toggle('interaction-closed', openable && !featureState.open);
            node.setAttribute('data-feature-state', featureState.status);
            node.setAttribute('data-feature-damaged', featureState.damaged ? 'true' : 'false');
            if (openable) node.setAttribute('data-interaction-open', featureState.open ? 'true' : 'false');
            else node.removeAttribute('data-interaction-open');
          }
        }
      }

      function actionsForFeature(featureId, context = {}) {
        const tokenId = context.tokenId ?? selectedTokenId();
        return operations.actionsForFeature(featureId, { tokenId }).map(descriptor => {
          const permission = actionPermission(descriptor.id, tokenId);
          return descriptor.enabled && !permission.ok
            ? Object.freeze({ ...descriptor, enabled: false, reason: permission.reason })
            : descriptor;
        });
      }

      function snapshot(featureId, context = {}) {
        return operations.snapshot(featureId, { tokenId: context.tokenId ?? selectedTokenId() });
      }

      async function execute(action, options = {}) {
        const featureId = options.featureId ?? selectedFeatureId;
        const tokenId = options.tokenId ?? selectedTokenId();
        const permission = actionPermission(action, tokenId);
        if (!permission.ok) {
          const denied = Object.freeze({ action, featureId, tokenId, ok: false, reason: permission.reason });
          setFeedback(shell, permission.reason);
          api.emit?.('interaction:executed', denied);
          return denied;
        }
        const execution = await operations.execute(action, { ...options, featureId, tokenId });
        if (execution.ok && execution.message) setFeedback(shell, execution.message);
        else if (!execution.ok && execution.reason) setFeedback(shell, execution.reason);
        syncFeatureVisualState();
        renderInspection();
        api.emit?.('interaction:executed', execution);
        return execution;
      }

      function createActionButton(descriptor, featureId) {
        const button = createElement(documentNode, 'button', `small-button ${CORE_BUTTON_CLASS}`, descriptor.label);
        button.type = 'button';
        button.dataset.interactionAction = descriptor.id;
        button.disabled = !descriptor.enabled;
        if (descriptor.reason) button.title = descriptor.reason;
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          button.disabled = true;
          void execute(descriptor.id, { featureId }).finally(renderInspection);
        });
        return button;
      }

      function renderInspection() {
        if (!panel || destroyed) return;
        panel.replaceChildren();
        const section = createElement(documentNode, 'div', 'section');
        section.append(createElement(documentNode, 'h2', '', 'Feature 检查'));
        if (!selectedFeatureId) {
          section.append(createElement(documentNode, 'p', '', '启用检查工具后，点击任何声明 inspect Capability 的地图 Feature。'));
          const enable = createElement(documentNode, 'button', 'small-button primary', '启用检查工具');
          enable.type = 'button';
          enable.addEventListener('click', () => api.setTool?.('inspect'));
          section.append(enable);
          panel.append(section);
          return;
        }

        const feature = featureById(api.mapPackage, selectedFeatureId);
        if (!feature) return;
        const featureState = operations.stateForFeature(feature.id);
        const heading = createElement(documentNode, 'div', 'feature-heading');
        heading.append(
          createElement(documentNode, 'div', 'feature-name', feature.name || feature.id),
          createElement(documentNode, 'span', `feature-status ${featureState?.status || 'intact'}`, featureState?.status || 'intact'),
        );
        section.append(heading);

        const details = createElement(documentNode, 'dl', 'feature-details');
        const center = Array.isArray(feature.center) ? feature.center : [0, 0];
        const rows = [
          ['类别', featureCategoryLabel(api.mapPackage, feature)],
          ['地物类型', featureSubtypeLabel(api.mapPackage, feature)],
          ['对象 ID', feature.id],
          ['中心坐标', `x ${Number(center[0]).toFixed(1)} · y ${Number(center[1]).toFixed(1)}`],
        ];
        for (const [term, value] of rows) {
          details.append(createElement(documentNode, 'dt', '', term), createElement(documentNode, 'dd', '', value));
        }
        section.append(details);

        const extraRows = [...featureDetailRows(api.mapPackage, feature)];
        const entranceText = featureEntranceText(feature);
        if (entranceText) extraRows.push({ label: '入口', value: entranceText });
        if (extraRows.length) {
          const extra = createElement(documentNode, 'div', 'feature-generic-details');
          extra.append(createElement(documentNode, 'h3', '', 'Feature 详情'));
          for (const row of extraRows) {
            const item = createElement(documentNode, 'div', 'feature-detail-row');
            item.append(createElement(documentNode, 'strong', '', row.label), createElement(documentNode, 'span', '', row.value));
            extra.append(item);
          }
          section.append(extra);
        }

        const occupants = tokensInsideFeature(api.tokens.list(), feature.id);
        if (feature.capabilities?.enterable || occupants.length) {
          const occupantSection = createElement(documentNode, 'div', 'feature-generic-occupants');
          occupantSection.dataset.occupantSource = 'api.tokens.list+resolveActor';
          occupantSection.append(createElement(documentNode, 'h3', '', `内部 Token · ${occupants.length}`));
          if (!occupants.length) occupantSection.append(createElement(documentNode, 'div', 'empty-state compact', '当前无人'));
          for (const token of occupants) {
            const view = tokenDisplay(api, token);
            const button = createElement(documentNode, 'button', 'occupant-button');
            button.type = 'button';
            button.dataset.tokenId = token.id;
            button.title = view.synthetic ? '独立角色实例' : '共享角色棋子';
            const copy = createElement(documentNode, 'span', 'feature-token-copy');
            copy.append(createElement(documentNode, 'span', '', view.name));
            if (view.synthetic) copy.append(createElement(documentNode, 'small', '', '独立实例'));
            button.append(portrait(documentNode, view), copy);
            button.addEventListener('click', () => api.selection?.replace?.([token.id], token.id));
            occupantSection.append(button);
          }
          section.append(occupantSection);
        }

        const actions = createElement(documentNode, 'div', 'button-row');
        const focus = createElement(documentNode, 'button', 'small-button primary', '定位对象');
        focus.type = 'button';
        focus.addEventListener('click', () => api.focusFeature?.(feature.id));
        actions.append(focus);
        for (const descriptor of actionsForFeature(feature.id).filter(entry => entry.id !== 'inspect')) {
          actions.append(createActionButton(descriptor, feature.id));
        }
        section.append(actions);
        panel.append(section);
      }

      async function ejectDestroyedFeatureOccupants() {
        for (const token of api.tokens.list()) {
          if (token.placement !== 'feature' || !token.featureId) continue;
          const feature = featureById(api.mapPackage, token.featureId);
          if (!feature?.capabilities?.enterable) continue;
          if (!operations.stateForFeature(feature.id)?.destroyed) continue;
          await api.movement.exitFeature(token.id);
          api.emit?.('token:eject', { tokenId: token.id, id: token.id, featureId: feature.id });
        }
      }

      const interaction = Object.freeze({
        tokenFirst: true,
        actionsForFeature,
        execute,
        inspect(featureId, options = {}) { return execute('inspect', { ...options, featureId }); },
        enter(featureId, tokenId = selectedTokenId()) { return execute('enter', { featureId, tokenId }); },
        exit(featureId, tokenId = selectedTokenId()) { return execute('exit', { featureId, tokenId }); },
        damage(featureId) { return execute('damage', { featureId }); },
        restore(featureId) { return execute('restore', { featureId }); },
        open(featureId) { return execute('open', { featureId }); },
        close(featureId) { return execute('close', { featureId }); },
        snapshot,
        stateForFeature(featureId) { return operations.stateForFeature(featureId); },
        async patchState(featureId, patch) {
          const state = await operations.patchState(featureId, patch);
          syncFeatureVisualState();
          renderInspection();
          return state;
        },
        syncVisualState: syncFeatureVisualState,
        get selectedFeatureId() { return selectedFeatureId; },
        get selectedTokenId() { return selectedTokenId(); },
      });
      api.interaction = interaction;

      const genericPanInspect = event => {
        const activeTool = shell?.querySelector?.('[data-tool].active')?.dataset?.tool;
        if (activeTool !== 'pan') return;
        const point = latLngToWorld(event.latlng, api.mapPackage.height);
        const feature = inspectableFeaturesAtPoint(point, api.mapPackage.features || [])[0];
        if (!feature || String(feature.id) === String(selectedFeatureId)) return;
        api.selectFeature?.(feature.id);
      };
      api.map?.on?.('click', genericPanInspect);

      off.push(api.on?.('feature:select', event => {
        selectedFeatureId = event.detail?.id || null;
        if (selectedFeatureId) api.emit?.('interaction:inspect', snapshot(selectedFeatureId));
        renderInspection();
      }));
      off.push(api.selection?.subscribe?.(() => renderInspection()));
      for (const eventName of [
        'state:import', 'state:commit', 'scene:restore', 'token:create', 'token:delete',
        'token:move', 'token:property-change', 'status:change', 'feature:state-change', 'multiplayer:capabilities',
      ]) off.push(api.on?.(eventName, () => { syncFeatureVisualState(); renderInspection(); }));
      off.push(api.on?.('scene:damage', () => {
        void ejectDestroyedFeatureOccupants().finally(() => { syncFeatureVisualState(); renderInspection(); });
      }));
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        api.map?.off?.('click', genericPanInspect);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      syncFeatureVisualState();
      renderInspection();
      void ejectDestroyedFeatureOccupants();
      api.emit?.('interaction:token-first-ready', { canonicalSceneTokens: true });
    },
  });
}
