import L from 'leaflet';
import { latLngToWorld, worldToLatLng } from '../engine/geometry.js';
import { TokenSelectionState, tokenIdsInBounds } from './state.js';

const STYLE_ID = 'rpgmap-token-selection-style';
const DRAG_THRESHOLD_PX = 4;

function editableTarget(target) {
  return target instanceof HTMLElement && Boolean(target.closest('input,textarea,select,[contenteditable="true"]'));
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpgmap-selection-marquee {
      position:absolute;
      z-index:710;
      border:1px solid rgba(23,109,118,.95);
      background:rgba(23,109,118,.12);
      box-shadow:0 0 0 1px rgba(255,255,255,.55) inset;
      pointer-events:none;
    }
  `;
  documentNode.head.append(style);
}

function ensureSelectionPane(map) {
  let pane = map.getPane?.('selectionPane');
  if (!pane) pane = map.createPane('selectionPane');
  if (pane) {
    pane.style.zIndex = '690';
    pane.style.pointerEvents = 'none';
  }
}

function legacyProjectedTokens(api) {
  return (api.getState().characters || []).map(character => ({
    id: String(character.id),
    placement: character.location?.type === 'building' ? 'feature' : 'map',
    x: character.location?.type === 'map' ? Number(character.location.x) : null,
    y: character.location?.type === 'map' ? Number(character.location.y) : null,
    featureId: character.location?.type === 'building' ? character.location.featureId : null,
    hidden: character.visible === false,
  }));
}

function mapTokens(api) {
  return api.tokens?.list?.() || legacyProjectedTokens(api);
}

function nearestMapToken(api, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const token of mapTokens(api)) {
    if (token?.hidden === true || token?.placement !== 'map') continue;
    const x = Number(token.x);
    const y = Number(token.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const distance = Math.hypot(x - point.x, y - point.y);
    if (distance < bestDistance) {
      best = token;
      bestDistance = distance;
    }
  }
  return best;
}

function modeFromEvent(event) {
  if (event.altKey) return 'remove';
  if (event.shiftKey) return 'add';
  return 'replace';
}

export function createSelectionController(state, notify) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const host = mapElement.parentElement || mapElement;
      installStyles(documentNode);
      ensureSelectionPane(api.map);
      if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';

      const highlightLayer = L.layerGroup([], { pane: 'selectionPane' }).addTo(api.map);
      const baseSetTool = api.setTool.bind(api);
      let currentTool = 'pan';
      let marquee = null;
      let restoreDragging = false;
      let spaceHeld = false;

      api.setTool = tool => {
        currentTool = String(tool || 'pan');
        return baseSetTool(tool);
      };

      const status = message => {
        const node = shell.querySelector?.('[data-role="map-status"]');
        if (node) node.textContent = message;
      };

      function tokens() {
        return mapTokens(api);
      }

      function renderSelection() {
        highlightLayer.clearLayers();
        const selected = new Set(state.snapshot().ids);
        const primaryId = state.primaryId;
        for (const token of tokens()) {
          if (!selected.has(String(token.id)) || token?.placement !== 'map' || token.hidden === true) continue;
          const x = Number(token.x);
          const y = Number(token.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          const primary = String(token.id) === String(primaryId);
          L.circleMarker(worldToLatLng({ x, y }, api.mapPackage.height), {
            pane: 'selectionPane',
            radius: primary ? 18 : 16,
            color: primary ? '#176d76' : '#4e8f96',
            weight: primary ? 4 : 3,
            opacity: 1,
            fill: false,
            interactive: false,
            className: primary ? 'rpgmap-token-selected primary' : 'rpgmap-token-selected',
          }).addTo(highlightLayer);
        }
      }

      function publish(reason = 'selection') {
        renderSelection();
        notify({ ...state.snapshot(), reason });
      }

      function apply(ids, mode, primaryId = null) {
        if (mode === 'add') state.add(ids, primaryId);
        else if (mode === 'remove') state.remove(ids);
        else state.replace(ids, primaryId);
        publish(mode);
        const count = state.ids.size;
        status(count ? `已选择 ${count} 个 Token` : '已清除 Token 选择');
      }

      function pointFromClient(clientX, clientY) {
        const rect = mapElement.getBoundingClientRect();
        return latLngToWorld(api.map.containerPointToLatLng([
          clientX - rect.left,
          clientY - rect.top,
        ]), api.mapPackage.height);
      }

      function setMarqueeBox(start, end) {
        if (!marquee) return;
        const rect = mapElement.getBoundingClientRect();
        const left = Math.min(start.x, end.x) - rect.left;
        const top = Math.min(start.y, end.y) - rect.top;
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);
        Object.assign(marquee.node.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
          display: marquee.moved ? 'block' : 'none',
        });
      }

      function cleanupMarquee() {
        marquee?.node?.remove();
        marquee = null;
        if (restoreDragging) api.map.dragging.enable();
        restoreDragging = false;
      }

      documentNode.addEventListener('pointerdown', event => {
        if (event.button !== 0 || editableTarget(event.target)) return;
        if (!mapElement.contains(event.target)) return;
        if (event.target.closest?.('.leaflet-control, .ui-menu, .ui-context-menu')) return;

        const tokenElement = event.target.closest?.('.rpg-character, .rpg-character-core');
        if (tokenElement) {
          if (!event.shiftKey && !event.altKey) return;
          const point = pointFromClient(event.clientX, event.clientY);
          const token = nearestMapToken(api, point);
          if (!token) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.altKey) apply([token.id], 'remove');
          else apply([token.id], 'add', token.id);
          return;
        }

        if (spaceHeld) return;
        if (shell.querySelector?.('.ui-ruler-tool.active')) return;
        if (currentTool !== 'pan') return;
        event.preventDefault();
        event.stopImmediatePropagation();

        const node = documentNode.createElement('div');
        node.className = 'rpgmap-selection-marquee';
        host.append(node);
        const startClient = { x: event.clientX, y: event.clientY };
        marquee = {
          pointerId: event.pointerId,
          startClient,
          startWorld: pointFromClient(event.clientX, event.clientY),
          mode: modeFromEvent(event),
          moved: false,
          node,
        };
        restoreDragging = api.map.dragging.enabled();
        if (restoreDragging) api.map.dragging.disable();
        mapElement.setPointerCapture?.(event.pointerId);
        setMarqueeBox(startClient, startClient);
      }, true);

      documentNode.addEventListener('click', event => {
        if (!mapElement.contains(event.target)) return;
        if (!event.target.closest?.('.rpg-character, .rpg-character-core')) return;
        if (!event.shiftKey && !event.altKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);

      documentNode.addEventListener('pointermove', event => {
        if (!marquee || event.pointerId !== marquee.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const distance = Math.hypot(event.clientX - marquee.startClient.x, event.clientY - marquee.startClient.y);
        if (distance >= DRAG_THRESHOLD_PX) marquee.moved = true;
        setMarqueeBox(marquee.startClient, { x: event.clientX, y: event.clientY });
      }, true);

      documentNode.addEventListener('pointerup', event => {
        if (!marquee || event.pointerId !== marquee.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        mapElement.releasePointerCapture?.(event.pointerId);

        const drag = marquee;
        const endWorld = pointFromClient(event.clientX, event.clientY);
        cleanupMarquee();

        if (!drag.moved) {
          if (drag.mode === 'replace') apply([], 'replace');
          return;
        }

        const ids = tokenIdsInBounds(tokens(), drag.startWorld, endWorld);
        apply(ids, drag.mode, ids.at(-1) || null);
      }, true);

      documentNode.addEventListener('pointercancel', event => {
        if (!marquee || event.pointerId !== marquee.pointerId) return;
        cleanupMarquee();
      }, true);

      documentNode.addEventListener('keydown', event => {
        if (event.code !== 'Space' || editableTarget(event.target)) return;
        spaceHeld = true;
        event.preventDefault();
      }, true);
      documentNode.addEventListener('keyup', event => {
        if (event.code === 'Space') spaceHeld = false;
      }, true);
      globalThis.addEventListener?.('blur', () => { spaceHeld = false; });

      api.on('character:select', event => {
        const id = event.detail?.id;
        if (!id) return;
        state.replace([id], id);
        publish('single');
      });
      api.on('character:move', renderSelection);
      api.on('character:delete', event => {
        if (!event.detail?.id) return;
        state.remove([event.detail.id]);
        publish('delete');
      });
      api.on('state:import', () => {
        const valid = new Set(tokens().map(token => String(token.id)));
        state.replace(state.snapshot().ids.filter(id => valid.has(id)), state.primaryId);
        publish('import');
      });
      api.on('state:commit', event => {
        const source = String(event.detail?.source || '');
        if (!source.startsWith('token-v2:') && !source.startsWith('world-v2:')) return;
        const valid = new Set(tokens().map(token => String(token.id)));
        state.replace(state.snapshot().ids.filter(id => valid.has(id)), state.primaryId);
        publish(source);
      });

      renderSelection();
    },
  };
}
