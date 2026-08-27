import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';
import { tokenDiameterMeters } from '../elevation/model.js';
import { HEALTH_MODE_WOUND_TRACK, formatHealthSummary } from './model.js';

const PANE = 'healthBarPane';
const STYLE_ID = 'rpgmap-token-healthbar-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

function ensurePane(map) {
  let pane = map.getPane?.(PANE);
  if (!pane) pane = map.createPane(PANE);
  if (pane) {
    pane.style.zIndex = '525';
    pane.style.pointerEvents = 'none';
  }
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpgmap-healthbar-marker { background:transparent !important; border:0 !important; pointer-events:none !important; }
    .rpgmap-token-healthbar { width:46px; height:7px; display:flex; overflow:hidden; border:1px solid rgba(20,28,28,.72); border-radius:4px; background:rgba(25,30,30,.5); box-shadow:0 1px 3px rgba(0,0,0,.45); }
    .rpgmap-token-healthbar > span { height:100%; min-width:0; }
    .rpgmap-token-healthbar .healthy,.rpgmap-token-healthbar .simple { background:#4b9f69; }
    .rpgmap-token-healthbar .bashing { background:#d9b84a; }
    .rpgmap-token-healthbar .lethal { background:#d77c42; }
    .rpgmap-token-healthbar .aggravated { background:#a94442; }
  `;
  documentNode.head.append(style);
}

function segment(width, className) {
  return width > 0 ? `<span class="${className}" style="width:${Math.max(0, width)}%"></span>` : '';
}

function barHtml(health) {
  const max = Math.max(0, Number(health?.max) || 0);
  if (!max) return '';
  if (health.mode !== HEALTH_MODE_WOUND_TRACK) {
    const pct = Math.max(0, Math.min(100, (Number(health.current) || 0) / max * 100));
    return `<div class="rpgmap-token-healthbar" title="${escapeHtml(formatHealthSummary(health))}">${segment(pct, 'simple')}</div>`;
  }
  const pct = value => Math.max(0, Math.min(100, (Number(value) || 0) / max * 100));
  return `<div class="rpgmap-token-healthbar" title="${escapeHtml(formatHealthSummary(health))}">${segment(pct(health.healthy), 'healthy')}${segment(pct(health.bashing), 'bashing')}${segment(pct(health.lethal), 'lethal')}${segment(pct(health.aggravated), 'aggravated')}</div>`;
}

function legacyProjectedTokens(api) {
  const state = api.getState?.() || {};
  const characters = new Map((state.characters || []).map(character => [String(character.id), character]));
  return (state.preferences?.entitySystem?.tokens || []).flatMap(token => {
    const character = characters.get(String(token.characterId || token.id));
    if (!character) return [];
    if (character.location?.type === 'building') {
      return [{ ...token, placement: 'feature', featureId: character.location.featureId, x: null, y: null, hidden: token.hidden === true || character.visible === false }];
    }
    return [{ ...token, placement: 'map', x: character.location?.x, y: character.location?.y, featureId: null, hidden: token.hidden === true || character.visible === false }];
  });
}

export function createHealthTokenBars() {
  return {
    register(api) {
      const documentNode = api.map.getContainer().ownerDocument || document;
      ensurePane(api.map);
      installStyles(documentNode);
      const layer = L.layerGroup([], { pane: PANE }).addTo(api.map);

      function render() {
        layer.clearLayers();
        const tokens = api.tokens?.list?.() || legacyProjectedTokens(api);
        for (const token of tokens) {
          if (token?.hidden === true || token?.placement !== 'map') continue;
          const x = Number(token.x);
          const y = Number(token.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          const health = api.health?.resolveToken?.(token.id);
          const html = barHtml(health);
          if (!html) continue;
          const origin = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
          const unit = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
          const tokenPixels = Math.max(18, Math.min(144, tokenDiameterMeters(token) * (Math.hypot(unit.x - origin.x, unit.y - origin.y) || 1)));
          const barWidth = Math.max(28, Math.min(160, tokenPixels * 1.1));
          L.marker(worldToLatLng({ x, y }, api.mapPackage.height), {
            pane: PANE,
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'rpgmap-healthbar-marker',
              html: html.replace('class="rpgmap-token-healthbar"', `class="rpgmap-token-healthbar" style="width:${barWidth}px"`),
              iconSize: [barWidth, 7],
              iconAnchor: [barWidth / 2, -(tokenPixels / 2 + 6)],
            }),
          }).addTo(layer);
        }
      }

      api.on('character:move', render);
      api.on('character:delete', render);
      api.on('state:import', render);
      api.on('state:saved', render);
      api.on('state:commit', event => {
        const source = String(event.detail?.source || '');
        if (
          source === 'health'
          || source.startsWith('entities:resource')
          || source.startsWith('token-v2:')
          || source.startsWith('world-v2:')
        ) render();
      });
      api.on('health:change', render);
      api.on('token:size-change', render);
      render();
    },
  };
}
