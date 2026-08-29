import L from 'leaflet';
import { latLngToWorld, worldToLatLng, formatDistance } from '../engine/geometry.js';
import { calculateWaypointRoute } from './path.js';
import { TokenDragPhase, TokenDragPlan } from './state.js';
import { createMovementRouteInspector } from './route-inspector.js';
import { snapMovementPoint } from './snap.js';

const DRAG_THRESHOLD_PX = 5;
const LIVE_ROUTE_DELAY_MS = 70;

function inside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

function createConfirmControls(documentNode, mapElement) {
  const controls = documentNode.createElement('div');
  controls.className = 'fvtt-move-confirm';
  Object.assign(controls.style, {
    position: 'absolute', left: '50%', bottom: '44px', transform: 'translateX(-50%)',
    display: 'none', gap: '8px', alignItems: 'center', zIndex: '1200', padding: '8px 10px',
    borderRadius: '10px', background: 'rgba(30,34,38,.9)', boxShadow: '0 6px 20px rgba(0,0,0,.24)',
  });
  const confirm = documentNode.createElement('button');
  confirm.type = 'button'; confirm.className = 'small-button primary'; confirm.textContent = '确认移动';
  const cancel = documentNode.createElement('button');
  cancel.type = 'button'; cancel.className = 'small-button'; cancel.textContent = '取消';
  const hint = documentNode.createElement('span');
  hint.style.cssText = 'color:#fff;font-size:12px;opacity:.78;'; hint.textContent = 'Enter 确认 · Esc 取消';
  controls.append(confirm, cancel, hint);
  const host = mapElement.parentElement;
  if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host?.append(controls);
  return { controls, confirm, cancel };
}

function tokenIdFromTarget(target) {
  const root = target?.closest?.('.rpg-token-v2');
  return root?.querySelector?.('[data-token-id]')?.dataset?.tokenId || null;
}

