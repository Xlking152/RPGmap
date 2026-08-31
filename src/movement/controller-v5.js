import L from 'leaflet';
import { latLngToWorld, worldToLatLng, formatDistance } from '../engine/geometry.js';
import { snapMovementPoint } from './snap.js';

const DRAG_THRESHOLD_PX = 4;
const MAX_KEYBOARD_STEPS = 48;

function inside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

function tokenIdFromTarget(target) {
  return target?.closest?.('[data-token-id]')?.dataset?.tokenId
    || target?.closest?.('.rpg-token-v2')?.querySelector?.('[data-token-id]')?.dataset?.tokenId
    || null;
}

function clientPoint(event) {
  return { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
}

function distancePixels(left, right) {
  return Math.hypot(Number(left.x) - Number(right.x), Number(left.y) - Number(right.y));
}

function sameDirection(left, right) {
  return left && right && left.x === right.x && left.y === right.y;
}

export function createMovementControllerV5({ settings } = {}) {
  return Object.freeze({
    register(api) {
      if (!settings) throw new Error('Movement V5 requires MovementSettings');
      if (!api.movement?.canonicalSceneTokens || !api.tokens?.get || !api.selection) {
        throw new Error('Movement V5 requires canonical Token Runtime');
      }

      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const windowNode = documentNode.defaultView || globalThis;
      const requestFrame = callback => windowNode.requestAnimationFrame
        ? windowNode.requestAnimationFrame(callback)
        : windowNode.setTimeout(() => callback(Date.now()), 16);
      const cancelFrame = id => windowNode.cancelAnimationFrame
        ? windowNode.cancelAnimationFrame(id)
        : windowNode.clearTimeout(id);
      const routeLayer = L.layerGroup([], { pane: 'measurePane' }).addTo(api.map);
      const status = message => api.setStatus?.(message);
      const off = [];
      let destroyed = false;
      let interaction = null;
      let suppressClickUntil = 0;
      let previousTool = 'pan';
      let pointerFrame = null;
      let pendingPointerClient = null;
      let previewLine = null;
      let previewEnd = null;
      let keyboardFrame = null;
      let keyboardRunning = false;
      const keyboardQueue = [];

      const mapToken = tokenId => {
        const token = tokenId ? api.tokens.get(tokenId) : null;
        return token?.placement === 'map' ? token : null;
      };

      function worldPointFromClient(point) {
        const rect = mapElement.getBoundingClientRect();
        const latLng = api.map.containerPointToLatLng([
          Number(point.x) - rect.left,
          Number(point.y) - rect.top,
        ]);
        return latLngToWorld(latLng, api.mapPackage.height);
      }

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
        return ids.map(mapToken).filter(Boolean).map(token => ({
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
        if (previewLine) routeLayer.removeLayer(previewLine);
        if (previewEnd) routeLayer.removeLayer(previewEnd);
        previewLine = null;
        previewEnd = null;
      }

      function drawPreview(target, { valid = true } = {}) {
        if (!interaction) return;
        const color = valid ? '#176d76' : '#b52f2a';
        const points = [
          worldToLatLng(interaction.start, api.mapPackage.height),
          worldToLatLng(target, api.mapPackage.height),
        ];
        if (!previewLine) {
          previewLine = L.polyline(points, {
            pane: 'measurePane', color, weight: 4, dashArray: '10 7', interactive: false,
            className: 'token-route-preview',
          }).addTo(routeLayer);
        } else {
          previewLine.setLatLngs(points);
          previewLine.setStyle({ color });
        }
        const end = points[1];
        if (!previewEnd) {
          previewEnd = L.circleMarker(end, {
            pane: 'measurePane', radius: 9, color, weight: 2,
            fillColor: color, fillOpacity: .2, interactive: false,
          }).addTo(routeLayer);
        } else {
          previewEnd.setLatLng(end);
          previewEnd.setStyle({ color, fillColor: color });
        }
      }

      function reset(message = '') {
        const mode = interaction?.mode || null;
        clearPreview();
        api.movement.cancelPending?.();
        interaction = null;
        pendingPointerClient = null;
        if (pointerFrame !== null) cancelFrame(pointerFrame);
        pointerFrame = null;
        mapElement.classList.remove('fvtt-token-dragging');
        if (api.map.dragging && !api.map.dragging.enabled() && mapElement.dataset.rpgMovementDisabledDragging === 'true') {
          api.map.dragging.enable();
        }
        delete mapElement.dataset.rpgMovementDisabledDragging;
        if (mode === 'click' && previousTool && api.getTool?.() === 'token-move') api.setTool?.(previousTool);
        if (message) status(message);
      }

      async function fastValidate(tokenId, target, from = null) {
        const fn = api.movementFast?.validateTokenMove || api.movement.validateTokenMove;
        return fn?.(tokenId, target, from ? { from } : {}) || { valid: false, reason: '无法校验移动' };
      }

      async function fastMove(tokenId, target) {
        const fn = api.movementFast?.moveTokenTo || api.movement.moveTokenTo;
        return fn?.(tokenId, target) || { valid: false, reason: '移动接口不可用' };
      }

      async function commitDirect(target) {
        const current = interaction;
        if (!current || current.pending) return false;
        current.pending = true;
        const members = current.members || [];
        try {
          if (members.length > 1) {
            const planned = await api.movement.planTokenGroupMove?.(
              members.map(member => member.tokenId), current.tokenId, [current.start, target],
            );
            if (!planned?.valid) {
              drawPreview(target, { valid: false });
              status('群组移动失败：至少一个 Token 的路径不可通行');
              current.pending = false;
              return false;
            }
            drawPreview(target, { valid: true });
            if (!api.movement.commitTokenGroupMove?.()) {
              status('群组移动提交失败');
              current.pending = false;
              return false;
            }
            suppressClickUntil = Date.now() + 250;
            status(`群组 ${members.length} Token 移动已提交`);
            reset();
            return true;
          }

          const result = await fastMove(current.tokenId, target);
          if (!result?.valid) {
            drawPreview(target, { valid: false });
            status(`移动失败：${result?.reason || '当前位置不可通行'}`);
            current.pending = false;
            return false;
          }
          drawPreview(target, { valid: true });
          suppressClickUntil = Date.now() + 250;
          status(`Token 已移动 ${formatDistance(Number(result.distance) || 0)}`);
          reset();
          return true;
        } catch (error) {
          current.pending = false;
          status(`移动失败：${error?.message || String(error)}`);
          return false;
        }
      }

      function updateDragPreview() {
        pointerFrame = null;
        const current = interaction;
        const point = pendingPointerClient;
        pendingPointerClient = null;
        if (!current || current.mode !== 'drag' || current.pending || !point) return;
        const raw = worldPointFromClient(point);
        if (!inside(raw, api.mapPackage)) return;
        const target = snapPoint(raw);
        current.current = target;
        drawPreview(target, { valid: true });
      }

      function scheduleDragPreview(point) {
        pendingPointerClient = point;
        if (pointerFrame !== null) return;
        pointerFrame = requestFrame(updateDragPreview);
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
        if (!beginInteraction(token, { mode: 'drag', client: clientPoint(event) })) return;
        if (api.map.dragging?.enabled?.()) {
          api.map.dragging.disable();
          mapElement.dataset.rpgMovementDisabledDragging = 'true';
        }
        mapElement.classList.add('fvtt-token-dragging');
      }

      function pointerMove(event) {
        if (!interaction || interaction.mode !== 'drag' || interaction.pending) return;
        const point = clientPoint(event);
        if (!interaction.dragged) {
          if (distancePixels(interaction.clientStart, point) < DRAG_THRESHOLD_PX) return;
          interaction.dragged = true;
        }
        event.preventDefault();
        event.stopPropagation();
        scheduleDragPreview(point);
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
        suppressClickUntil = Date.now() + 250;
        const raw = worldPointFromClient(clientPoint(event));
        const target = inside(raw, api.mapPackage) ? snapPoint(raw) : current.current;
        current.current = target;
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

      function scheduleKeyboardProcessing() {
        if (keyboardFrame !== null || keyboardRunning || destroyed) return;
        keyboardFrame = requestFrame(() => {
          keyboardFrame = null;
          void processKeyboardQueue();
        });
      }

      async function processKeyboardQueue() {
        if (keyboardRunning || destroyed) return;
        keyboardRunning = true;
        try {
          while (keyboardQueue.length && !destroyed) {
            const segment = keyboardQueue.shift();
            const token = mapToken(api.selection.getPrimaryTokenId?.());
            if (!token) {
              keyboardQueue.length = 0;
              status('请先选择一个位于地图上的 Token');
              break;
            }
            const count = Math.max(1, Math.min(MAX_KEYBOARD_STEPS, Number(segment.count) || 1));
            const target = snapPoint({
              x: Number(token.x) + segment.x * settings.step * count,
              y: Number(token.y) + segment.y * settings.step * count,
            });
            const result = await fastMove(token.id, target);
            if (!result?.valid) {
              keyboardQueue.length = 0;
              status(`移动失败：${result?.reason || '当前位置不可通行'}`);
              break;
            }
            status(`WASD 移动 ${formatDistance(Number(result.distance) || settings.step * count)} · 队列 ${keyboardQueue.reduce((sum, item) => sum + item.count, 0)}`);
          }
        } finally {
          keyboardRunning = false;
          if (keyboardQueue.length) scheduleKeyboardProcessing();
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
          w: { x: 0, y: -1 }, a: { x: -1, y: 0 },
          s: { x: 0, y: 1 }, d: { x: 1, y: 0 },
        }[event.key.toLowerCase()];
        if (!direction) return;
        if (!mapToken(api.selection.getPrimaryTokenId?.())) {
          status('请先选择一个位于地图上的 Token');
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const queuedSteps = keyboardQueue.reduce((sum, item) => sum + item.count, 0);
        if (queuedSteps >= MAX_KEYBOARD_STEPS) return;
        const last = keyboardQueue.at(-1);
        if (sameDirection(last, direction)) last.count += 1;
        else keyboardQueue.push({ ...direction, count: 1 });
        scheduleKeyboardProcessing();
      }

      function mapClick(event) {
        if (!interaction || interaction.mode !== 'click' || interaction.pending) return;
        if (event.target?.closest?.('.leaflet-control,.rpg-token-v2,[data-token-id]')) return;
        const raw = worldPointFromClient(clientPoint(event));
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
        settings.cycle(event.deltaY > 0 ? 1 : -1, { source: 'wheel' });
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
            : await fastValidate(interaction.tokenId, interaction.current, interaction.start);
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

      const selectionOff = api.selection.subscribe?.(snapshot => {
        if (!interaction || interaction.pending) return;
        const primary = snapshot?.primaryId || api.selection.getPrimaryTokenId?.() || null;
        if (String(primary || '') !== String(interaction.tokenId)) reset();
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
        if (keyboardFrame !== null) cancelFrame(keyboardFrame);
        keyboardFrame = null;
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
      }));
    },
  });
}
