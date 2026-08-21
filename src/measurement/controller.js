import L from 'leaflet';
import { latLngToWorld, worldToLatLng } from '../engine/geometry.js';
import { ensurePathLabelPane, installPathLabelStyles, addPathDistanceLabel } from '../path/labels.js';
import { formatRulerDistance, summarizeRulerPath } from './distance.js';
import { RulerSession } from './session.js';

const RULER_LINE_CLASS = 'rpgmap-ruler-route';

function inside(point, mapPackage) {
  return point.x >= 0 && point.y >= 0 && point.x <= mapPackage.width && point.y <= mapPackage.height;
}

function menuByLabel(shell, prefix) {
  return [...shell.querySelectorAll('.ui-menu')].find(node =>
    node.querySelector('summary')?.textContent?.trim().startsWith(prefix)) || null;
}

function createRulerButton(documentNode) {
  const button = documentNode.createElement('button');
  button.type = 'button';
  button.className = 'ui-primary-tool ui-ruler-tool';
  button.dataset.uiMainTool = 'ruler';
  button.textContent = '测量';
  button.title = '距离尺 · R';
  return button;
}

function createCharacterRulerButton(documentNode) {
  const button = documentNode.createElement('button');
  button.type = 'button';
  button.className = 'ui-primary-tool ui-character-ruler-tool';
  button.textContent = '角色测距';
  button.title = '从当前主选择 Token 的位置开始测距 · Shift+R';
  return button;
}

