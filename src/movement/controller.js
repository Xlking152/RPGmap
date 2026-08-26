import L from 'leaflet';
import { latLngToWorld, worldToLatLng, formatDistance } from '../engine/geometry.js';
import {
  createNavigationBase,
  createNavigationGrid,
  findDirectNavigationPath,
  inspectDirectNavigationPath,
} from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import { moverContextForCharacter, tokenDiameterMeters } from '../elevation/model.js';
import { calculateWaypointRoute } from './path.js';
import { TokenDragPhase, TokenDragPlan } from './state.js';
import { snapMovementPoint } from './snap.js';

const DRAG_THRESHOLD_PX = 5;
const LIVE_ROUTE_DELAY_MS = 70;

function mapCharacter(state, id) {
  return state.characters?.find(item => item.id === id && item.location?.type === 'map') || null;
}

function pointInside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

function nearestMapCharacter(state, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const character of state.characters || []) {
    if (character.location?.type !== 'map' || character.visible === false) continue;
    const distance = Math.hypot(character.location.x - point.x, character.location.y - point.y);
    if (distance < bestDistance) {
      best = character;
      bestDistance = distance;
    }
  }
  return best;
}

function createConfirmControls(mapElement) {
  const controls = document.createElement('div');
  controls.className = 'fvtt-move-confirm';
  Object.assign(controls.style, {
    position: 'absolute', left: '50%', bottom: '44px', transform: 'translateX(-50%)',
    display: 'none', gap: '8px', alignItems: 'center', zIndex: '1200', padding: '8px 10px',
    borderRadius: '10px', background: 'rgba(30, 34, 38, 0.9)', boxShadow: '0 6px 20px rgba(0,0,0,.24)',
  });
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'small-button primary';
  confirm.textContent = '确认移动';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'small-button';
  cancel.textContent = '取消';
  const hint = document.createElement('span');
  hint.style.cssText = 'color:#fff;font-size:12px;opacity:.78;';
  hint.textContent = 'Enter 确认 · Esc 取消';
  controls.append(confirm, cancel, hint);
  const host = mapElement.parentElement;
  if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host?.append(controls);
  return { controls, confirm, cancel };
}

