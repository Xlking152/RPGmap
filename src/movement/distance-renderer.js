import L from 'leaflet';
import { latLngToWorld, worldToLatLng } from '../engine/geometry.js';
import {
  MOVEMENT_DISTANCE_STEPS,
  normalizeMovementDistanceStep,
  splitRouteByWaypoints,
  summarizeMovementSegments,
} from './distance.js';

const STORAGE_SUFFIX = 'movement-distance-step';

function tooltipText(layer) {
  const content = layer?.getTooltip?.()?.getContent?.();
  if (typeof content === 'string') return content;
  return content?.textContent || '';
}
function flattenLatLngs(value) {
  if (!Array.isArray(value)) return [];
  if (value.length && value[0] && typeof value[0].lat === 'number') return value;
  return value.flatMap(flattenLatLngs);
}
function isMovementRoute(layer) {
  return layer instanceof L.Polyline && !(layer instanceof L.Polygon) && layer.options?.className === 'character-route-preview';
}
function waypointNumber(layer) {
  if (!(layer instanceof L.CircleMarker) || Number(layer.options?.radius) !== 5) return null;
  const match = tooltipText(layer).match(/^拐点\s*(\d+)/);
  return match ? Number(match[1]) : null;
}
function createControl(mapElement, step) {
  const control = document.createElement('label');
  control.className = 'fvtt-distance-step-control';
  const text = document.createElement('span');
  text.textContent = '移动吸附';
  const select = document.createElement('select');
  select.setAttribute('aria-label', '移动吸附与距离计价档位');
  MOVEMENT_DISTANCE_STEPS.forEach(value => {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = value + ' m';
    option.selected = value === step;
    select.append(option);
  });
  control.append(text, select);
  const host = mapElement.parentElement;
  if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host?.append(control);
  L.DomEvent.disableClickPropagation(control);
  L.DomEvent.disableScrollPropagation(control);
  return { control, select };
}
function injectStyles(documentNode) {
  if (documentNode.getElementById('fvtt-segment-distance-style')) return;
  const style = documentNode.createElement('style');
  style.id = 'fvtt-segment-distance-style';
  style.textContent = `
    .fvtt-distance-step-control { position:absolute; z-index:1200; top:12px; right:12px; display:inline-flex; align-items:center; gap:7px; padding:6px 8px; border:1px solid rgba(57,119,131,.42); border-radius:7px; color:#33494d; background:rgba(248,250,247,.94); box-shadow:0 2px 8px rgba(31,39,38,.13); font-size:12px; font-weight:700; }
    .fvtt-distance-step-control select { min-height:27px; padding:2px 22px 2px 6px; border:1px solid #adb3af; border-radius:5px; color:#252a2b; background:#fff; font:inherit; }
    .leaflet-tooltip.fvtt-segment-distance-label,.leaflet-tooltip.fvtt-distance-total-label { border:0; box-shadow:0 2px 7px rgba(0,0,0,.22); font-weight:800; white-space:nowrap; }
    .leaflet-tooltip.fvtt-segment-distance-label { padding:4px 6px; color:#fff; background:rgba(31,82,90,.90); font-size:11px; }
    .leaflet-tooltip.fvtt-distance-total-label { padding:5px 8px; color:#fff; background:rgba(150,63,47,.94); font-size:12px; }
    .leaflet-tooltip.fvtt-segment-distance-label::before,.leaflet-tooltip.fvtt-distance-total-label::before { display:none; }
  `;
  documentNode.head.append(style);
}

export function createMovementDistanceRenderer({ defaultStep = 5, settings = null } = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      injectStyles(documentNode);
      const labelLayer = L.layerGroup([], { pane: 'measurePane' }).addTo(api.map);
      const storageKey = (api.mapPackage.id || 'rpg-map') + ':' + STORAGE_SUFFIX;
      let step = settings ? normalizeMovementDistanceStep(settings.step, defaultStep) : normalizeMovementDistanceStep(defaultStep);
      if (!settings) {
        try { step = normalizeMovementDistanceStep(localStorage.getItem(storageKey), step); } catch {}
      }
      const control = createControl(mapElement, step);
      control.control.title = '同时控制角色规划点吸附与分段移动计价；规划中可用滚轮切换';
      let frame = null;
      let rendering = false;
      const schedule = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { frame = null; render(); });
      };
      function findRoute() {
        const routes = [];
        api.map.eachLayer(layer => { if (isMovementRoute(layer)) routes.push(layer); });
        return routes.sort((a, b) => (a._leaflet_id || 0) - (b._leaflet_id || 0)).at(-1) || null;
      }
      function findWaypoints() {
        const waypoints = [];
        api.map.eachLayer(layer => {
          const index = waypointNumber(layer);
          if (index !== null) waypoints.push({ index, point: latLngToWorld(layer.getLatLng(), api.mapPackage.height) });
        });
        return waypoints.sort((a, b) => a.index - b.index).map(item => item.point);
      }
      function render() {
        if (rendering) return;
        rendering = true;
        labelLayer.clearLayers();
        const route = findRoute();
        if (!route) { rendering = false; return; }
        const routePoints = flattenLatLngs(route.getLatLngs()).map(latlng => latLngToWorld(latlng, api.mapPackage.height));
        if (routePoints.length < 2) { rendering = false; return; }
        const segments = splitRouteByWaypoints(routePoints, findWaypoints(), api.mapPackage.metersPerUnit || 1);
        const summary = summarizeMovementSegments(segments, step);
        summary.segments.forEach((segment, index) => {
          if (!segment.midpoint) return;
          L.tooltip({ permanent:true, direction:'center', className:'fvtt-segment-distance-label', pane:'measurePane', interactive:false })
            .setLatLng(worldToLatLng(segment.midpoint, api.mapPackage.height))
            .setContent((index + 1) + ' · ' + segment.displayCost + ' m')
            .addTo(labelLayer);
        });
        const endpoint = routePoints.at(-1);
        L.tooltip({ permanent:true, direction:'bottom', offset:[0,12], className:'fvtt-distance-total-label', pane:'measurePane', interactive:false })
          .setLatLng(worldToLatLng(endpoint, api.mapPackage.height))
          .setContent('总 ' + summary.displayCost + ' m')
          .addTo(labelLayer);
        rendering = false;
      }
      const relevantLayer = layer => isMovementRoute(layer) || waypointNumber(layer) !== null;
      api.map.on('layeradd', event => { if (!rendering && relevantLayer(event.layer)) schedule(); });
      api.map.on('layerremove', event => { if (!rendering && relevantLayer(event.layer)) schedule(); });
      api.map.on('zoomend', schedule);
      control.select.addEventListener('change', () => {
        const next = normalizeMovementDistanceStep(control.select.value, step);
        if (settings) settings.setStep(next, { source: 'control' });
        else {
          step = next;
          try { localStorage.setItem(storageKey, String(step)); } catch {}
          schedule();
        }
      });
      settings?.subscribe(event => {
        step = normalizeMovementDistanceStep(event.step, step);
        control.select.value = String(step);
        schedule();
      });
      schedule();
    },
  };
}
