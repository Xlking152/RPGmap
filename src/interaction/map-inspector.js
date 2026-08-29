import { latLngToWorld } from '../engine/geometry.js';
import { inspectableFeaturesAtPoint } from '../engine/feature-selection.js';

const STYLE_ID = 'rpgmap-feature-map-inspector-style';

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-feature-id].interaction-selected {
      filter: drop-shadow(0 0 3px rgba(23,109,118,.92)) brightness(1.08);
      opacity: 1 !important;
    }
  `;
  documentNode.head.append(style);
}

function ignoredTarget(target) {
  return Boolean(target?.closest?.(
    '.rpg-token-v2,.feature-map-control,.leaflet-control,.aoe-handle,.fvtt-move-confirm,[data-area-handle="true"]',
  ));
}

export function featureAtMapLatLng(latlng, mapPackage) {
  if (!latlng || !mapPackage) return null;
  const point = latLngToWorld(latlng, mapPackage.height);
  return inspectableFeaturesAtPoint(point, mapPackage.features || [])[0] || null;
}

export function createFeatureMapInspector() {
  return Object.freeze({
    register(api) {
      if (!api?.map || !api?.mapPackage || typeof api.selectFeature !== 'function') return;
      const mapElement = api.map.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document || null;
      if (!mapElement || !documentNode) return;
      installStyles(documentNode);

      let selectedFeatureId = api.getSelectedFeatureId?.() || null;
      let destroyed = false;
      const off = [];

      function syncHighlight() {
        for (const node of mapElement.querySelectorAll?.('[data-feature-id]') || []) {
          node.classList.toggle(
            'interaction-selected',
            Boolean(selectedFeatureId) && String(node.dataset?.featureId || '') === String(selectedFeatureId),
          );
        }
      }

      function inspectMapClick(event) {
        if (destroyed) return;
        const tool = api.getTool?.() || 'pan';
        if (!['pan', 'inspect'].includes(tool)) return;
        if (ignoredTarget(event.originalEvent?.target)) return;
        const feature = featureAtMapLatLng(event.latlng, api.mapPackage);
        if (!feature) {
          if (tool === 'inspect') api.setStatus?.('地物检查：点击建筑、城墙、城门、树木或桥梁查看信息');
          return;
        }
        selectedFeatureId = String(feature.id);
        api.selectFeature(feature.id, { switchTab: true });
        api.setStatus?.(`${feature.name || feature.id} · 已打开地物信息`);
        syncHighlight();
      }

      api.map.on?.('click', inspectMapClick);
      off.push(api.on?.('feature:select', event => {
        selectedFeatureId = event.detail?.id || event.detail?.featureId || null;
        syncHighlight();
      }));
      off.push(api.on?.('state:import', syncHighlight));
      off.push(api.on?.('runtime:ready', syncHighlight));
      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        api.map.off?.('click', inspectMapClick);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      api.featureMapInspector = Object.freeze({
        inspectAtLatLng(latlng) {
          const feature = featureAtMapLatLng(latlng, api.mapPackage);
          if (!feature) return null;
          selectedFeatureId = String(feature.id);
          api.selectFeature(feature.id, { switchTab: true });
          syncHighlight();
          return feature;
        },
        syncHighlight,
      });
      syncHighlight();
    },
  });
}