export function createMovementController({ settings } = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const shell = mapElement.closest('.app-shell') || document;
      const previewLayer = L.layerGroup([], { pane: 'measurePane' }).addTo(api.map);
      const staticBase = createNavigationBase(api.mapPackage);
      const drag = new TokenDragPlan();
      if (!settings) throw new Error('MovementController requires MovementSettings');
      const controls = createConfirmControls(mapElement);
      let routeRequest = 0;
      let routeTimer = null;
      let pendingPoint = null;
      let moving = false;
      let suppressClickUntil = 0;
      let restoreMapDragging = false;
      let previousTool = 'pan';
      let navigationGrid = null;
      let navigationRevision = null;
      let selectedCharacterId = null;

      const status = message => {
        const node = shell.querySelector?.('[data-role="map-status"]');
        if (node) node.textContent = message;
      };
      const showControls = visible => { controls.controls.style.display = visible ? 'flex' : 'none'; };
      const clearRouteTimer = () => {
        if (routeTimer) clearTimeout(routeTimer);
        routeTimer = null;
        pendingPoint = null;
      };
      const invalidateNavigation = () => { navigationGrid = null; navigationRevision = null; };
      const navigation = (characterId = drag.characterId || selectedCharacterId) => {
        const appState = api.getState();
        const moverContext = moverContextForCharacter(appState, characterId);
        const revision = JSON.stringify({
          sceneEvents: appState.sceneEvents || [],
          featureStates: appState.preferences?.featureStates || {},
          moverContext,
        });
        if (!navigationGrid || navigationRevision !== revision) {
          navigationGrid = createNavigationGrid(
            api.mapPackage,
            deriveSceneState(appState.sceneEvents),
            staticBase,
            { appState, moverContext },
          );
          navigationRevision = revision;
        }
        return navigationGrid;
      };
      const findPath = (from, to) => findDirectNavigationPath(navigation(), from, to);
      const inspectPath = (from, to) => inspectDirectNavigationPath(navigation(), from, to);
      const clampMovementPoint = point => ({
        x: Math.max(0, Math.min(api.mapPackage.width, point.x)),
        y: Math.max(0, Math.min(api.mapPackage.height, point.y)),
      });
      const snapPointer = rawPoint => clampMovementPoint(snapMovementPoint(rawPoint, settings.step));

      function canControlCharacter(character) {
        const multiplayer = api.multiplayer?.getStatus?.();
        if (!multiplayer?.connected) return true;
        return api.multiplayer?.canControlCharacter?.(character?.id) !== false;
      }

      function movementCapability(character) {
        if (!character) return { canMove: false, reasons: ['角色不存在'] };
        try {
          return api.status?.resolveCapabilities?.({ characterId: character.id })
            || { canMove: true, reasons: [] };
        } catch {
          // A status rendering failure must fail closed for movement rather than
          // allowing a stale preview to bypass an immobilizing condition.
          return { canMove: false, reasons: ['无法确认角色状态'] };
        }
      }

      function canMoveCharacter(character) {
        return canControlCharacter(character) && movementCapability(character).canMove !== false;
      }

      function permissionMessage() {
        const multiplayer = api.multiplayer?.getStatus?.();
        const active = api.getState()?.preferences?.combatSystem?.combat?.state === 'active';
        return active && multiplayer?.session?.role === 'player'
          ? '当前无法移动该角色：你需要 OWNER 权限，并且战斗中必须轮到该角色行动'
          : '当前无法移动该角色：你没有该 Actor 的 OWNER 权限';
      }

      function movementDeniedMessage(character) {
        if (!canControlCharacter(character)) return permissionMessage();
        const capability = movementCapability(character);
        const reason = Array.isArray(capability.reasons) ? capability.reasons.find(Boolean) : '';
        return reason ? `当前无法移动该角色：${reason}` : '当前状态禁止该角色移动';
      }

      function beginSessionForCharacter(character, { pointerId = null, client = null, phase = TokenDragPhase.PLANNING } = {}) {
        if (!character || character.location?.type !== 'map') return false;
        if (!canMoveCharacter(character)) { status(movementDeniedMessage(character)); return false; }
        settings.beginSession(api.map, api.mapPackage);
        drag.begin({ characterId: character.id, start: character.location, pointerId, client, snapStep: settings.step });
        if (phase === TokenDragPhase.PLANNING) drag.continuePlanning();
        return true;
      }

      function pathWeight(character = null) {
        const diameter = character ? tokenDiameterMeters(api.getState(), character.id) : 1;
        const origin = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
        const unit = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
        return Math.max(2, diameter * Math.hypot(unit.x - origin.x, unit.y - origin.y));
      }

      function draw(route, character = null) {
        previewLayer.clearLayers();
        if (!drag.session) return;
        const routePoints = route?.points || [];
        if (routePoints.length > 1) {
          L.polyline(routePoints.map(point => worldToLatLng(point, api.mapPackage.height)), {
            pane: 'measurePane', color: '#176d76', weight: pathWeight(character), dashArray: '10 7', interactive: false,
            className: 'character-route-preview',
          }).addTo(previewLayer);
        }
        if (route && !route.valid) {
          const from = route.controls?.[route.failedSegmentIndex];
          const to = route.controls?.[route.failedSegmentIndex + 1];
          if (from && to) {
          L.polyline([worldToLatLng(from, api.mapPackage.height), worldToLatLng(to, api.mapPackage.height)], {
            pane: 'measurePane', color: '#b52f2a', weight: pathWeight(character), dashArray: '5 8', interactive: false,
            className: 'character-route-preview character-route-blocked',
            }).addTo(previewLayer);
          }
        }
        const blocker = route?.inspection?.blockingCell;
        if (route?.valid === false && blocker) {
          L.rectangle([
            worldToLatLng({ x: blocker.x, y: blocker.y + 1 }, api.mapPackage.height),
            worldToLatLng({ x: blocker.x + 1, y: blocker.y }, api.mapPackage.height),
          ], {
            pane: 'measurePane', color: '#b52f2a', weight: 2, fillColor: '#b52f2a', fillOpacity: 0.4, interactive: false,
            className: 'character-route-blocked-cell',
          }).addTo(previewLayer);
        }
        drag.session.waypoints.forEach((point, index) => {
          L.circleMarker(worldToLatLng(point, api.mapPackage.height), {
            pane: 'measurePane', radius: 5, color: '#176d76', weight: 2,
            fillColor: '#ffffff', fillOpacity: 1, interactive: false,
          }).bindTooltip('拐点 ' + (index + 1), { direction: 'top' }).addTo(previewLayer);
        });
        const endpoint = route?.destination || drag.current;
        if (endpoint) {
          const color = route?.valid === false ? '#b52f2a' : (character?.color || '#176d76');
          L.circleMarker(worldToLatLng(endpoint, api.mapPackage.height), {
            pane: 'measurePane', radius: 9, color, weight: 2, fillColor: color, fillOpacity: 0.22, interactive: false,
          }).addTo(previewLayer);
          if (route) {
            L.tooltip({ permanent: true, direction: 'top', className: 'marker-tooltip', pane: 'measurePane' })
              .setLatLng(worldToLatLng(endpoint, api.mapPackage.height))
              .setContent(route.valid
                ? formatDistance(route.distance) + (drag.session.waypoints.length ? ' · ' + drag.session.waypoints.length + ' 拐点' : '')
                : '第 ' + (route.failedSegmentIndex + 1) + ' 段受阻')
              .addTo(previewLayer);
          }
        }
      }

      function reset(message = '') {
        const wasActive = drag.active || moving;
        routeRequest += 1;
        clearRouteTimer();
        moving = false;
        drag.reset();
        previewLayer.clearLayers();
        showControls(false);
        mapElement.classList.remove('fvtt-token-dragging');
        mapElement.style.cursor = '';
        if (restoreMapDragging) api.map.dragging.enable();
        restoreMapDragging = false;
        if (wasActive) api.setTool(previousTool || 'pan');
        if (message) status(message);
      }

      async function calculate(rawPoint, { ready = false } = {}) {
        if (!drag.session || !pointInside(rawPoint, api.mapPackage)) return null;
        const point = snapPointer(rawPoint);
        const currentRequest = ++routeRequest;
        drag.update(point, drag.route, rawPoint);
        drag.session.setSnapStep(settings.step);
        const route = await calculateWaypointRoute({
          session: drag.session,
          destination: point,
          findPath,
        });
        if (!route.valid) {
          const from = route.controls?.[route.failedSegmentIndex];
          const to = route.controls?.[route.failedSegmentIndex + 1];
          if (from && to) route.inspection = inspectPath(from, to);
        }
        if (currentRequest !== routeRequest || !drag.session) return null;
        drag.setRoute(route);
        draw(route, mapCharacter(api.getState(), drag.characterId));
        if (route.valid) {
          if (ready) drag.ready(route);
          const action = drag.phase === TokenDragPhase.READY
            ? ' · 点击“确认移动”或按 Enter'
            : drag.nextClickCreatesWaypoint
              ? ' · 左键点击设置第 1 个拐点'
              : ' · Ctrl/Cmd+点击或 F 添加拐点';
          status('直线路线 ' + formatDistance(route.distance)
            + ' · 吸附 ' + settings.step + ' m · ' + drag.session.waypoints.length + ' 个拐点' + action);
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
          if (target && drag.active && drag.phase !== TokenDragPhase.READY && drag.phase !== TokenDragPhase.MOVING) await calculate(target);
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
        };
        drag.setRoute(route);
        draw(route, mapCharacter(api.getState(), drag.characterId));
        showControls(false);
        status('拐点直线路径受阻 · 请换一个位置，或右键 / Alt+F 撤销上一个拐点');
      }

      async function addWaypointAt(rawPoint) {
        if (!drag.session || moving) return false;
        const candidate = snapPointer(rawPoint);
        const start = waypointStart();
        const directLeg = start && findPath(start, candidate);
        if (!directLeg) {
          showBlockedWaypoint(candidate);
          return false;
        }
        drag.addWaypoint(directLeg.destination);
        const route = await calculate(directLeg.destination);
        if (!route?.valid) return false;
        showControls(false);
        status('已添加拐点 ' + drag.session.waypoints.length + ' · 移动鼠标继续规划；Ctrl/Cmd+点击或 F 可继续添加');
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
        status('已撤销最近拐点 · 剩余 ' + drag.session.waypoints.length + ' 个');
        return true;
      }

      function waitForCharacterMove(characterId) {
        return new Promise(resolve => {
          const off = api.on('character:move', event => {
            if (event.detail?.id && event.detail.id !== characterId) return;
            off();
            offCancelled();
            resolve(true);
          });
          const offCancelled = api.on('character:move-cancelled', event => {
            if (event.detail?.id && event.detail.id !== characterId) return;
            off();
            offCancelled();
            resolve(false);
          });
        });
      }

      async function commit() {
        if (moving || drag.phase !== TokenDragPhase.READY || !drag.route?.valid) return false;
        const characterId = drag.characterId;
        const character = mapCharacter(api.getState(), characterId);
        if (!canMoveCharacter(character)) { reset(movementDeniedMessage(character)); return false; }
        const targets = drag.movementTargets();
        if (!targets.length || !drag.startMoving()) return false;
        moving = true;
        showControls(false);
        status('正在沿规划路径移动…');
        previewLayer.clearLayers();
        for (const target of targets) {
          const route = await api.planCharacterMove(characterId, target);
          if (!route) { reset('移动中止：执行时有一段路径已不可通行'); return false; }
          const moved = waitForCharacterMove(characterId);
          if (!api.commitCharacterMove()) { reset('移动中止：当前路线无法提交'); return false; }
          if (!await moved) { reset('移动未获服务器确认，已恢复服务器状态'); return false; }
        }
        const waypointCount = drag.session?.waypoints.length || 0;
        reset('角色移动完成 · ' + waypointCount + ' 个拐点');
        return true;
      }

      const worldPointFromPointer = event => latLngToWorld(api.map.mouseEventToLatLng(event), api.mapPackage.height);

      function beginTokenDrag(event) {
        if (event.button !== 0 || moving) return;
        const token = event.target.closest?.('.rpg-character, .rpg-character-core');
        if (!token) return;
        const point = worldPointFromPointer(event);
        const character = nearestMapCharacter(api.getState(), point);
        if (!character) return;
        if (!canMoveCharacter(character)) {
          status(movementDeniedMessage(character));
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        previousTool = shell.querySelector?.('[data-tool].active')?.dataset.tool || 'pan';
        api.selectCharacter(character.id);
        api.setTool('character-move');
        if (!beginSessionForCharacter(character, {
          pointerId: event.pointerId,
          client: { x: event.clientX, y: event.clientY },
          phase: TokenDragPhase.DRAGGING,
        })) return;
        restoreMapDragging = api.map.dragging.enabled();
        if (restoreMapDragging) api.map.dragging.disable();
        mapElement.setPointerCapture?.(event.pointerId);
        mapElement.classList.add('fvtt-token-dragging');
        mapElement.style.cursor = 'grabbing';
        status('拖动角色规划路线 · Ctrl/Cmd+松开进入拐点规划 · F 添加拐点 · Esc 取消');
      }

      function moveTokenDrag(event) {
        if (!drag.active || moving) return;
        if (drag.phase === TokenDragPhase.DRAGGING && event.pointerId !== drag.pointerId) return;
        if (drag.phase === TokenDragPhase.READY || drag.phase === TokenDragPhase.MOVING) return;
        const point = worldPointFromPointer(event);
        if (!pointInside(point, api.mapPackage)) return;
        drag.update(snapPointer(point), drag.route, point);
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
        if (dragged < DRAG_THRESHOLD_PX) { reset('已选择角色 · 拖动 Token 可直接规划移动'); return; }
        const waypointPlanning = event.ctrlKey || event.metaKey;
        const point = worldPointFromPointer(event);
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
          draw(route, mapCharacter(api.getState(), drag.characterId));
          showControls(false);
          status('已进入拐点规划 · 松开位置只是预览，不计为拐点；下一次左键点击设置第 1 个拐点');
          return;
        }
        drag.ready(route);
        draw(route, mapCharacter(api.getState(), drag.characterId));
        showControls(true);
        status('路线已就绪 · ' + formatDistance(route.distance) + ' · 确认移动 / Enter，Esc 取消');
      }

      async function planningClick(event) {
        if (moving || performance.now() < suppressClickUntil) {
          if (drag.active) { event.preventDefault(); event.stopImmediatePropagation(); }
          return;
        }
        if (!drag.active) {
          const activeTool = shell.querySelector?.('[data-tool].active')?.dataset.tool;
          if (activeTool !== 'character-move' || !selectedCharacterId) return;
          const character = mapCharacter(api.getState(), selectedCharacterId);
          if (!character) return;
          previousTool = 'character-move';
          if (!beginSessionForCharacter(character)) return;
        }
        if (![TokenDragPhase.PLANNING, TokenDragPhase.READY].includes(drag.phase)) return;
        if (event.target.closest?.('.fvtt-move-confirm')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const point = worldPointFromPointer(event);
        if (!pointInside(point, api.mapPackage)) return;
        const firstPostDragWaypoint = drag.nextClickCreatesWaypoint;
        if (firstPostDragWaypoint || event.ctrlKey || event.metaKey) {
          const added = await addWaypointAt(point);
          if (added) {
            status(firstPostDragWaypoint
              ? '已设置第 1 个拐点 · 继续移动光标规划；Ctrl/Cmd+点击或 F 可继续添加拐点，普通点击设置最终终点'
              : '已添加拐点 ' + drag.session.waypoints.length + ' · 继续移动光标规划');
          }
        } else {
          const route = await calculate(point);
          if (!route?.valid) return;
          drag.ready(route);
          draw(route, mapCharacter(api.getState(), drag.characterId));
          showControls(true);
          status('最终终点已设置 · ' + formatDistance(route.distance) + ' · 确认移动 / Enter');
        }
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
        status('移动吸附 ' + next + ' m · 滚轮继续切档 · 已有拐点保持不动');
      }

      async function keydown(event) {
        if (!drag.active || moving) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopImmediatePropagation(); reset('已取消角色移动规划'); return;
        }
        if (event.key === 'Enter' && drag.phase === TokenDragPhase.READY) {
          event.preventDefault(); event.stopImmediatePropagation(); await commit(); return;
        }
        if (event.key.toLowerCase() === 'f') {
          event.preventDefault(); event.stopImmediatePropagation();
          if (event.altKey) await removeWaypoint(); else await addWaypointAtCurrent();
        }
      }

      controls.confirm.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); commit(); });
      controls.cancel.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); reset('已取消角色移动规划'); });
      mapElement.addEventListener('pointerdown', beginTokenDrag, true);
      mapElement.addEventListener('pointermove', moveTokenDrag, true);
      mapElement.addEventListener('pointerup', endTokenDrag, true);
      mapElement.addEventListener('pointercancel', () => reset('已取消角色移动规划'), true);
      mapElement.addEventListener('click', planningClick, true);
      mapElement.addEventListener('contextmenu', planningContextMenu, true);
      mapElement.addEventListener('wheel', wheel, { capture: true, passive: false });
      document.addEventListener('keydown', keydown, true);
      api.on('character:select', event => {
        selectedCharacterId = event.detail?.id || null;
        if (!drag.active && !moving) settings.beginSession(api.map, api.mapPackage);
      });
      api.on('character:create', event => { if (event.detail?.id) selectedCharacterId = event.detail.id; });
      api.on('character:delete', event => { if (event.detail?.id === selectedCharacterId) selectedCharacterId = null; });
      api.on('scene:damage', () => { invalidateNavigation(); reset(); });
      api.on('scene:restore', () => { invalidateNavigation(); reset(); });
      api.on('scene:undo', () => { invalidateNavigation(); reset(); });
      api.on('state:import', () => { invalidateNavigation(); reset(); });
      api.on('elevation:token-change', () => {
        invalidateNavigation();
        if (drag.active || moving) reset('高度已变化，请重新规划移动');
      });
      api.on('token:size-change', () => {
        invalidateNavigation();
        if (drag.active || moving) reset('Token 尺寸已变化，请重新规划移动');
      });
      api.on('status:change', () => {
        invalidateNavigation();
        if (drag.active || moving) reset('角色状态已变化，请重新规划移动');
      });
      api.on('multiplayer:capabilities', () => {
        // A GM may revoke OWNER or advance Combat while a Player is still
        // dragging. Never leave a preview calculated under the old authority
        // decision available for confirmation.
        if (drag.active || moving) reset('联机权限已变化，请重新规划移动');
      });
      status('浏览模式：拖动地图；直接拖动角色 Token 可规划移动，规划中滚轮切换吸附档位');
    },
  };
}
