import {
  featureBlockingHeightFt,
  formatFt,
  normalizeBlockingHeightFt,
  normalizeElevationFt,
  tokenElevationFt,
} from './model.js';
import {
  configureElevationNavigationRuntime,
  resetElevationNavigationRuntime,
  setActiveMoverContext,
} from './runtime-context.js';

const STYLE_ID = 'rpgmap-token-elevation-v2-style';
const FEATURE_EDITOR_CLASS = 'feature-elevation-editor';

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .token-elevation-hud { position:fixed; z-index:5000; width:190px; padding:10px; border:1px solid rgba(225,218,194,.25); border-radius:9px; background:rgba(28,32,35,.97); box-shadow:0 10px 28px rgba(0,0,0,.38); color:#f5f1e6; font:12px/1.4 system-ui,sans-serif; }
    .token-elevation-hud strong { display:block; margin-bottom:7px; font-size:12px; }
    .token-elevation-hud-row { display:grid; grid-template-columns:34px 1fr 34px; gap:6px; align-items:center; }
    .token-elevation-hud button,.token-elevation-hud input { box-sizing:border-box; height:30px; border:1px solid rgba(225,218,194,.26); border-radius:6px; background:#20272a; color:#f5f1e6; }
    .token-elevation-hud button { cursor:pointer; font-weight:800; }
    .token-elevation-hud input { width:100%; padding:0 6px; text-align:center; }
    .token-elevation-hud small { display:block; margin-top:6px; opacity:.68; }
    .${FEATURE_EDITOR_CLASS} { margin:12px 0; padding:10px; border:1px solid rgba(76,91,88,.18); border-radius:8px; background:rgba(242,239,226,.5); }
    .${FEATURE_EDITOR_CLASS} h3 { margin:0 0 6px; }
    .feature-elevation-summary { margin:0 0 8px; font-size:12px; opacity:.78; }
    .feature-elevation-controls { display:grid; grid-template-columns:32px minmax(70px,1fr) 32px auto; gap:6px; align-items:center; }
    .feature-elevation-controls input { min-width:0; height:30px; }
    .feature-elevation-controls button { height:30px; }
  `;
  documentNode.head.append(style);
}

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find(feature => String(feature.id) === String(featureId)) || null;
}

function currentForm(actor) {
  const forms = Array.isArray(actor?.forms) ? actor.forms : [];
  return forms.find(form => String(form?.id) === String(actor?.currentFormId)) || forms[0] || null;
}

function tokenName(api, tokenId) {
  try {
    return api.tokens?.resolveActor?.(tokenId)?.actor?.name || 'Token';
  } catch {
    return 'Token';
  }
}

function canControlToken(api, tokenId) {
  const status = api.multiplayer?.getStatus?.();
  if (!status?.connected) return true;
  if (status.session?.role === 'gm') return true;
  if (typeof api.multiplayer?.canControlToken === 'function') {
    return api.multiplayer.canControlToken(tokenId) !== false;
  }
  const token = api.tokens?.get?.(tokenId);
  return token ? api.multiplayer?.canControlActor?.(token.actorId) !== false : false;
}

function canEditFeatureHeight(api) {
  const status = api.multiplayer?.getStatus?.();
  return !status?.connected || status.session?.role === 'gm';
}

function setFeedback(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node && message) node.textContent = message;
}

function clampHudPosition(hud, event, documentNode) {
  const margin = 10;
  const viewportWidth = documentNode.defaultView?.innerWidth || 1280;
  const viewportHeight = documentNode.defaultView?.innerHeight || 720;
  const x = Number(event?.clientX) || viewportWidth / 2;
  const y = Number(event?.clientY) || viewportHeight / 2;
  hud.style.left = `${Math.max(margin, Math.min(viewportWidth - 210, x + 8))}px`;
  hud.style.top = `${Math.max(margin, Math.min(viewportHeight - 130, y + 8))}px`;
}

export function createTokenElevationSystem() {
  return {
    register(api) {
      if (!api.tokens?.get || !api.tokens?.update) throw new Error('Token Elevation V2 requires Token Runtime V2');
      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document || null;
      const shell = mapElement?.closest?.('.app-shell') || documentNode;
      if (!mapElement || !documentNode) return;
      installStyles(documentNode);
      configureElevationNavigationRuntime({ getState: () => api.getState() });

      let selectedTokenId = api.selection?.getPrimaryTokenId?.() || null;
      let tokenHud = null;
      let destroyed = false;
      const off = [];

      function syncMover(tokenId = selectedTokenId) {
        const token = tokenId ? api.tokens.get(tokenId) : null;
        setActiveMoverContext({
          tokenId: token?.id || null,
          elevationFt: token ? tokenElevationFt(token) : 0,
        });
      }

      function closeTokenHud() {
        tokenHud?.remove();
        tokenHud = null;
      }

      async function setTokenElevation(tokenId, value) {
        const token = api.tokens.get(tokenId);
        if (!token) return false;
        if (!canControlToken(api, tokenId)) {
          setFeedback(shell, '当前无法修改该 Token 高度：需要该 Actor 的 OWNER 权限，并遵守战斗回合限制。');
          return false;
        }
        const elevationFt = normalizeElevationFt(value, token.elevationFt);
        try {
          await api.tokens.update(token.id, { elevationFt }, { render: true });
        } catch (error) {
          setFeedback(shell, `Token 高度未获服务器确认：${error.message}`);
          return false;
        }
        api.movement?.cancelPending?.();
        selectedTokenId = String(token.id);
        syncMover(selectedTokenId);
        api.emit?.('elevation:token-change', { tokenId: String(token.id), elevationFt });
        setFeedback(shell, `${tokenName(api, token.id)} 高度已设为 ${formatFt(elevationFt)} ft`);
        return true;
      }

      function openTokenElevationEditor(tokenId, anchorEvent = null) {
        const token = api.tokens.get(tokenId);
        if (!token) return false;
        selectedTokenId = String(token.id);
        api.selection?.replace?.([token.id], token.id);
        api.emit?.('token:select', { id: token.id, tokenId: token.id, actorId: token.actorId });
        syncMover(token.id);
        closeTokenHud();

        const allowed = canControlToken(api, token.id);
        const hud = documentNode.createElement('div');
        hud.className = 'token-elevation-hud';
        hud.dataset.tokenId = String(token.id);
        const heading = documentNode.createElement('strong');
        const form = currentForm(api.tokens.resolveActor?.(token.id)?.actor);
        heading.textContent = `${tokenName(api, token.id)}${form?.name ? ` · ${form.name}` : ''} · Elevation`;
        const row = documentNode.createElement('div');
        row.className = 'token-elevation-hud-row';
        const down = documentNode.createElement('button'); down.type = 'button'; down.textContent = '−5';
        const input = documentNode.createElement('input');
        input.type = 'number'; input.min = '0'; input.step = '5'; input.value = String(tokenElevationFt(token));
        input.setAttribute('aria-label', 'Token elevation in feet');
        const up = documentNode.createElement('button'); up.type = 'button'; up.textContent = '+5';
        [down, input, up].forEach(control => { control.disabled = !allowed; });
        row.append(down, input, up);
        const hint = documentNode.createElement('small');
        hint.textContent = allowed ? '单位 ft' : '当前没有该 Actor 的控制权限';
        hud.append(heading, row, hint);
        documentNode.body.append(hud);
        clampHudPosition(hud, anchorEvent, documentNode);
        tokenHud = hud;

        const commit = async next => {
          if (await setTokenElevation(token.id, next)) input.value = String(tokenElevationFt(api.tokens.get(token.id)));
        };
        down.addEventListener('click', event => { event.stopPropagation(); void commit(Math.max(0, tokenElevationFt(api.tokens.get(token.id)) - 5)); });
        up.addEventListener('click', event => { event.stopPropagation(); void commit(tokenElevationFt(api.tokens.get(token.id)) + 5); });
        input.addEventListener('change', () => void commit(input.value));
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); void commit(input.value); }
          if (event.key === 'Escape') closeTokenHud();
        });
        queueMicrotask(() => { input.focus(); input.select(); });
        return true;
      }

      async function setFeatureHeight(featureId, value) {
        if (!api.interaction || !canEditFeatureHeight(api)) return false;
        const featureState = api.interaction.stateForFeature(featureId);
        const normalized = normalizeBlockingHeightFt(value);
        if (normalized === null) return false;
        try {
          await api.interaction.patchState(featureId, {
            custom: { ...(featureState?.custom || {}), blockingHeightFt: normalized },
          });
        } catch (error) {
          setFeedback(shell, `Feature 高度未获服务器确认：${error.message}`);
          return false;
        }
        api.emit?.('elevation:feature-change', { featureId: String(featureId), blockingHeightFt: normalized });
        renderFeatureEditor();
        return true;
      }

      async function resetFeatureHeight(featureId) {
        if (!api.interaction || !canEditFeatureHeight(api)) return false;
        const featureState = api.interaction.stateForFeature(featureId);
        const custom = { ...(featureState?.custom || {}) };
        delete custom.blockingHeightFt;
        try { await api.interaction.patchState(featureId, { custom }); }
        catch (error) { setFeedback(shell, `Feature 高度重置未获服务器确认：${error.message}`); return false; }
        api.emit?.('elevation:feature-change', { featureId: String(featureId), blockingHeightFt: null, reset: true });
        renderFeatureEditor();
        return true;
      }

      function renderFeatureEditor() {
        if (destroyed || !api.interaction) return;
        const panel = shell?.querySelector?.('[data-panel="inspect"]');
        if (!panel) return;
        const featureId = api.interaction.selectedFeatureId;
        const feature = featureById(api.mapPackage, featureId);
        const navigation = feature?.capabilities?.navigation || feature?.navigation;
        panel.querySelector(`.${FEATURE_EDITOR_CLASS}`)?.remove();
        if (!feature || !navigation?.blocks) return;

        const featureState = api.interaction.stateForFeature(feature.id);
        const declared = normalizeBlockingHeightFt(navigation.blockingHeightFt);
        const effective = featureBlockingHeightFt(feature, featureState);
        const hasOverride = featureState?.custom?.blockingHeightFt !== undefined
          && featureState?.custom?.blockingHeightFt !== null && featureState?.custom?.blockingHeightFt !== '';
        const allowed = canEditFeatureHeight(api);
        const editor = documentNode.createElement('div');
        editor.className = FEATURE_EDITOR_CLASS;
        editor.dataset.featureId = String(feature.id);
        const heading = documentNode.createElement('h3'); heading.textContent = '高度阻挡';
        const summary = documentNode.createElement('p'); summary.className = 'feature-elevation-summary';
        const defaultText = declared === null ? '未声明（无限高度阻挡）' : `${formatFt(declared)} ft`;
        const effectiveText = effective === null ? '无限高度' : `${formatFt(effective)} ft`;
        summary.textContent = `地图默认：${defaultText} · 当前：${effectiveText}${hasOverride ? ' · World 覆盖' : ''}`;
        const controls = documentNode.createElement('div'); controls.className = 'feature-elevation-controls';
        const down = documentNode.createElement('button'); down.type = 'button'; down.textContent = '−5';
        const input = documentNode.createElement('input'); input.type = 'number'; input.min = '0'; input.step = '5'; input.value = effective === null ? '' : String(effective);
        const up = documentNode.createElement('button'); up.type = 'button'; up.textContent = '+5';
        const reset = documentNode.createElement('button'); reset.type = 'button'; reset.className = 'small-button'; reset.textContent = '恢复地图默认';
        [down, input, up, reset].forEach(control => { control.disabled = !allowed; });
        reset.disabled = !allowed || !hasOverride;
        controls.append(down, input, up, reset);
        editor.append(heading, summary, controls);
        const actionRow = panel.querySelector('.button-row');
        if (actionRow) actionRow.before(editor); else panel.append(editor);
        input.addEventListener('change', () => void setFeatureHeight(feature.id, input.value));
        down.addEventListener('click', () => void setFeatureHeight(feature.id, Math.max(0, normalizeElevationFt(input.value, effective || 0) - 5)));
        up.addEventListener('click', () => void setFeatureHeight(feature.id, normalizeElevationFt(input.value, effective || 0) + 5));
        reset.addEventListener('click', () => void resetFeatureHeight(feature.id));
      }

      const selectionOff = api.selection?.subscribe?.(snapshot => {
        selectedTokenId = snapshot?.primaryId || null;
        syncMover();
      });
      if (selectionOff) off.push(selectionOff);
      off.push(api.on?.('token:select', event => { selectedTokenId = event.detail?.tokenId || event.detail?.id || null; syncMover(); }));
      off.push(api.on?.('token:delete', event => {
        if (String(event.detail?.tokenId ?? event.detail?.id ?? '') === String(selectedTokenId ?? '')) selectedTokenId = null;
        closeTokenHud(); syncMover();
      }));
      for (const eventName of ['feature:select', 'interaction:state-change', 'interaction:executed', 'scene:damage', 'scene:restore']) {
        off.push(api.on?.(eventName, renderFeatureEditor));
      }

      const closeOnPointerDown = event => { if (tokenHud && !tokenHud.contains(event.target)) closeTokenHud(); };
      const closeOnEscape = event => { if (event.key === 'Escape') closeTokenHud(); };
      documentNode.addEventListener('pointerdown', closeOnPointerDown, true);
      documentNode.addEventListener('keydown', closeOnEscape, true);

      api.elevation = Object.freeze({
        canonicalSceneTokens: true,
        tokenElevationFt(tokenId) { return tokenElevationFt(api.tokens.get(tokenId)); },
        featureBlockingHeightFt(featureId) {
          const feature = featureById(api.mapPackage, featureId);
          return feature ? featureBlockingHeightFt(feature, api.interaction?.stateForFeature?.(featureId)) : null;
        },
        setTokenElevationFt: setTokenElevation,
        canSetTokenElevation: tokenId => canControlToken(api, tokenId),
        openTokenElevationEditor,
        setFeatureBlockingHeightFt: setFeatureHeight,
        resetFeatureBlockingHeightFt: resetFeatureHeight,
        sync: renderFeatureEditor,
      });

      syncMover();
      renderFeatureEditor();
      api.on?.('app:destroy', () => {
        destroyed = true;
        closeTokenHud();
        documentNode.removeEventListener('pointerdown', closeOnPointerDown, true);
        documentNode.removeEventListener('keydown', closeOnEscape, true);
        off.filter(Boolean).forEach(dispose => dispose?.());
        resetElevationNavigationRuntime();
      });
    },
  };
}