export function createMovementControllerV3({ settings } = {}) {
  return Object.freeze({
    register(api) {
      if (!settings) throw new Error('Movement V3 requires MovementSettings');
      if (!api.movement?.canonicalSceneTokens || !api.tokens?.get || !api.selection) {
        throw new Error('Movement V3 requires canonical Token Runtime');
      }

      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const routeLayer = L.layerGroup([], { pane: 'measurePane' }).addTo(api.map);
      const controls = createConfirmControls(documentNode, mapElement);
      const routeInspector = createMovementRouteInspector(api);
      const drag = new TokenDragPlan();
      let selectedTokenId = api.selection.getPrimaryTokenId?.() || null;
      let moving = false;
      let routeRequest = 0;
      let routeTimer = null;
      let pendingPoint = null;
      let suppressClickUntil = 0;
      let restoreMapDragging = false;
      let previousTool = 'pan';
      let destroyed = false;
      const off = [];

      const status = message => api.setStatus?.(message);
      const showControls = value => { controls.controls.style.display = value ? 'flex' : 'none'; };
      const token = tokenId => tokenId ? api.tokens.get(tokenId) : null;
      const mapToken = tokenId => {
        const value = token(tokenId);
        return value?.placement === 'map' ? value : null;
      };
      const worldPoint = event => latLngToWorld(api.map.mouseEventToLatLng(event), api.mapPackage.height);
      const snapPoint = point => {
        const snapped = snapMovementPoint(point, settings.step);
        return {
          x: Math.max(0, Math.min(api.mapPackage.width, snapped.x)),
          y: Math.max(0, Math.min(api.mapPackage.height, snapped.y)),
        };
      };

      function clearRouteTimer() {
        if (routeTimer) clearTimeout(routeTimer);
        routeTimer = null;
        pendingPoint = null;
      }

      function draw(route) {
        routeLayer.clearLayers();
        if (!drag.session) return;
        const points = Array.isArray(route?.points) ? route.points : [];
        if (points.length > 1) {
          L.polyline(points.map(point => worldToLatLng(point, api.mapPackage.height)), {
            pane: 'measurePane', color: '#176d76', weight: 4, dashArray: '10 7', interactive: false,
            className: 'token-route-preview',
          }).addTo(routeLayer);
        }
        if (route?.valid === false) {
          const from = route.controls?.[route.failedSegmentIndex];
          const to = route.controls?.[route.failedSegmentIndex + 1];
          if (from && to) {
            L.polyline([worldToLatLng(from, api.mapPackage.height), worldToLatLng(to, api.mapPackage.height)], {
              pane: 'measurePane', color: '#b52f2a', weight: 4, dashArray: '5 8', interactive: false,
              className: 'token-route-preview token-route-blocked',
            }).addTo(routeLayer);
          }
          const blocker = route.inspection?.blockingCell;
          if (blocker) {
            L.rectangle([
              worldToLatLng({ x: blocker.x, y: blocker.y + 1 }, api.mapPackage.height),
              worldToLatLng({ x: blocker.x + 1, y: blocker.y }, api.mapPackage.height),
            ], {
              pane: 'measurePane', color: '#b52f2a', weight: 2,
              fillColor: '#b52f2a', fillOpacity: .34, interactive: false,
            }).addTo(routeLayer);
          }
        }
        drag.session.waypoints.forEach((point, index) => {
          L.circleMarker(worldToLatLng(point, api.mapPackage.height), {
            pane: 'measurePane', radius: 5, color: '#176d76', weight: 2,
            fillColor: '#ffffff', fillOpacity: 1, interactive: false,
          }).bindTooltip(`拐点 ${index + 1}`, { direction: 'top' }).addTo(routeLayer);
        });
        const endpoint = route?.destination || drag.current;
        if (endpoint) {
          const color = route?.valid === false ? '#b52f2a' : '#176d76';
          L.circleMarker(worldToLatLng(endpoint, api.mapPackage.height), {
            pane: 'measurePane', radius: 9, color, weight: 2,
            fillColor: color, fillOpacity: .2, interactive: false,
          }).addTo(routeLayer);
          if (route) {
            L.tooltip({ permanent: true, direction: 'top', className: 'marker-tooltip', pane: 'measurePane' })
              .setLatLng(worldToLatLng(endpoint, api.mapPackage.height))
              .setContent(route.valid
                ? `${formatDistance(Number(route.distance) || 0)}${drag.session.waypoints.length ? ` · ${drag.session.waypoints.length} 拐点` : ''}`
                : `第 ${Number(route.failedSegmentIndex || 0) + 1} 段受阻`)
              .addTo(routeLayer);
          }
        }
      }

      function reset(message = '') {
        const wasActive = drag.active || moving;
        routeRequest += 1;
        clearRouteTimer();
        api.movement.cancelPending?.();
        moving = false;
        drag.reset();
        routeLayer.clearLayers();
        showControls(false);
        mapElement.classList.remove('fvtt-token-dragging');
        mapElement.style.cursor = '';
        if (restoreMapDragging) api.map.dragging.enable();
        restoreMapDragging = false;
        if (wasActive && api.getTool?.() === 'token-move') api.setTool?.(previousTool || 'pan');
        if (message) status(message);
      }

      function beginSession(current, { pointerId = null, client = null, phase = TokenDragPhase.PLANNING } = {}) {
        if (!current || current.placement !== 'map') return false;
        settings.beginSession(api.map, api.mapPackage);
        drag.begin({
          tokenId: current.id,
          start: { x: Number(current.x), y: Number(current.y) },
          pointerId,
          client,
          snapStep: settings.step,
        });
        if (phase === TokenDragPhase.PLANNING) drag.continuePlanning();
        return true;
      }

      async function calculate(rawPoint, { ready = false } = {}) {
        if (!drag.session || !inside(rawPoint, api.mapPackage)) return null;
        const point = snapPoint(rawPoint);
        const request = ++routeRequest;
        drag.update(point, drag.route, rawPoint);
        drag.session.setSnapStep(settings.step);
        const route = await calculateWaypointRoute({
          session: drag.session,
          destination: point,
          findPath: (from, to) => routeInspector.findSegment(drag.tokenId, from, to),
        });
        if (!route.valid) {
          const from = route.controls?.[route.failedSegmentIndex];
          const to = route.controls?.[route.failedSegmentIndex + 1];
          if (from && to) route.inspection = routeInspector.inspectSegment(drag.tokenId, from, to);
        }
        if (request !== routeRequest || !drag.session) return null;
        drag.setRoute(route);
        draw(route);
        if (route.valid) {
          if (ready) drag.ready(route);
          const action = drag.phase === TokenDragPhase.READY
            ? ' · 确认移动 / Enter'
            : drag.nextClickCreatesWaypoint
              ? ' · 左键设置第 1 个拐点'
              : ' · Ctrl/Cmd+点击或 F 添加拐点';
          status(`直线路线 ${formatDistance(Number(route.distance) || 0)} · 吸附 ${settings.step} m · ${drag.session.waypoints.length} 个拐点${action}`);
        } else {
          status('直线路径受阻 · Ctrl/Cmd+点击添加可通行拐点，右键或 Alt+F 撤销');
        }
        showControls(drag.phase === TokenDragPhase.READY && route.valid);
        return route;
      }

      function scheduleCalculate(point) {
        pendingPoint = point;
        if (routeTimer) return;
        routeTimer = setTimeout(async () => {
          routeTimer = null;
          const target = pendingPoint;
          pendingPoint = null;
          if (target && drag.active && ![TokenDragPhase.READY, TokenDragPhase.MOVING].includes(drag.phase)) {
            await calculate(target);
          }
        }, LIVE_ROUTE_DELAY_MS);
      }

      function waypointStart() {
        return drag.session?.waypoints.at(-1) || drag.session?.start || null;
      }

      function showBlockedWaypoint(candidate) {
        const start = waypointStart();
        if (!start || !drag.session) return;
        const route = {
          valid: false,
          controls: [drag.session.start, ...drag.session.waypoints, candidate],
          points: [drag.session.start, ...drag.session.waypoints],
          failedSegmentIndex: drag.session.waypoints.length,
          distance: Math.hypot(candidate.x - start.x, candidate.y - start.y),
          destination: candidate,
          inspection: routeInspector.inspectSegment(drag.tokenId, start, candidate),
        };
        drag.setRoute(route);
        draw(route);
        showControls(false);
        status('拐点直线路径受阻 · 请换一个位置，或右键 / Alt+F 撤销上一个拐点');
      }

      async function addWaypointAt(rawPoint) {
        if (!drag.session || moving) return false;
        const candidate = snapPoint(rawPoint);
        const start = waypointStart();
        const directLeg = start && await routeInspector.findSegment(drag.tokenId, start, candidate);
        if (!directLeg) {
          showBlockedWaypoint(candidate);
          return false;
        }
        drag.addWaypoint(directLeg.destination || candidate);
        const route = await calculate(directLeg.destination || candidate);
        if (!route?.valid) return false;
        showControls(false);
        status(`已添加拐点 ${drag.session.waypoints.length} · 移动鼠标继续规划；Ctrl/Cmd+点击或 F 可继续添加`);
        return true;
      }

      async function addWaypointAtCurrent() {
        if (!drag.session || moving) return false;
        return addWaypointAt(drag.session.rawPointer || drag.session.current || drag.current);
      }

      async function removeWaypoint() {
        if (!drag.session || moving) return false;
        const rawPoint = drag.session.rawPointer || drag.current;
        const removed = drag.removeWaypoint();
        if (!removed) return false;
        showControls(false);
        await calculate(rawPoint);
        status(`已撤销最近拐点 · 剩余 ${drag.session.waypoints.length} 个`);
        return true;
      }

      function waitForTokenMove(tokenId) {
        return new Promise(resolve => {
          let offMoved = null;
          let offCancelled = null;
          const done = value => {
            offMoved?.();
            offCancelled?.();
            resolve(value);
          };
          offMoved = api.on?.('token:move', event => {
            if (String(event.detail?.tokenId || event.detail?.id || '') !== String(tokenId)) return;
            done(true);
          });
          offCancelled = api.on?.('token:move-cancelled', event => {
            if (String(event.detail?.tokenId || event.detail?.id || '') !== String(tokenId)) return;
            done(false);
          });
        });
      }

      async function commit() {
        if (moving || drag.phase !== TokenDragPhase.READY || !drag.route?.valid) return false;
        const tokenId = drag.tokenId;
        const targets = drag.movementTargets();
        if (!targets.length || !drag.startMoving()) return false;
        moving = true;
        showControls(false);
        routeLayer.clearLayers();
        status('正在沿规划路径移动…');
        for (const target of targets) {
          const route = await api.movement.planTokenMove(tokenId, target);
          if (!route) {
            reset('移动中止：执行时有一段路径已不可通行');
            return false;
          }
          const moved = waitForTokenMove(tokenId);
          if (!api.movement.commitTokenMove()) {
            reset('移动中止：当前路线无法提交');
            return false;
          }
          if (!await moved) {
            reset('移动未获服务器确认，已恢复服务器状态');
            return false;
          }
        }
        const waypointCount = drag.session?.waypoints.length || 0;
        reset(`Token 移动完成 · ${waypointCount} 个拐点`);
        return true;
      }

      function begin(tokenId = selectedTokenId) {
        const current = mapToken(tokenId);
        if (!current) {
          status('请先选择一个位于地图上的 Token');
          return false;
        }
        if (drag.active || moving) reset();
        selectedTokenId = String(current.id);
        api.selection.replace?.([current.id], current.id);
        previousTool = api.getTool?.() || 'pan';
        api.setTool?.('token-move');
        if (!beginSession(current, { phase: TokenDragPhase.PLANNING })) return false;
        status(`移动 Token：移动鼠标规划终点 · Ctrl/Cmd+点击或 F 添加拐点 · 当前吸附 ${settings.step} m`);
        return true;
      }

      async function plan(tokenId, rawPoint) {
        if (!drag.active || String(drag.tokenId) !== String(tokenId)) {
          if (!begin(tokenId)) return null;
        }
        return calculate(rawPoint, { ready: true });
      }

      function beginTokenDrag(event) {
        if (destroyed || event.button !== 0 || moving) return;
        const tokenId = tokenIdFromTarget(event.target);
        const current = mapToken(tokenId);
        if (!current) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        selectedTokenId = String(current.id);
        api.selection.replace?.([current.id], current.id);
        previousTool = api.getTool?.() || 'pan';
        api.setTool?.('token-move');
        if (!beginSession(current, {
          pointerId: event.pointerId,
          client: { x: event.clientX, y: event.clientY },
          phase: TokenDragPhase.DRAGGING,
        })) return;
        restoreMapDragging = api.map.dragging.enabled();
        if (restoreMapDragging) api.map.dragging.disable();
        mapElement.setPointerCapture?.(event.pointerId);
        mapElement.classList.add('fvtt-token-dragging');
        mapElement.style.cursor = 'grabbing';
        status('拖动 Token 规划路线 · Ctrl/Cmd+松开进入拐点规划 · F 添加拐点 · Esc 取消');
      }

      function moveTokenDrag(event) {
        if (!drag.active || moving) return;
        if (drag.phase === TokenDragPhase.DRAGGING && event.pointerId !== drag.pointerId) return;
        if ([TokenDragPhase.READY, TokenDragPhase.MOVING].includes(drag.phase)) return;
        const point = worldPoint(event);
        if (!inside(point, api.mapPackage)) return;
        drag.update(snapPoint(point), drag.route, point);
        scheduleCalculate(point);
        if (drag.phase === TokenDragPhase.DRAGGING) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }

      async function endTokenDrag(event) {
        if (drag.phase !== TokenDragPhase.DRAGGING || event.pointerId !== drag.pointerId || moving) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        mapElement.releasePointerCapture?.(event.pointerId);
        mapElement.classList.remove('fvtt-token-dragging');
        mapElement.style.cursor = '';
        if (restoreMapDragging) api.map.dragging.enable();
        restoreMapDragging = false;
        suppressClickUntil = performance.now() + 250;
        const dragged = drag.draggedPixels({ x: event.clientX, y: event.clientY });
        if (dragged < DRAG_THRESHOLD_PX) {
          reset('已选择 Token · 直接拖动 Token 可规划移动');
          return;
        }
        const waypointPlanning = event.ctrlKey || event.metaKey;
        const point = worldPoint(event);
        const route = await calculate(point);
        if (!route?.valid) {
          drag.continuePlanning({ nextClickCreatesWaypoint: waypointPlanning });
          status(waypointPlanning
            ? '已进入拐点规划 · 松开位置不计为拐点；移动到可通行位置后左键设置第 1 个拐点'
            : '当前位置不可通行 · 移动鼠标重选终点，Esc 取消');
          return;
        }
        if (waypointPlanning) {
          drag.continuePlanning({ nextClickCreatesWaypoint: true });
          drag.setRoute(route);
          draw(route);
          showControls(false);
          status('已进入拐点规划 · 松开位置只是预览；下一次左键点击设置第 1 个拐点');
          return;
        }
        drag.ready(route);
        draw(route);
        showControls(true);
        status(`路线已就绪 · ${formatDistance(Number(route.distance) || 0)} · 确认移动 / Enter，Esc 取消`);
      }

      async function planningClick(event) {
        if (moving || performance.now() < suppressClickUntil) {
          if (drag.active) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          return;
        }
        if (!drag.active) {
          if (api.getTool?.() !== 'token-move' || !selectedTokenId) return;
          const current = mapToken(selectedTokenId);
          if (!current) return;
          previousTool = 'pan';
          if (!beginSession(current, { phase: TokenDragPhase.PLANNING })) return;
        }
        if (![TokenDragPhase.PLANNING, TokenDragPhase.READY].includes(drag.phase)) return;
        if (event.target?.closest?.('.fvtt-move-confirm')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const point = worldPoint(event);
        if (!inside(point, api.mapPackage)) return;
        const firstPostDragWaypoint = drag.nextClickCreatesWaypoint;
        if (firstPostDragWaypoint || event.ctrlKey || event.metaKey) {
          const added = await addWaypointAt(point);
          if (added) {
            status(firstPostDragWaypoint
              ? '已设置第 1 个拐点 · 继续移动光标规划；Ctrl/Cmd+点击或 F 可继续添加，普通点击设置终点'
              : `已添加拐点 ${drag.session.waypoints.length} · 继续移动光标规划`);
          }
          return;
        }
        const route = await calculate(point);
        if (!route?.valid) return;
        drag.ready(route);
        draw(route);
        showControls(true);
        status(`最终终点已设置 · ${formatDistance(Number(route.distance) || 0)} · 确认移动 / Enter`);
      }

      async function planningContextMenu(event) {
        if (!drag.active || moving) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!(await removeWaypoint())) status('没有可撤销的拐点 · Esc 可取消整次规划');
      }

      async function wheel(event) {
        if (!drag.active || moving) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const direction = event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0;
        if (!direction) return;
        const previous = settings.step;
        const next = settings.cycle(direction, { source: 'wheel' });
        if (next === previous || !drag.session) return;
        drag.session.setSnapStep(next);
        const rawPoint = drag.session.rawPointer || drag.current;
        if (drag.phase === TokenDragPhase.READY) {
          drag.continuePlanning();
          showControls(false);
        }
        await calculate(rawPoint);
        status(`移动吸附 ${next} m · 滚轮继续切档 · 已有拐点保持不动`);
      }

      async function keydown(event) {
        if (!drag.active || moving) return;
        if (event.defaultPrevented || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          reset('已取消 Token 移动规划');
          return;
        }
        if (event.key === 'Enter' && drag.phase === TokenDragPhase.READY) {
          event.preventDefault();
          event.stopImmediatePropagation();
          await commit();
          return;
        }
        if (event.key.toLowerCase() === 'f') {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.altKey) await removeWaypoint();
          else await addWaypointAtCurrent();
        }
      }

      controls.confirm.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void commit();
      });
      controls.cancel.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        reset('已取消 Token 移动规划');
      });
      mapElement.addEventListener('pointerdown', beginTokenDrag, true);
      mapElement.addEventListener('pointermove', moveTokenDrag, true);
      mapElement.addEventListener('pointerup', endTokenDrag, true);
      mapElement.addEventListener('pointercancel', () => reset('已取消 Token 移动规划'), true);
      mapElement.addEventListener('click', planningClick, true);
      mapElement.addEventListener('contextmenu', planningContextMenu, true);
      mapElement.addEventListener('wheel', wheel, { capture: true, passive: false });
      documentNode.addEventListener('keydown', keydown, true);

      const selectionOff = api.selection.subscribe?.(snapshot => {
        const next = snapshot?.primaryId || null;
        if (drag.active && next && String(next) !== String(drag.tokenId) && !moving) {
          reset('已切换 Token，移动规划取消');
        }
        selectedTokenId = next;
      });
      if (selectionOff) off.push(selectionOff);

      for (const eventName of [
        'state:import', 'scene:damage', 'scene:restore', 'scene:undo',
        'status:change', 'token:size-change', 'elevation:token-change',
      ]) {
        off.push(api.on?.(eventName, () => {
          routeInspector.invalidate();
          if (drag.active && !moving) reset('World 状态已变化，请重新规划移动');
        }));
      }
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        clearRouteTimer();
        mapElement.removeEventListener('pointerdown', beginTokenDrag, true);
        mapElement.removeEventListener('pointermove', moveTokenDrag, true);
        mapElement.removeEventListener('pointerup', endTokenDrag, true);
        mapElement.removeEventListener('click', planningClick, true);
        mapElement.removeEventListener('contextmenu', planningContextMenu, true);
        mapElement.removeEventListener('wheel', wheel, true);
        documentNode.removeEventListener('keydown', keydown, true);
        controls.controls.remove();
        routeLayer.clearLayers();
        api.map.removeLayer?.(routeLayer);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.movementUi = Object.freeze({
        tokenFirst: true,
        v163Interaction: true,
        begin,
        plan,
        commit,
        cancel: reset,
        addWaypoint: addWaypointAtCurrent,
        removeWaypoint,
        get activeTokenId() { return drag.tokenId || null; },
        get phase() { return drag.phase; },
      });
      status('浏览模式：拖动地图；直接拖动 Token 可规划移动，规划中滚轮切换吸附档位');
    },
  });
}