export function createRulerController() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      ensurePathLabelPane(api.map);
      installPathLabelStyles(documentNode);

      const routeLayer = L.layerGroup([], { pane: 'measurePane' }).addTo(api.map);
      const labelLayer = L.layerGroup([]).addTo(api.map);
      const session = new RulerSession();
      const baseSetTool = api.setTool.bind(api);
      let enabled = false;
      let restoreDragging = false;

      const status = message => {
        const node = shell.querySelector?.('[data-role="map-status"]');
        if (node) node.textContent = message;
      };

      function pointFromEvent(event) {
        return latLngToWorld(api.map.mouseEventToLatLng(event), api.mapPackage.height);
      }

      function render() {
        routeLayer.clearLayers();
        labelLayer.clearLayers();
        if (!session.active) return;

        const summary = summarizeRulerPath(session.points, api.mapPackage.metersPerUnit || 1);
        if (summary.points.length > 1) {
          L.polyline(summary.points.map(point => worldToLatLng(point, api.mapPackage.height)), {
            pane: 'measurePane',
            color: '#176d76',
            weight: 3,
            opacity: 0.92,
            dashArray: '8 6',
            interactive: false,
            className: RULER_LINE_CLASS,
          }).addTo(routeLayer);
        }

        session.waypoints.forEach((point, index) => {
          L.circleMarker(worldToLatLng(point, api.mapPackage.height), {
            pane: 'measurePane',
            radius: 5,
            color: '#176d76',
            weight: 2,
            fillColor: '#ffffff',
            fillOpacity: 1,
            interactive: false,
          }).bindTooltip(`拐点 ${index + 1}`, {
            direction: 'top',
            pane: 'pathLabelPane',
            interactive: false,
          }).addTo(routeLayer);
        });

        summary.segments.forEach(segment => {
          addPathDistanceLabel(
            labelLayer,
            api.mapPackage,
            segment.midpoint,
            formatRulerDistance(segment.distance),
          );
        });

        if (summary.points.length > 1) {
          addPathDistanceLabel(
            labelLayer,
            api.mapPackage,
            summary.points.at(-1),
            `总 ${formatRulerDistance(summary.total)}`,
            { total: true },
          );
        }
      }

      function clear(message = '测量已清除') {
        session.reset();
        render();
        if (message) status(message);
      }

      function mapCharacter(characterId) {
        return (api.getState().characters || []).find(character =>
          String(character?.id) === String(characterId) &&
          character?.visible !== false &&
          character?.location?.type === 'map') || null;
      }

      function startFromCharacter(characterId) {
        const character = mapCharacter(characterId);
        if (!character) {
          status('无法从该角色测距：Token 当前不在地图上');
          return false;
        }
        if (!enabled) activate();
        session.begin(character.location);
        render();
        status(`从 ${character.name || '所选角色'} 开始测距 · 移动鼠标预览；Ctrl/Cmd+左键或 F 添加拐点，普通左键结束`);
        return true;
      }

      function startFromPrimarySelection() {
        const characterId = api.selection?.getPrimaryTokenId?.();
        if (!characterId) {
          status('请先选择一个 Token，再使用角色测距');
          return false;
        }
        return startFromCharacter(characterId);
      }

      function activate() {
        if (enabled) return;
        enabled = true;
        baseSetTool('ruler');
        restoreDragging = api.map.dragging.enabled();
        if (restoreDragging) api.map.dragging.disable();
        shell.querySelectorAll('.ui-primary-tool').forEach(node =>
          node.classList.toggle('active', node.classList.contains('ui-ruler-tool')));
        status('距离尺：左键设起点/终点 · Ctrl/Cmd+左键或 F 添加拐点 · 右键/Alt+F 撤销 · Esc 清除 · R 退出');
      }

      function deactivate({ clearRuler = false } = {}) {
        if (!enabled) return;
        enabled = false;
        if (restoreDragging) api.map.dragging.enable();
        restoreDragging = false;
        shell.querySelector('.ui-ruler-tool')?.classList.remove('active');
        if (clearRuler) clear('');
        baseSetTool('pan');
        status('浏览模式');
      }

      function toggle() {
        if (enabled) deactivate({ clearRuler: true });
        else activate();
      }

      api.setTool = tool => {
        if (enabled && tool !== 'ruler') {
          enabled = false;
          if (restoreDragging) api.map.dragging.enable();
          restoreDragging = false;
          shell.querySelector('.ui-ruler-tool')?.classList.remove('active');
          session.reset();
          render();
        }
        return baseSetTool(tool);
      };

      api.measurement = {
        activate,
        toggle,
        clear,
        startFromCharacter,
        startFromPrimarySelection,
        isActive: () => enabled,
      };

      const oldMeasure = menuByLabel(shell, '测量');
      const toolbar = shell.querySelector('.toolbar');
      const rulerButton = createRulerButton(documentNode);
      const characterRulerButton = createCharacterRulerButton(documentNode);
      rulerButton.addEventListener('click', toggle);
      characterRulerButton.addEventListener('click', startFromPrimarySelection);
      if (oldMeasure) {
        oldMeasure.replaceWith(rulerButton);
        rulerButton.insertAdjacentElement('afterend', characterRulerButton);
      } else {
        toolbar?.append(rulerButton, characterRulerButton);
      }

      queueMicrotask(() => {
        const selection = api.selection;
        const syncCharacterButton = () => {
          const selectedId = selection?.getPrimaryTokenId?.();
          const available = Boolean(selectedId && mapCharacter(selectedId));
          characterRulerButton.disabled = !available;
          characterRulerButton.title = available
            ? '从当前主选择 Token 的位置开始测距 · Shift+R'
            : '先选择一个位于地图上的 Token';
        };
        selection?.subscribe?.(syncCharacterButton);
        api.on?.('character:move', syncCharacterButton);
        api.on?.('character:delete', syncCharacterButton);
        api.on?.('state:import', syncCharacterButton);
        syncCharacterButton();
      });

      shell.querySelector('[data-panel="measure"]')?.remove();

      mapElement.addEventListener('pointerdown', event => {
        if (!enabled || event.button !== 0) return;
        if (event.target.closest?.('.leaflet-control, .ui-menu, .ui-context-menu')) return;
        const point = pointFromEvent(event);
        if (!inside(point, api.mapPackage)) return;
        event.preventDefault();
        event.stopImmediatePropagation();

        if (!session.active || session.finished) {
          session.begin(point);
          render();
          status('距离尺已开始 · 移动鼠标预览；Ctrl/Cmd+左键或 F 添加拐点，普通左键结束');
          return;
        }

        session.update(point);
        if (event.ctrlKey || event.metaKey) {
          session.addWaypoint(point);
          status(`已添加拐点 ${session.waypoints.length} · 继续移动鼠标规划`);
        } else {
          session.finish(point);
          status(`测量完成 · ${formatRulerDistance(summarizeRulerPath(session.points, api.mapPackage.metersPerUnit || 1).total)} · 左键开始新测量`);
        }
        render();
      }, true);

      mapElement.addEventListener('pointermove', event => {
        if (!enabled || !session.active || session.finished) return;
        const point = pointFromEvent(event);
        if (!inside(point, api.mapPackage)) return;
        session.update(point);
        render();
      }, true);

      mapElement.addEventListener('contextmenu', event => {
        if (!enabled || !session.active) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (session.waypoints.length) {
          session.removeWaypoint();
          render();
          status(`已撤销最近拐点 · 剩余 ${session.waypoints.length} 个`);
        } else {
          clear('测量已取消');
        }
      }, true);

      documentNode.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        if (key === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          if (event.shiftKey) startFromPrimarySelection();
          else toggle();
          return;
        }
        if (!enabled) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          clear();
          return;
        }
        if (key === 'f' && session.active && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          if (event.altKey) {
            if (session.removeWaypoint()) {
              render();
              status(`已撤销最近拐点 · 剩余 ${session.waypoints.length} 个`);
            }
          } else if (!session.finished && session.addWaypoint()) {
            render();
            status(`已添加拐点 ${session.waypoints.length} · 继续移动鼠标规划`);
          }
        }
      }, true);

      toolbar?.addEventListener('click', event => {
        if (!enabled || event.target.closest('.ui-ruler-tool, .ui-character-ruler-tool')) return;
        if (event.target.closest('.ui-primary-tool, .ui-menu-popover button')) deactivate({ clearRuler: true });
      }, true);

      api.map.on('zoomend', render);
    },
  };
}
