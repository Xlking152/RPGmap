import L from 'leaflet';
import { worldToLatLng } from '../engine/geometry.js';

export const PATH_LABEL_PANE = 'pathLabelPane';

export function ensurePathLabelPane(map, { zIndex = 720 } = {}) {
  let pane = map.getPane?.(PATH_LABEL_PANE);
  if (!pane) pane = map.createPane(PATH_LABEL_PANE);
  if (pane) {
    pane.style.zIndex = String(zIndex);
    pane.style.pointerEvents = 'none';
  }
  return PATH_LABEL_PANE;
}

export function installPathLabelStyles(documentNode) {
  if (documentNode.getElementById('rpgmap-path-distance-label-style')) return;
  const style = documentNode.createElement('style');
  style.id = 'rpgmap-path-distance-label-style';
  style.textContent = `
    .leaflet-tooltip.rpgmap-path-segment-label,
    .leaflet-tooltip.rpgmap-path-total-label {
      border:0;
      box-shadow:0 2px 7px rgba(0,0,0,.24);
      font-weight:800;
      white-space:nowrap;
      pointer-events:none;
      transform:translateZ(0);
    }
    .leaflet-tooltip.rpgmap-path-segment-label {
      padding:4px 6px;
      color:#fff;
      background:rgba(31,82,90,.97);
      font-size:11px;
    }
    .leaflet-tooltip.rpgmap-path-total-label {
      padding:5px 8px;
      color:#fff;
      background:rgba(150,63,47,.98);
      font-size:12px;
    }
    .leaflet-tooltip.rpgmap-path-segment-label::before,
    .leaflet-tooltip.rpgmap-path-total-label::before { display:none; }
  `;
  documentNode.head.append(style);
}

export function addPathDistanceLabel(layerGroup, mapPackage, point, text, {
  total = false,
  offset = null,
} = {}) {
  if (!layerGroup || !point) return null;
  const defaultOffset = total ? [0, -30] : [0, -12];
  return L.tooltip({
    permanent: true,
    direction: 'top',
    offset: offset || defaultOffset,
    className: total ? 'rpgmap-path-total-label' : 'rpgmap-path-segment-label',
    pane: PATH_LABEL_PANE,
    interactive: false,
  })
    .setLatLng(worldToLatLng(point, mapPackage.height))
    .setContent(String(text))
    .addTo(layerGroup);
}
