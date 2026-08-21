import L from 'leaflet';
import { latLngToWorld } from '../engine/geometry.js';
import { createTokenGhostDescriptor, isMovementEndpointLayer } from '../engine/token-ghost.js';

const GHOST_STYLE_ID = 'fvtt-token-ghost-style';
const BLOCKED_ROUTE_COLOR = '#b52f2a';
const HIDE_DELAY_MS = 90;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function installGhostStyles() {
  if (document.getElementById(GHOST_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = GHOST_STYLE_ID;
  style.textContent = `
    .fvtt-token-ghost-marker { background: transparent; border: 0; pointer-events: none !important; }
    .fvtt-token-ghost-core {
      position: relative; width: 42px; height: 42px; display: grid; place-items: center; overflow: visible;
      border-radius: 50%; color: #fff; opacity: .62; transform: scale(1.04);
      filter: saturate(.82) brightness(1.08);
      transition: opacity .12s, filter .12s, transform .12s;
    }
    .fvtt-token-ghost-core::before {
      content: ''; position: absolute; inset: -6px; border-radius: 50%; pointer-events: none;
      border: 2px dashed rgba(23,109,118,.92); background: rgba(23,109,118,.08);
      box-shadow: 0 0 0 2px rgba(255,255,255,.72), 0 0 18px 6px rgba(23,109,118,.34);
      animation: fvtt-ghost-pulse 1.15s ease-in-out infinite alternate;
    }
    .fvtt-token-ghost-core.blocked { opacity: .5; filter: grayscale(.28) saturate(.72); }
    .fvtt-token-ghost-core.blocked::before {
      border-color: rgba(181,47,42,.96); background: rgba(181,47,42,.1);
      box-shadow: 0 0 0 2px rgba(255,255,255,.72), 0 0 18px 6px rgba(181,47,42,.38);
    }
    .fvtt-token-ghost-face {
      position: relative; z-index: 1; width: 42px; height: 42px; display: grid; place-items: center; overflow: hidden;
      border-radius: 50%; border: 3px solid rgba(255,255,255,.9);
      background: var(--character-color, #3d9b63);
      box-shadow: 0 2px 8px rgba(0,0,0,.34), 0 0 0 2px var(--character-color, #3d9b63);
      font-size: 12px; font-weight: 750;
    }
    .fvtt-token-ghost-face img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .fvtt-token-ghost-badge {
      position: absolute; z-index: 2; left: 50%; top: -22px; transform: translateX(-50%);
      padding: 2px 6px; border-radius: 5px; white-space: nowrap;
      color: #fff; background: rgba(27,38,41,.84); box-shadow: 0 2px 7px rgba(0,0,0,.2);
      font: 700 10px/1.35 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    }
    .fvtt-token-ghost-core.blocked .fvtt-token-ghost-badge { background: rgba(130,35,31,.9); }
    @keyframes fvtt-ghost-pulse { from { transform: scale(.96); opacity: .78; } to { transform: scale(1.06); opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .fvtt-token-ghost-core::before { animation: none; } }
  `;
  document.head.append(style);
}

function ghostIcon(descriptor) {
  const portrait = descriptor.avatarDataUrl
    ? '<img src="' + escapeHtml(descriptor.avatarDataUrl) + '" alt="">'
    : '<span>' + escapeHtml(descriptor.initial) + '</span>';
  const blockedClass = descriptor.blocked ? ' blocked' : '';
  const badge = descriptor.blocked ? '受阻' : '预览';
  return L.divIcon({
    className: 'fvtt-token-ghost-marker',
    html: '<div class="fvtt-token-ghost-core' + blockedClass + '" style="--character-color:' + descriptor.color + '">' +
      '<span class="fvtt-token-ghost-badge">' + badge + '</span>' +
      '<span class="fvtt-token-ghost-face">' + portrait + '</span></div>',
    iconSize: [42, 42],
    iconAnchor: [21, 21],
  });
}

function sameColor(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

export function createFvttTokenGhostTool() {
  return {
    register(api) {
      installGhostStyles();
      const ghostLayer = L.layerGroup([], { pane: 'characterPane' }).addTo(api.map);
      let selectedCharacterId = null;
      let ghostMarker = null;
      let endpointLayer = null;
      let hideTimer = null;

      const selectedCharacter = () => {
        const state = api.getState();
        return state.characters?.find(character => character.id === selectedCharacterId) || null;
      };

      const cancelHide = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = null;
      };

      const hideGhost = () => {
        cancelHide();
        endpointLayer = null;
        if (ghostMarker) ghostLayer.removeLayer(ghostMarker);
        ghostMarker = null;
      };

      const scheduleHide = () => {
        cancelHide();
        hideTimer = setTimeout(hideGhost, HIDE_DELAY_MS);
      };

      const showGhost = layer => {
        const character = selectedCharacter();
        if (!character || typeof layer.getLatLng !== 'function') return;
        cancelHide();
        endpointLayer = layer;
        const point = latLngToWorld(layer.getLatLng(), api.mapPackage.height);
        const descriptor = createTokenGhostDescriptor(character, point, {
          blocked: sameColor(layer.options?.color, BLOCKED_ROUTE_COLOR),
        });
        if (!descriptor) return;
        if (!ghostMarker) {
          ghostMarker = L.marker(layer.getLatLng(), {
            icon: ghostIcon(descriptor),
            pane: 'characterPane',
            interactive: false,
            keyboard: false,
            bubblingMouseEvents: false,
            zIndexOffset: 900,
          }).addTo(ghostLayer);
        } else {
          ghostMarker.setLatLng(layer.getLatLng());
          ghostMarker.setIcon(ghostIcon(descriptor));
        }
      };

      api.on('character:select', event => {
        selectedCharacterId = event.detail?.id || null;
      });
      api.on('character:delete', event => {
        if (event.detail?.id === selectedCharacterId) {
          selectedCharacterId = null;
          hideGhost();
        }
      });
      api.on('state:import', hideGhost);
      api.on('scene:damage', hideGhost);
      api.on('scene:restore', hideGhost);
      api.on('scene:undo', hideGhost);

      api.map.on('layeradd', event => {
        const layer = event.layer;
        if (!layer?.options || !isMovementEndpointLayer(layer.options)) return;
        showGhost(layer);
      });
      api.map.on('layerremove', event => {
        if (event.layer === endpointLayer) scheduleHide();
      });
    }
  };
}
