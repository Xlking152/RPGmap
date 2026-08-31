import L from 'leaflet';
import { latLngToWorld, worldToLatLng, formatDistance } from '../engine/geometry.js';
import { snapMovementPoint } from './snap.js';

const DRAG_THRESHOLD_PX = 4;
const MAX_KEYBOARD_QUEUE = 24;

function inside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

function tokenIdFromTarget(target) {
  return target?.closest?.('[data-token-id]')?.dataset?.tokenId
    || target?.closest?.('.rpg-token-v2')?.querySelector?.('[data-token-id]')?.dataset?.tokenId
    || null;
}

function eventPoint(event) {
  return { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
}

function distancePixels(left, right) {
  return Math.hypot(Number(left.x) - Number(right.x), Number(left.y) - Number(right.y));
}

export function createMovementControllerV4({ settings } = {}) {
  return Object.freeze({
    register(api) {
      if (!settings) throw new Error('Movement V4 requires MovementSettings');
      if (!api.movement?.canonicalSceneTokens || !api.tokens?.get || !api.selection) {
        throw new Error('Movement V4 requires canonical Token Runtime');
      }

      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const routeLayer = L.layerGroup([], { pane: 'measurePane' }).addTo(api.map);
      const status = message => api.setStatus?.(message);
      const off = [];
      let destroyed = false;
      let interaction = null;
      let suppressClickUntil = 0;
      let previousTool = 'pan';
      let keyboardRunning = false;
      const keyboardQueue = [];

      const mapToken = tokenId => {
        const token = tokenId ? api.tokens.get(tokenId) : null;
        return token?.placement === 'map' ? token : null;
      };

      const worldPoint = event => latLngToWorld(api.map.mouseEventToLatLng(event), api.mapPackage.height);
      const snapPoint = point => {
        const snapped = snapMovementPoint(point, settings.step);
        return {
          x: Math.max(0, Math.min(api.mapPackage.width, snapped.x)),
          y: Math.max(0, Math.min(api.mapPackage.height, snapped.y)),
        };
      };

      function groupForLeader(leader) {
        const selectedIds = (api.selection.getSelectedTokenIds?.() || []).map(String);
        const ids = selectedIds.length > 1 && selectedIds.includes(String(leader.id))
          ? selectedIds
          : [String(leader.id)];
        const tokens = ids.map(mapToken).filter(Boolean);
        return tokens.map(token => ({
          tokenId: String(token.id),
          dx: Number(token.x) - Number(leader.x),
          dy: Number(token.y) - Number(leader.y),
        }));
      }

      function beginInteraction(leader, { mode = 'drag', client = null } = {}) {
        if (!leader) return false;
        const members = groupForLeader(leader);
        interaction = {
          mode,
          tokenId: String(leader.id),
          start: { x: Number(leader.x), y: Number(leader.y) },
          current: { x: Number(leader.x), y: Number(leader.y) },
          clientStart: client,
          dragged: false,
          members,
          pending: false,
        };
        api.selection.replace?.(members.map(member => member.tokenId), leader.id);
        return true;
      }

      function clearPreview() {
        routeLayer.clearLayers();
      }

      function drawPreview(target, { valid = true } = {}) {
        if (!interaction) return;
        clearPreview();
        const color = valid ? '#176d76' : '#b52f2a';
        L.polyline([
          worldToLatLng(interaction.start, api.mapPackage.height),
          worldToLatLng(target, api.mapPackage.height),
        ], {
          pane: 'measurePane', color, weight: 4, dashArray: '10 7', interactive: false,
          className: valid ? 'token-route-preview' : 'token-route-preview token-route-blocked',
        }).addTo(routeLayer);
        L.circleMarker(worldToLatLng(target, api.mapPackage.height), {
          pane: 'measurePane', radius: 9, color, weight: 2,
          fillColor: color, fillOpacity: .2, interactive: false,
        }).addTo(routeLayer);
      }

      function reset(message = '') {
        clearPreview();
        api.movement.cancelPending?.();
        interaction = null;
        mapElement.classList.remove('fvtt-token-dragging');
        if (api.map.dragging && !api.map.dragging.enabled() && mapElement.dataset.rpgMovementDisabledDragging === 'true') {
          api.map.dragging.enable();
        }
        delete mapElement.dataset.rpgMovementDisabledDragging;
        if (message) status(message);
      }

      async function validateSingle(tokenId, target, from = null) {
        const result = await api.movement.validateTokenMove?.(tokenId, target, from ? { from } : {});
        return result || { valid: false, reason: '无法校验移动' };
      }

      async function commitDirect(target) {
        const current = interaction;
        if (!current || current.pending) return false;
        current.pending = true;
        const members = current.members || [];
        const group = members.length > 1;
        try {
          if (group) {
            const planned = await api.movement.planTokenGroupMove?.(
              members.map(member => member.tokenId),
              current.tokenId,
              [current.start, target],
            );
            if (!planned?.valid) {
              drawPreview(target, { valid: false });
              status('群组移动失败：至少一个 Token 的路径不可通行');
              current.pending = false;
              return false;
            }
            drawPreview(target, { valid: true });
            const committed = api.movement.commitTokenGroupMove?.();
            if (!committed) {
              status('群组移动提交失败');
              current.pending = false;
              return false;
            }
            status(`群组 ${members.length} Token 移动已提交`);
            suppressClickUntil = Date.now() + 250;
            reset();
            return true;
          }

          const checked = await validateSingle(current.tokenId, target, current.start);
          if (!checked.valid) {
            drawPreview(target, { valid: false });
            status(`移动失败：${checked.reason || '当前位置不可通行'}`);
            current.pending = false;
            return false;
          }
          drawPreview(target, { valid: true });
          const result = await api.movement.moveTokenTo(current.tokenId, target);
          if (!result?.valid) {
            drawPreview(target, { valid: false });
            status(`移动失败：${result?.reason || '当前位置不可通行'}`);
            current.pending = false;
            return false;
          }
          status(`Token 已移动 ${formatDistance(Number(result.distance) || 0)}`);
          suppressClickUntil = Date.now() + 250;
          reset();
          return true;
        } catch (error) {
          current.pending = false;
          status(`移动失败：${error?.message || String(error)}`);
          return false;
        }
      }

      function pointerDown(event) {
        if (destroyed || event.button !== 0 || interaction?.pending) return;
        const tokenId = tokenIdFromTarget(event.target);
        if (!tokenId) return;
        const token = mapToken(tokenId);
        if (!token) return;
        const access = api.movement.inspectMovementAccess?.(token.id, { x: token.x, y: token.y });
        if (access?.valid === false) {
          status(`移动不可用：${access.reason || '当前 Token 无法移动'}`);
          return;
        }
        settings.beginSession(api.map, api.mapPackage);
        if (!beginInteraction(token, { mode: 'drag', client: eventPoint(event) })) return;
        if (api.map.dragging?.enabled?.()) {
          api.map.dragging.disable();
          mapElement.dataset.rpgMovementDisabledDragging = 'true';
        }
        mapElement.classList.add('fvtt-token-dragging');
      }

      function pointerMove(event) {
        if (!interaction || interaction.mode !== 'drag' || interaction.pending) return;
        if (!interaction.dragged) {
          if (distancePixels(interaction.clientStart, eventPoint(event)) < DRAG_THRESHOLD_PX) return;
          interaction.dragged = true;
        }
        event.preventDefault();
        event.stopPropagation();
        const raw = worldPoint(event);
        if (!inside(raw, api.mapPackage)) return;
        const target = snapPoint(raw);
        interaction.current = target;
        drawPreview(target, { valid: true });
        const label = interaction.members.length > 1 ? `群组 ${interaction.members.length} Token` : 'Token';
        status(`${label} 拖动中 · 吸附 ${settings.step} m · 松开即移动`);
      }

      function pointerUp(event) {
        if (!interaction || interaction.mode !== 'drag') return;
        const current = interaction;
        if (!current.dragged) {
          reset();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const raw = worldPoint(event);
        const target = inside(raw, api.mapPackage) ? snapPoint(raw) : current.current;
        void commitDirect(target);
      }

      function pointerCancel() {
        if (interaction?.mode === 'drag') reset('已取消 Token 拖动');
      }

      function clickCapture(event) {
        if (Date.now() >= suppressClickUntil) return;
        if (!event.target?.closest?.('.rpg-token-v2,[data-token-id]')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }

      async function processKeyboardQueue() {
        if (keyboardRunning || destroyed) return;
        keyboardRunning = true;
        try {
          while (keyboardQueue.length && !destroyed) {
            const direction = keyboardQueue.shift();
            const token = mapToken(api.selection.getPrimaryTokenId?.());
            if (!token) {
              keyboardQueue.length = 0;
              status('请先选择一个位于地图上的 Token');
              break;
            }
            const target = snapPoint({
              x: Number(token.x) + direction.x * settings.step,
              y: Number(token.y) + direction.y * settings.step,
            });
            const result = await api.movement.moveTokenTo(token.id, target);
            if (!result?.valid) {
              keyboardQueue.length = 0;
              status(`移动失败：${result?.reason || '当前位置不可通行'}`);
              break;
            }
            status(`WASD 移动 ${formatDistance(Number(result.distance) || settings.step)} · 队列 ${keyboardQueue.length}`);
          }
        } finally {
          keyboardRunning = false;
        }
      }

      function keydown(event) {
        const editable = 'input,textarea,select,[contenteditable="true"],.entity-sheet,.actor-sheet,[data-actor-sheet]';
        const focusTarget = event.target?.closest?.(editable) || documentNode.activeElement?.closest?.(editable);
        if (event.defaultPrevented || focusTarget || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.key === 'Escape' && interaction) {
          event.preventDefault();
          event.stopImmediatePropagation();
          reset('已取消 Token 移动');
          return;
        }
        if (event.key === 'Enter' && interaction?.mode === 'click' && !interaction.pending) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void commitDirect(interaction.current);
          return;
        }
        if (interaction?.mode === 'drag') return;
        const direction = {
          w: { x: 0, y: -1 },
          a: { x: -1, y: 0 },
          s: { x: 0, y: 1 },
          d: { x: 1, y: 0 },
        }[event.key.toLowerCase()];
        if (!direction) return;
        if (!mapToken(api.selection.getPrimaryTokenId?.())) {
          status('请先选择一个位于地图上的 Token');
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (keyboardQueue.length < MAX_KEYBOARD_QUEUE) keyboardQueue.push(direction);
        void processKeyboardQueue();
      }

      function mapClick(event) {
        if (!interaction || interaction.mode !== 'click' || interaction.pending) return;
        if (event.target?.closest?.('.leaflet-control,.rpg-token-v2,[data-token-id]')) return;
        const raw = worldPoint(event);
        if (!inside(raw, api.mapPackage)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        interaction.current = snapPoint(raw);
        drawPreview(interaction.current, { valid: true });
        void commitDirect(interaction.current);
      }

      function wheel(event) {
        if (!interaction || interaction.pending) return;
        event.preventDefault();
        const direction = event.deltaY > 0 ? 1 : -1;
        settings.cycle(direction, { source: 'wheel' });
        if (interaction.current) {
          interaction.current = snapPoint(interaction.current);
          drawPreview(interaction.current, { valid: true });
        }
        status(`移动吸附 ${settings.step} m`);
      }

      api.movementUi = Object.freeze({
        begin(tokenId) {
          const token = mapToken(tokenId);
          if (!token) return false;
          settings.beginSession(api.map, api.mapPackage);
          previousTool = api.getTool?.() || 'pan';
          api.setTool?.('token-move');
          beginInteraction(token, { mode: 'click' });
          drawPreview(interaction.current, { valid: true });
          status('点击地图即可移动 · Esc 取消 · 滚轮调整吸附');
          return true;
        },
        async plan(tokenId, point) {
          const token = mapToken(tokenId);
          if (!token) return null;
          if (!interaction || interaction.tokenId !== String(token.id)) beginInteraction(token, { mode: 'click' });
          interaction.current = snapPoint(point);
          const result = interaction.members.length > 1
            ? await api.movement.planTokenGroupMove?.(interaction.members.map(member => member.tokenId), interaction.tokenId, [interaction.start, interaction.current])
            : await validateSingle(interaction.tokenId, interaction.current, interaction.start);
          drawPreview(interaction.current, { valid: result?.valid !== false });
          return result;
        },
        commit() { return interaction ? commitDirect(interaction.current) : false; },
        cancel() { reset('已取消 Token 移动'); return true; },
        addWaypoint() { return false; },
        removeWaypoint() { return false; },
        getState() {
          return interaction ? {
            tokenId: interaction.tokenId,
            phase: interaction.pending ? 'committing' : 'planning',
            groupTokenIds: interaction.members.map(member => member.tokenId),
          } : { phase: 'idle', groupTokenIds: [] };
        },
        getGroupPreviewMembers() { return interaction?.members?.map(member => ({ ...member })) || []; },
      });

      const selectionOff = api.selection.subscribe?.(() => {
        if (!interaction?.pending && interaction?.mode !== 'drag') reset();
      });
      if (selectionOff) off.push(selectionOff);
      const stepOff = settings.subscribe(() => {
        if (interaction?.current) {
          interaction.current = snapPoint(interaction.current);
          drawPreview(interaction.current, { valid: true });
        }
      });
      if (stepOff) off.push(stepOff);

      mapElement.addEventListener('pointerdown', pointerDown, true);
      documentNode.addEventListener('pointermove', pointerMove, true);
      documentNode.addEventListener('pointerup', pointerUp, true);
      documentNode.addEventListener('pointercancel', pointerCancel, true);
      mapElement.addEventListener('click', clickCapture, true);
      mapElement.addEventListener('click', mapClick, true);
      mapElement.addEventListener('wheel', wheel, { passive: false, capture: true });
      documentNode.addEventListener('keydown', keydown, true);

      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        keyboardQueue.length = 0;
        reset();
        mapElement.removeEventListener('pointerdown', pointerDown, true);
        documentNode.removeEventListener('pointermove', pointerMove, true);
        documentNode.removeEventListener('pointerup', pointerUp, true);
        documentNode.removeEventListener('pointercancel', pointerCancel, true);
        mapElement.removeEventListener('click', clickCapture, true);
        mapElement.removeEventListener('click', mapClick, true);
        mapElement.removeEventListener('wheel', wheel, true);
        documentNode.removeEventListener('keydown', keydown, true);
        routeLayer.clearLayers();
        api.map.removeLayer?.(routeLayer);
        off.splice(0).forEach(dispose => dispose?.());
        if (previousTool && api.getTool?.() === 'token-move') api.setTool?.(previousTool);
      }));

      api.emit?.('movement:controller-v4-ready', {
        drag: 'document-pointer',
        keyboard: 'queued',
        groupMovement: true,
      });
    },
  });
}
