import { formatFt } from '../elevation/model.js';
import {
  normalizeTokenRotation,
  setTokenDiameterMeters,
  setTokenElevationFt,
  setTokenHidden,
  setTokenRotation,
  tokenPropertySnapshot,
} from './properties.js';

const STYLE_ID = 'rpgmap-token-property-v2-style';

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .token-v2-properties { display:flex; gap:7px; flex-wrap:wrap; align-items:center; }
    .token-v2-properties label { display:inline-flex; gap:5px; align-items:center; }
    .token-v2-properties input[type="number"] { width:72px; }
  `;
  documentNode.head.append(style);
}

function id(value) {
  return String(value ?? '').trim();
}

function tokenIdFromNode(node) {
  if (!node) return null;
  const direct = id(node.dataset?.tokenId || node.dataset?.characterId);
  if (direct) return direct;
  const carrier = node.closest?.('[data-token-id],[data-character-id]');
  return id(carrier?.dataset?.tokenId || carrier?.dataset?.characterId) || null;
}

function setMapStatus(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node) node.textContent = message;
}

function canManageStructure(api) {
  const capabilities = api.multiplayer?.getCapabilities?.();
  return capabilities?.canManageStructure !== false;
}

function canEditElevation(api, tokenId) {
  return api.elevation?.canSetTokenElevation?.(tokenId) !== false;
}

function actorName(api, tokenId) {
  try { return api.tokens.resolveActor?.(tokenId)?.actor?.name || 'Token'; }
  catch { return 'Token'; }
}

function clampHudPosition(hud, anchor, documentNode) {
  const viewportWidth = documentNode.defaultView?.innerWidth || 1280;
  const viewportHeight = documentNode.defaultView?.innerHeight || 720;
  const width = 190;
  const height = 116;
  const x = Number(anchor?.clientX) || 0;
  const y = Number(anchor?.clientY) || 0;
  hud.style.left = `${Math.max(10, Math.min(viewportWidth - width - 10, x + 8))}px`;
  hud.style.top = `${Math.max(10, Math.min(viewportHeight - height - 10, y + 8))}px`;
}

export function createTokenPropertyUiSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.tokens?.get || !api?.tokens?.update || !api?.tokens?.resolveActor) {
        throw new Error('Token Property V2 requires canonical Token Runtime V2');
      }

      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      installStyles(documentNode);

      let destroyed = false;
      let syncQueued = false;
      let elevationHud = null;
      let propertyBusy = false;
      const off = [];

      function closeElevationHud() {
        elevationHud?.remove();
        elevationHud = null;
      }

      function scheduleEditorSync() {
        if (destroyed || syncQueued) return;
        syncQueued = true;
        queueMicrotask(syncEditorCards);
      }

      function syncEditorCards() {
        syncQueued = false;
        if (destroyed) return;
        const structureAllowed = canManageStructure(api);
        for (const diameterSelect of documentNode.querySelectorAll?.('[data-token-diameter]') || []) {
          const tokenId = tokenIdFromNode(diameterSelect);
          if (!tokenId) continue;
          let snapshot;
          try { snapshot = tokenPropertySnapshot(api, tokenId); }
          catch { continue; }

          diameterSelect.dataset.tokenId = tokenId;
          diameterSelect.value = String(snapshot.diameterMeters);
          diameterSelect.disabled = !structureAllowed;
          const card = diameterSelect.closest?.('.entity-card');
          if (!card) continue;

          for (const action of card.querySelectorAll?.('[data-character-id]') || []) {
            if (!action.dataset.tokenId) action.dataset.tokenId = tokenId;
          }

          let controls = card.querySelector?.('.token-v2-properties');
          if (!controls) {
            controls = documentNode.createElement('div');
            controls.className = 'token-v2-properties';
            controls.dataset.tokenId = tokenId;

            const visibleLabel = documentNode.createElement('label');
            visibleLabel.textContent = '显示';
            const visible = documentNode.createElement('input');
            visible.type = 'checkbox';
            visible.dataset.tokenVisibleV2 = '';
            visible.dataset.tokenId = tokenId;
            visibleLabel.prepend(visible);

            const rotationLabel = documentNode.createElement('label');
            rotationLabel.textContent = '旋转';
            const rotation = documentNode.createElement('input');
            rotation.type = 'number';
            rotation.min = '0';
            rotation.max = '359';
            rotation.step = '15';
            rotation.dataset.tokenRotationV2 = '';
            rotation.dataset.tokenId = tokenId;
            const degree = documentNode.createElement('span');
            degree.textContent = '°';
            rotationLabel.append(rotation, degree);

            controls.append(visibleLabel, rotationLabel);
            card.querySelector?.('.entity-card-actions')?.append(controls);
          }

          controls.dataset.tokenId = tokenId;
          const visible = controls.querySelector('[data-token-visible-v2]');
          const rotation = controls.querySelector('[data-token-rotation-v2]');
          if (visible) {
            visible.dataset.tokenId = tokenId;
            visible.checked = !snapshot.hidden;
            visible.disabled = !structureAllowed;
          }
          if (rotation) {
            rotation.dataset.tokenId = tokenId;
            rotation.value = String(snapshot.rotation);
            rotation.disabled = !structureAllowed;
          }
        }
      }

      async function commitProperty(tokenId, property, value) {
        if (propertyBusy) return null;
        propertyBusy = true;
        try {
          let token;
          if (property === 'diameterMeters') token = await setTokenDiameterMeters(api, tokenId, value);
          else if (property === 'hidden') token = await setTokenHidden(api, tokenId, value);
          else if (property === 'rotation') token = await setTokenRotation(api, tokenId, value);
          else throw new Error(`Unsupported Token property: ${property}`);

          api.emit?.('token:property-change', { tokenId: token.id, id: token.id, actorId: token.actorId, property, token });
          if (property === 'diameterMeters') {
            api.emit?.('token:size-change', {
              tokenId: token.id,
              characterId: token.id,
              diameterMeters: token.diameterMeters,
            });
          }
          if (property === 'hidden') api.emit?.('token:visibility-change', { tokenId: token.id, hidden: token.hidden });
          if (property === 'rotation') api.emit?.('token:rotation-change', { tokenId: token.id, rotation: token.rotation });
          scheduleEditorSync();
          return token;
        } finally {
          propertyBusy = false;
        }
      }

      async function setElevation(tokenId, value) {
        const token = api.tokens.get(tokenId);
        if (!token) throw new Error(`Unknown Token: ${tokenId}`);
        if (!canEditElevation(api, tokenId)) {
          setMapStatus(shell, '当前无法修改该 Token 高度：需要该 Actor 的 OWNER 权限，并遵守战斗回合限制。');
          return null;
        }
        const updated = await setTokenElevationFt(api, tokenId, value);
        api.emit?.('elevation:token-change', {
          tokenId: updated.id,
          characterId: updated.id,
          elevationFt: updated.elevationFt,
        });
        api.emit?.('token:property-change', {
          tokenId: updated.id,
          id: updated.id,
          actorId: updated.actorId,
          property: 'elevationFt',
          token: updated,
        });
        scheduleEditorSync();
        setMapStatus(shell, `${actorName(api, tokenId)} 高度已设为 ${formatFt(updated.elevationFt)} ft`);
        return updated;
      }

      function openElevationEditor(tokenId, anchor = null) {
        const token = api.tokens.get(tokenId);
        if (!token) {
          setMapStatus(shell, '当前 Token 已不存在。');
          return false;
        }
        closeElevationHud();
        const snapshot = tokenPropertySnapshot(api, tokenId);
        const allowed = canEditElevation(api, tokenId);
        const hud = documentNode.createElement('div');
        hud.className = 'token-elevation-hud token-elevation-hud-v2';
        hud.dataset.tokenId = tokenId;
        const heading = documentNode.createElement('strong');
        heading.textContent = `${actorName(api, tokenId)} · Elevation`;
        const row = documentNode.createElement('div');
        row.className = 'token-elevation-hud-row';
        const down = documentNode.createElement('button');
        down.type = 'button'; down.textContent = '−5';
        const input = documentNode.createElement('input');
        input.type = 'number'; input.min = '0'; input.step = '5'; input.value = String(snapshot.elevationFt);
        input.setAttribute('aria-label', 'Token elevation in feet');
        const up = documentNode.createElement('button');
        up.type = 'button'; up.textContent = '+5';
        [down, input, up].forEach(control => { control.disabled = !allowed; });
        row.append(down, input, up);
        const hint = documentNode.createElement('small');
        hint.textContent = allowed ? '右键 Token 或角色卡 Token 页打开 · 单位 ft' : '当前没有该 Actor 的控制权限';
        hud.append(heading, row, hint);
        documentNode.body.append(hud);
        clampHudPosition(hud, anchor, documentNode);
        elevationHud = hud;

        let elevationBusy = false;
        const commit = async nextValue => {
          if (elevationBusy) return;
          elevationBusy = true;
          try {
            const updated = await setElevation(tokenId, nextValue);
            if (updated) input.value = String(updated.elevationFt);
          } catch (error) {
            console.error('[RPGmap Token Property V2] elevation update failed', error);
            setMapStatus(shell, `Token 高度更新失败：${error?.message || error}`);
          } finally {
            elevationBusy = false;
          }
        };
        down.addEventListener('click', event => {
          event.stopPropagation();
          const current = tokenPropertySnapshot(api, tokenId).elevationFt;
          commit(Math.max(0, current - 5));
        });
        up.addEventListener('click', event => {
          event.stopPropagation();
          const current = tokenPropertySnapshot(api, tokenId).elevationFt;
          commit(current + 5);
        });
        input.addEventListener('change', () => commit(input.value));
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); commit(input.value); }
          if (event.key === 'Escape') closeElevationHud();
        });
        requestAnimationFrame(() => { input.focus(); input.select(); });
        return true;
      }

      async function captureChange(event) {
        const target = event.target;
        if (!target?.matches) return;
        const isDiameter = target.matches('[data-token-diameter]');
        const isVisible = target.matches('[data-token-visible-v2]');
        const isRotation = target.matches('[data-token-rotation-v2]');
        if (!isDiameter && !isVisible && !isRotation) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        const tokenId = tokenIdFromNode(target);
        if (!tokenId || !api.tokens.get(tokenId)) { scheduleEditorSync(); return; }
        if (!canManageStructure(api)) {
          setMapStatus(shell, '当前 Token 外观/尺寸属性仅 GM 可修改。');
          scheduleEditorSync();
          return;
        }

        try {
          if (isDiameter) {
            const token = await commitProperty(tokenId, 'diameterMeters', target.value);
            if (token) setMapStatus(shell, `Token 直径已设为 ${token.diameterMeters} m`);
          } else if (isVisible) {
            const token = await commitProperty(tokenId, 'hidden', !target.checked);
            if (token) setMapStatus(shell, token.hidden ? 'Token 已隐藏' : 'Token 已显示');
          } else {
            const token = await commitProperty(tokenId, 'rotation', normalizeTokenRotation(target.value));
            if (token) setMapStatus(shell, `Token 旋转已设为 ${token.rotation}°`);
          }
        } catch (error) {
          console.error('[RPGmap Token Property V2] update failed', error);
          setMapStatus(shell, `Token 属性更新失败：${error?.message || error}`);
          scheduleEditorSync();
        }
      }

      function captureClick(event) {
        const action = event.target?.closest?.('[data-sheet-action="edit-token-elevation"]');
        if (!action) return;
        const tokenId = tokenIdFromNode(action);
        if (!tokenId || !api.tokens.get(tokenId)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const rect = action.getBoundingClientRect();
        openElevationEditor(tokenId, {
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom,
        });
      }

      function captureContextMenu(event) {
        const tokenCarrier = event.target?.closest?.('[data-token-id], .rpg-token-v2');
        const tokenId = id(tokenCarrier?.dataset?.tokenId || tokenCarrier?.querySelector?.('[data-token-id]')?.dataset?.tokenId);
        if (!tokenId || !api.tokens.get(tokenId) || !mapElement.contains(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openElevationEditor(tokenId, event);
      }

      const closeHudOutside = event => {
        if (elevationHud && !elevationHud.contains(event.target)) closeElevationHud();
      };
      const closeHudEscape = event => {
        if (event.key === 'Escape' && elevationHud) closeElevationHud();
      };

      documentNode.addEventListener('change', captureChange, true);
      documentNode.addEventListener('click', captureClick, true);
      mapElement.addEventListener('contextmenu', captureContextMenu, true);
      documentNode.addEventListener('pointerdown', closeHudOutside, true);
      documentNode.addEventListener('keydown', closeHudEscape, true);
      const observer = new MutationObserver(scheduleEditorSync);
      observer.observe(documentNode.body, { childList: true, subtree: true });

      for (const eventName of ['state:commit', 'state:import', 'token:create', 'token:move', 'token:size-change', 'multiplayer:capabilities']) {
        off.push(api.on?.(eventName, scheduleEditorSync));
      }

      // Replace only the public Token-height methods. Feature-height editing and
      // older internals stay available until the Elevation module itself is
      // fully converted away from Character compatibility reads.
      const legacyElevation = api.elevation || {};
      api.elevation = Object.freeze({
        ...legacyElevation,
        tokenElevationFt(tokenId) {
          try { return tokenPropertySnapshot(api, tokenId).elevationFt; }
          catch { return 0; }
        },
        setTokenElevationFt(tokenId, value) { return setElevation(id(tokenId), value); },
        openTokenElevationEditor(tokenId, anchor) { return openElevationEditor(id(tokenId), anchor); },
      });

      api.tokenProperties = Object.freeze({
        canonicalSceneTokens: true,
        snapshot(tokenId) { return tokenPropertySnapshot(api, tokenId); },
        setHidden(tokenId, hidden) { return commitProperty(id(tokenId), 'hidden', hidden); },
        setDiameterMeters(tokenId, value) { return commitProperty(id(tokenId), 'diameterMeters', value); },
        setRotation(tokenId, value) { return commitProperty(id(tokenId), 'rotation', value); },
        setElevationFt(tokenId, value) { return setElevation(id(tokenId), value); },
        openElevationEditor,
        sync: scheduleEditorSync,
      });

      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        closeElevationHud();
        observer.disconnect();
        documentNode.removeEventListener('change', captureChange, true);
        documentNode.removeEventListener('click', captureClick, true);
        mapElement.removeEventListener('contextmenu', captureContextMenu, true);
        documentNode.removeEventListener('pointerdown', closeHudOutside, true);
        documentNode.removeEventListener('keydown', closeHudEscape, true);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      scheduleEditorSync();
      api.emit?.('token-properties:ready', { canonicalSceneTokens: true });
    },
  });
}
