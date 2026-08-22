import { latLngToWorld } from '../engine/geometry.js';
import { resolveActor } from '../entities/resolver.js';
import {
  actorForCharacter,
  featureBlockingHeightFt,
  formatFt,
  normalizeBlockingHeightFt,
  normalizeElevationFt,
  tokenElevationFt,
  tokenForCharacter,
} from './model.js';
import {
  configureElevationNavigationRuntime,
  resetElevationNavigationRuntime,
  setActiveMoverContext,
  withActiveMoverContext,
} from './runtime-context.js';

const STYLE_ID = 'rpgmap-elevation-style';
const FEATURE_EDITOR_CLASS = 'feature-elevation-editor';

function installStyles(documentNode) {
  if (!documentNode || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpg-character { overflow:visible !important; }
    .token-elevation-label { position:absolute; left:50%; bottom:calc(100% + 4px); transform:translateX(-50%); min-width:30px; padding:1px 5px; border:1px solid rgba(18,24,28,.78); border-radius:5px; background:rgba(24,30,34,.88); color:#f4f0df; box-shadow:0 1px 4px rgba(0,0,0,.28); font:700 10px/1.35 system-ui,sans-serif; text-align:center; white-space:nowrap; pointer-events:none; }
    .token-hp-meter { position:absolute; left:50%; top:calc(100% + 4px); transform:translateX(-50%); width:38px; height:5px; overflow:hidden; border:1px solid rgba(18,24,28,.82); border-radius:4px; background:rgba(18,24,28,.7); box-shadow:0 1px 3px rgba(0,0,0,.28); pointer-events:none; }
    .token-hp-fill { display:block; height:100%; width:0; background:#51a866; transition:width .16s ease; }
    .token-hp-meter[data-hp-state="warn"] .token-hp-fill { background:#c58a38; }
    .token-hp-meter[data-hp-state="low"] .token-hp-fill { background:#b8483f; }
    .token-elevation-hud { position:fixed; z-index:5000; width:190px; padding:10px; border:1px solid rgba(225,218,194,.25); border-radius:9px; background:rgba(28,32,35,.97); box-shadow:0 10px 28px rgba(0,0,0,.38); color:#f5f1e6; font:12px/1.4 system-ui,sans-serif; }
    .token-elevation-hud strong { display:block; margin-bottom:7px; font-size:12px; }
    .token-elevation-hud-row { display:grid; grid-template-columns:34px 1fr 34px; gap:6px; align-items:center; }
    .token-elevation-hud button, .token-elevation-hud input { box-sizing:border-box; height:30px; border:1px solid rgba(225,218,194,.26); border-radius:6px; background:#20272a; color:#f5f1e6; }
    .token-elevation-hud button { cursor:pointer; font-weight:800; }
    .token-elevation-hud input { width:100%; padding:0 6px; text-align:center; }
    .token-elevation-hud small { display:block; margin-top:6px; opacity:.68; }
    .${FEATURE_EDITOR_CLASS} { margin:12px 0; padding:10px; border:1px solid rgba(76,91,88,.18); border-radius:8px; background:rgba(242,239,226,.5); }
    .${FEATURE_EDITOR_CLASS} h3 { margin:0 0 6px; }
    .feature-elevation-summary { margin:0 0 8px; font-size:12px; opacity:.78; }
    .feature-elevation-controls { display:grid; grid-template-columns:32px minmax(70px,1fr) 32px auto; gap:6px; align-items:center; }
    .feature-elevation-controls input { min-width:0; height:30px; }
    .feature-elevation-controls button { height:30px; }
    .feature-elevation-unit { font-size:12px; opacity:.75; margin-left:-2px; }
  `;
  documentNode.head?.append(style);
}

function characterById(state, characterId) {
  return (state?.characters || []).find((character) => String(character.id) === String(characterId)) || null;
}

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find((feature) => String(feature.id) === String(featureId)) || null;
}

function moverContextFor(state, characterId) {
  return Object.freeze({
    characterId: characterId == null ? null : String(characterId),
    elevationFt: tokenElevationFt(state, characterId),
  });
}

function multiplayerStatus(api) {
  return api.multiplayer?.getStatus?.() || null;
}

function canControlCharacter(api, characterId) {
  const status = multiplayerStatus(api);
  if (!status?.connected) return true;
  return api.multiplayer?.canControlCharacter?.(characterId) !== false;
}

function canEditFeatureHeight(api) {
  const status = multiplayerStatus(api);
  if (!status?.connected) return true;
  return status.session?.role === 'gm';
}

function setFeedback(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node && message) node.textContent = message;
}

function clampHudPosition(hud, event, documentNode) {
  const margin = 10;
  const viewportWidth = documentNode.defaultView?.innerWidth || 1280;
  const viewportHeight = documentNode.defaultView?.innerHeight || 720;
  const width = 190;
  const height = 116;
  hud.style.left = `${Math.max(margin, Math.min(viewportWidth - width - margin, event.clientX + 8))}px`;
  hud.style.top = `${Math.max(margin, Math.min(viewportHeight - height - margin, event.clientY + 8))}px`;
}

export function createElevationSystem() {
  return {
    register(api) {
      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document || null;
      const shell = mapElement?.closest?.('.app-shell') || documentNode;
      if (!mapElement || !documentNode) return;
      installStyles(documentNode);

      let selectedCharacterId = null;
      let tokenHud = null;
      let tokenSyncQueued = false;
      let featureSyncQueued = false;
      let destroyed = false;

      configureElevationNavigationRuntime({ getState: () => api.getState() });

      const syncActiveMover = (characterId = selectedCharacterId) => {
        const state = api.getState();
        setActiveMoverContext(moverContextFor(state, characterId));
      };

      const originalPlanCharacterMove = api.planCharacterMove;
      if (typeof originalPlanCharacterMove === 'function') {
        api.planCharacterMove = (characterId, ...args) => withActiveMoverContext(
          moverContextFor(api.getState(), characterId),
          () => originalPlanCharacterMove(characterId, ...args),
        );
      }

      const originalSetTool = api.setTool;
      if (typeof originalSetTool === 'function') {
        api.setTool = (tool, ...args) => {
          if (tool === 'character-place') setActiveMoverContext({ characterId: null, elevationFt: 0 });
          else syncActiveMover();
          return originalSetTool(tool, ...args);
        };
      }

      function closeTokenHud() {
        tokenHud?.remove();
        tokenHud = null;
      }

      function setTokenElevation(characterId, value) {
        if (!canControlCharacter(api, characterId)) {
          setFeedback(shell, '当前无法修改该 Token 高度：需要该 Actor 的 OWNER 权限，并遵守战斗回合限制。');
          return false;
        }
        const next = api.getState();
        const token = tokenForCharacter(next, characterId);
        if (!token) {
          setFeedback(shell, '当前角色还没有可保存高度的 Token 记录。');
          return false;
        }
        token.elevationFt = normalizeElevationFt(value, token.elevationFt);
        api.importState(next);
        selectedCharacterId = String(characterId);
        api.selectCharacter?.(characterId);
        syncActiveMover(characterId);
        scheduleTokenSync();
        api.emit?.('elevation:token-change', {
          characterId: String(characterId),
          elevationFt: token.elevationFt,
        });
        setFeedback(shell, `${characterById(next, characterId)?.name || 'Token'} 高度已设为 ${formatFt(token.elevationFt)} ft`);
        return true;
      }

      function setFeatureHeight(featureId, value) {
        if (!api.interaction || !canEditFeatureHeight(api)) {
          setFeedback(shell, 'Feature 阻挡高度属于 World 状态，当前仅本地模式或 GM 可修改。');
          return false;
        }
        const featureState = api.interaction.stateForFeature(featureId);
        const normalized = normalizeBlockingHeightFt(value);
        if (normalized === null) return false;
        api.interaction.patchState(featureId, {
          custom: {
            ...(featureState?.custom || {}),
            blockingHeightFt: normalized,
          },
        });
        api.emit?.('elevation:feature-change', { featureId: String(featureId), blockingHeightFt: normalized });
        scheduleFeatureSync();
        setFeedback(shell, `${featureById(api.mapPackage, featureId)?.name || 'Feature'} 阻挡高度已设为 ${formatFt(normalized)} ft`);
        return true;
      }

      function resetFeatureHeight(featureId) {
        if (!api.interaction || !canEditFeatureHeight(api)) return false;
        const featureState = api.interaction.stateForFeature(featureId);
        const custom = { ...(featureState?.custom || {}) };
        delete custom.blockingHeightFt;
        api.interaction.patchState(featureId, { custom });
        api.emit?.('elevation:feature-change', { featureId: String(featureId), blockingHeightFt: null, reset: true });
        scheduleFeatureSync();
        return true;
      }

      function identifyCharacterIcons() {
        const state = api.getState();
        const visibleCharacters = (state.characters || []).filter((character) => (
          character.visible !== false && character.location?.type === 'map'
        ));
        const characterIds = new Set(visibleCharacters.map((character) => String(character.id)));
        const used = new Set();
        const pending = [];

        api.map.eachLayer?.((layer) => {
          const icon = layer?._icon;
          if (!icon?.classList?.contains('rpg-character')) return;
          const existingId = String(icon.dataset.characterId || '');
          if (existingId && characterIds.has(existingId) && !used.has(existingId)) {
            used.add(existingId);
            return;
          }
          pending.push({ layer, icon });
        });

        for (const entry of pending) {
          const latLng = entry.layer.getLatLng?.();
          if (!latLng) continue;
          const world = latLngToWorld(latLng, api.mapPackage.height);
          let best = null;
          let bestDistance = Infinity;
          for (const character of visibleCharacters) {
            const id = String(character.id);
            if (used.has(id)) continue;
            const distance = Math.hypot(
              Number(character.location.x) - Number(world.x),
              Number(character.location.y) - Number(world.y),
            );
            if (distance < bestDistance) {
              bestDistance = distance;
              best = character;
            }
          }
          if (!best) continue;
          entry.icon.dataset.characterId = String(best.id);
          used.add(String(best.id));
        }
      }

      function syncTokenChrome() {
        tokenSyncQueued = false;
        if (destroyed) return;
        identifyCharacterIcons();
        const state = api.getState();
        for (const icon of mapElement.querySelectorAll('.rpg-character[data-character-id]')) {
          const characterId = icon.dataset.characterId;
          const token = tokenForCharacter(state, characterId);
          const actor = actorForCharacter(state, characterId);

          let elevation = icon.querySelector(':scope > .token-elevation-label');
          if (!elevation) {
            elevation = documentNode.createElement('div');
            elevation.className = 'token-elevation-label';
            icon.append(elevation);
          }
          elevation.textContent = `${formatFt(tokenElevationFt(token))} ft`;
          elevation.title = 'Token 当前离地高度';

          let hpMeter = icon.querySelector(':scope > .token-hp-meter');
          if (!hpMeter) {
            hpMeter = documentNode.createElement('div');
            hpMeter.className = 'token-hp-meter';
            const fill = documentNode.createElement('span');
            fill.className = 'token-hp-fill';
            hpMeter.append(fill);
            icon.append(hpMeter);
          }
          const resolved = actor ? resolveActor(actor) : null;
          const hp = resolved?.resources?.find?.((resource) => resource.id === 'hp') || null;
          const maximum = Math.max(0, Number(hp?.max) || 0);
          const current = Math.max(0, Number(hp?.current) || 0);
          if (!maximum) {
            hpMeter.hidden = true;
          } else {
            hpMeter.hidden = false;
            const ratio = Math.max(0, Math.min(1, current / maximum));
            hpMeter.querySelector('.token-hp-fill').style.width = `${Math.round(ratio * 1000) / 10}%`;
            hpMeter.dataset.hpState = ratio <= 0.25 ? 'low' : ratio <= 0.5 ? 'warn' : 'ok';
            hpMeter.title = `HP ${Math.round(current * 10) / 10} / ${Math.round(maximum * 10) / 10}`;
          }
        }
      }

      function scheduleTokenSync() {
        if (tokenSyncQueued) return;
        tokenSyncQueued = true;
        queueMicrotask(syncTokenChrome);
      }

      function openTokenElevationHud(event, characterId) {
        closeTokenHud();
        const state = api.getState();
        const character = characterById(state, characterId);
        const value = tokenElevationFt(state, characterId);
        const allowed = canControlCharacter(api, characterId);
        const hud = documentNode.createElement('div');
        hud.className = 'token-elevation-hud';
        hud.dataset.characterId = String(characterId);
        const heading = documentNode.createElement('strong');
        heading.textContent = `${character?.name || 'Token'} · Elevation`;
        const row = documentNode.createElement('div');
        row.className = 'token-elevation-hud-row';
        const down = documentNode.createElement('button');
        down.type = 'button';
        down.textContent = '−5';
        const input = documentNode.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '5';
        input.value = String(value);
        input.setAttribute('aria-label', 'Token elevation in feet');
        const up = documentNode.createElement('button');
        up.type = 'button';
        up.textContent = '+5';
        [down, input, up].forEach((control) => { control.disabled = !allowed; });
        row.append(down, input, up);
        const hint = documentNode.createElement('small');
        hint.textContent = allowed ? '右键 Token 打开 · 单位 ft' : '当前没有该 Actor 的控制权限';
        hud.append(heading, row, hint);
        documentNode.body.append(hud);
        clampHudPosition(hud, event, documentNode);
        tokenHud = hud;

        const commit = (nextValue) => {
          if (setTokenElevation(characterId, nextValue)) {
            input.value = String(tokenElevationFt(api.getState(), characterId));
          }
        };
        down.addEventListener('click', (clickEvent) => {
          clickEvent.stopPropagation();
          commit(Math.max(0, normalizeElevationFt(input.value, value) - 5));
        });
        up.addEventListener('click', (clickEvent) => {
          clickEvent.stopPropagation();
          commit(normalizeElevationFt(input.value, value) + 5);
        });
        input.addEventListener('change', () => commit(input.value));
        input.addEventListener('keydown', (keyEvent) => {
          if (keyEvent.key === 'Enter') {
            keyEvent.preventDefault();
            commit(input.value);
          }
          if (keyEvent.key === 'Escape') closeTokenHud();
        });
        requestAnimationFrame(() => { input.focus(); input.select(); });
      }

      function tokenContextMenu(event) {
        const icon = event.target.closest?.('.rpg-character[data-character-id]');
        if (!icon || !mapElement.contains(icon)) return;
        event.preventDefault();
        event.stopPropagation();
        const characterId = icon.dataset.characterId;
        if (!characterId) return;
        selectedCharacterId = characterId;
        api.selectCharacter?.(characterId);
        syncActiveMover(characterId);
        openTokenElevationHud(event, characterId);
      }

      function renderFeatureEditor() {
        featureSyncQueued = false;
        if (destroyed || !api.interaction) return;
        const panel = shell?.querySelector?.('[data-panel="inspect"]');
        if (!panel) return;
        const featureId = api.interaction.selectedFeatureId;
        const feature = featureById(api.mapPackage, featureId);
        const navigation = feature?.capabilities?.navigation || feature?.navigation;
        const existing = panel.querySelector(`.${FEATURE_EDITOR_CLASS}`);
        if (!feature || !navigation?.blocks) {
          existing?.remove();
          return;
        }

        const featureState = api.interaction.stateForFeature(feature.id);
        const declared = normalizeBlockingHeightFt(navigation.blockingHeightFt);
        const effective = featureBlockingHeightFt(feature, featureState);
        const hasOverride = featureState?.custom?.blockingHeightFt !== undefined
          && featureState?.custom?.blockingHeightFt !== null
          && featureState?.custom?.blockingHeightFt !== '';
        const allowed = canEditFeatureHeight(api);

        let editor = existing;
        if (!editor || editor.dataset.featureId !== String(feature.id)) {
          existing?.remove();
          editor = documentNode.createElement('div');
          editor.className = FEATURE_EDITOR_CLASS;
          editor.dataset.featureId = String(feature.id);
          const heading = documentNode.createElement('h3');
          heading.textContent = '高度阻挡';
          const summary = documentNode.createElement('p');
          summary.className = 'feature-elevation-summary';
          const controls = documentNode.createElement('div');
          controls.className = 'feature-elevation-controls';
          const down = documentNode.createElement('button');
          down.type = 'button';
          down.dataset.elevationAction = 'feature-down';
          down.textContent = '−5';
          const input = documentNode.createElement('input');
          input.type = 'number';
          input.min = '0';
          input.step = '5';
          input.dataset.elevationRole = 'feature-height';
          const up = documentNode.createElement('button');
          up.type = 'button';
          up.dataset.elevationAction = 'feature-up';
          up.textContent = '+5';
          const reset = documentNode.createElement('button');
          reset.type = 'button';
          reset.className = 'small-button';
          reset.dataset.elevationAction = 'feature-reset';
          reset.textContent = '恢复地图默认';
          controls.append(down, input, up, reset);
          editor.append(heading, summary, controls);
          const actionRow = panel.querySelector('.button-row');
          if (actionRow) actionRow.before(editor); else panel.append(editor);

          const applyInput = () => setFeatureHeight(feature.id, input.value);
          input.addEventListener('change', applyInput);
          input.addEventListener('keydown', (keyEvent) => {
            if (keyEvent.key === 'Enter') {
              keyEvent.preventDefault();
              applyInput();
            }
          });
          down.addEventListener('click', () => setFeatureHeight(feature.id, Math.max(0, normalizeElevationFt(input.value, effective || 0) - 5)));
          up.addEventListener('click', () => setFeatureHeight(feature.id, normalizeElevationFt(input.value, effective || 0) + 5));
          reset.addEventListener('click', () => resetFeatureHeight(feature.id));
        }

        const summary = editor.querySelector('.feature-elevation-summary');
        const input = editor.querySelector('[data-elevation-role="feature-height"]');
        const reset = editor.querySelector('[data-elevation-action="feature-reset"]');
        const defaultText = declared === null ? '未声明（保持传统无限高度阻挡）' : `${formatFt(declared)} ft`;
        const effectiveText = effective === null ? '无限高度' : `${formatFt(effective)} ft`;
        summary.textContent = `地图默认：${defaultText} · 当前：${effectiveText}${hasOverride ? ' · World 覆盖' : ''}`;
        input.value = effective === null ? '' : String(effective);
        input.placeholder = effective === null ? '输入 ft 启用高度上限' : '';
        editor.querySelectorAll('button, input').forEach((control) => { control.disabled = !allowed; });
        reset.disabled = !allowed || !hasOverride;
        editor.title = allowed ? '' : '连接状态下 Feature 高度属于 World 级编辑，目前仅 GM 可修改';
      }

      function scheduleFeatureSync() {
        if (featureSyncQueued) return;
        featureSyncQueued = true;
        queueMicrotask(renderFeatureEditor);
      }

      const tokenObserver = new MutationObserver(scheduleTokenSync);
      tokenObserver.observe(mapElement, { childList: true, subtree: true });
      const inspectPanel = shell?.querySelector?.('[data-panel="inspect"]');
      const featureObserver = inspectPanel ? new MutationObserver(scheduleFeatureSync) : null;
      featureObserver?.observe(inspectPanel, { childList: true, subtree: true });

      const closeOnPointerDown = (event) => {
        if (tokenHud && !tokenHud.contains(event.target)) closeTokenHud();
      };
      const closeOnEscape = (event) => {
        if (event.key === 'Escape' && tokenHud) closeTokenHud();
      };
      mapElement.addEventListener('contextmenu', tokenContextMenu, true);
      documentNode.addEventListener('pointerdown', closeOnPointerDown, true);
      documentNode.addEventListener('keydown', closeOnEscape, true);

      const unsubscribers = [
        api.on?.('character:select', (event) => {
          selectedCharacterId = event.detail?.id ? String(event.detail.id) : null;
          syncActiveMover();
          scheduleTokenSync();
        }),
        api.on?.('character:create', (event) => {
          if (event.detail?.id) selectedCharacterId = String(event.detail.id);
          syncActiveMover();
          scheduleTokenSync();
        }),
        api.on?.('character:delete', (event) => {
          if (String(event.detail?.id ?? '') === selectedCharacterId) selectedCharacterId = null;
          syncActiveMover();
          closeTokenHud();
          scheduleTokenSync();
        }),
        api.on?.('character:update', scheduleTokenSync),
        api.on?.('character:move', scheduleTokenSync),
        api.on?.('state:import', () => {
          syncActiveMover();
          closeTokenHud();
          scheduleTokenSync();
          scheduleFeatureSync();
        }),
        api.on?.('feature:select', scheduleFeatureSync),
        api.on?.('interaction:state-change', scheduleFeatureSync),
        api.on?.('interaction:executed', scheduleFeatureSync),
        api.on?.('scene:damage', scheduleFeatureSync),
        api.on?.('scene:restore', scheduleFeatureSync),
      ].filter(Boolean);

      api.elevation = Object.freeze({
        tokenElevationFt(characterId) { return tokenElevationFt(api.getState(), characterId); },
        featureBlockingHeightFt(featureId) {
          const feature = featureById(api.mapPackage, featureId);
          return feature ? featureBlockingHeightFt(feature, api.interaction?.stateForFeature?.(featureId)) : null;
        },
        setTokenElevationFt: setTokenElevation,
        setFeatureBlockingHeightFt: setFeatureHeight,
        resetFeatureBlockingHeightFt: resetFeatureHeight,
        sync() { scheduleTokenSync(); scheduleFeatureSync(); },
      });

      syncActiveMover();
      scheduleTokenSync();
      scheduleFeatureSync();

      api.on?.('app:destroy', () => {
        destroyed = true;
        closeTokenHud();
        tokenObserver.disconnect();
        featureObserver?.disconnect();
        mapElement.removeEventListener('contextmenu', tokenContextMenu, true);
        documentNode.removeEventListener('pointerdown', closeOnPointerDown, true);
        documentNode.removeEventListener('keydown', closeOnEscape, true);
        unsubscribers.forEach((unsubscribe) => unsubscribe?.());
        resetElevationNavigationRuntime();
      });
    },
  };
}
