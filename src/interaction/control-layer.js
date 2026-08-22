import { worldToLatLng } from '../engine/geometry.js';
import {
  featureControlAction,
  featureControlDescriptor,
  featureControlTitle,
} from './control-model.js';

const STYLE_ID = 'rpgmap-feature-control-layer-style';

function installStyles(documentNode) {
  if (!documentNode || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .feature-control-layer { position:absolute; inset:0; z-index:650; pointer-events:none; overflow:hidden; }
    .feature-map-control {
      position:absolute;
      display:grid;
      place-items:center;
      padding:0;
      border:0;
      border-radius:5px;
      background:transparent;
      box-shadow:none;
      color:rgba(72,58,42,.9);
      cursor:pointer;
      pointer-events:auto;
      user-select:none;
      opacity:.78;
      transform:translate(-50%,-50%);
      transition:opacity .12s ease, background .12s ease, transform .12s ease;
    }
    .feature-map-control:hover,
    .feature-map-control:focus-visible {
      opacity:1;
      background:rgba(248,246,236,.76);
      outline:1px solid rgba(38,49,50,.28);
      transform:translate(-50%,-50%) scale(1.08);
    }
    .feature-map-control[data-control-state="open"] { color:rgba(48,111,78,.94); }
    .feature-map-control[data-control-state="closed"] { color:rgba(112,76,43,.94); }
    .feature-map-control[data-control-permission="denied"] { opacity:.42; cursor:not-allowed; }
    .feature-map-control[hidden] { display:none !important; }

    .feature-map-control .feature-control-glyph {
      position:relative;
      display:block;
      width:12px;
      height:15px;
      box-sizing:border-box;
      border:1.7px solid currentColor;
      border-bottom-width:2px;
      border-radius:1px 1px 0 0;
      pointer-events:none;
      filter:drop-shadow(0 1px 1px rgba(0,0,0,.16));
    }
    .feature-map-control .feature-control-glyph::before {
      content:'';
      position:absolute;
      left:2px;
      top:2px;
      width:6px;
      height:10px;
      box-sizing:border-box;
      border:1.4px solid currentColor;
      background:rgba(248,246,236,.38);
      transform-origin:left center;
      transition:transform .14s ease, width .14s ease;
    }
    .feature-map-control .feature-control-glyph::after {
      content:'';
      position:absolute;
      left:7px;
      top:7px;
      width:1.7px;
      height:1.7px;
      border-radius:50%;
      background:currentColor;
      transition:left .14s ease, transform .14s ease;
    }
    .feature-map-control[data-control-state="open"] .feature-control-glyph::before {
      width:8px;
      transform:translateX(1px) skewY(-16deg) scaleX(.48);
    }
    .feature-map-control[data-control-state="open"] .feature-control-glyph::after {
      left:5px;
      transform:translateX(-1px);
    }
  `;
  documentNode.head?.append(style);
}

function setFeedback(shell, message) {
  const node = shell?.querySelector?.('[data-role="map-status"]');
  if (node && message) node.textContent = message;
}

function canOperateFeatureControl(api) {
  const status = api.multiplayer?.getStatus?.();
  if (!status?.connected || !status.session) return true;
  if (status.session.role === 'gm') return true;
  return status.permissions?.interactFeatures === true;
}

export function createFeatureControlLayer() {
  return {
    register(api) {
      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || globalThis.document || null;
      if (!mapElement || !documentNode || !api.interaction) return;
      installStyles(documentNode);

      const controls = new Map();
      const layer = documentNode.createElement('div');
      layer.className = 'feature-control-layer';
      layer.dataset.featureControlLayer = 'true';
      mapElement.append(layer);

      for (const feature of api.mapPackage?.features || []) {
        const descriptor = featureControlDescriptor(feature);
        if (!descriptor) continue;
        const button = documentNode.createElement('button');
        button.type = 'button';
        button.className = 'feature-map-control';
        button.dataset.featureControlId = String(feature.id);
        button.dataset.controlStyle = descriptor.style;
        button.style.width = `${descriptor.size}px`;
        button.style.height = `${descriptor.size}px`;
        button.setAttribute('aria-label', descriptor.label);
        const glyph = documentNode.createElement('span');
        glyph.className = 'feature-control-glyph';
        button.append(glyph);

        const stopPointer = (event) => event.stopPropagation();
        button.addEventListener('pointerdown', stopPointer);
        button.addEventListener('mousedown', stopPointer);
        button.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        button.addEventListener('contextmenu', (event) => event.stopPropagation());
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!canOperateFeatureControl(api)) {
            setFeedback(layer.closest('.app-shell') || documentNode, '当前 Player 暂无地图 Feature 开关权限；该权限模型已列入后续计划。');
            syncControls();
            return;
          }
          const state = api.interaction.stateForFeature(feature.id);
          const action = featureControlAction(state);
          if (!action) {
            syncControls();
            return;
          }
          api.interaction.execute(action, { featureId: feature.id, source: 'map-control' });
          syncControls();
        });
        layer.append(button);
        controls.set(String(feature.id), { feature, descriptor, button });
      }

      const positionControls = () => {
        for (const { descriptor, button } of controls.values()) {
          const point = api.map.latLngToContainerPoint(
            worldToLatLng({ x: descriptor.anchor[0], y: descriptor.anchor[1] }, api.mapPackage.height),
          );
          button.style.left = `${Math.round(point.x)}px`;
          button.style.top = `${Math.round(point.y)}px`;
        }
      };

      function syncControls() {
        const allowed = canOperateFeatureControl(api);
        for (const { feature, button } of controls.values()) {
          const state = api.interaction.stateForFeature(feature.id);
          const action = featureControlAction(state);
          button.hidden = Boolean(state?.destroyed);
          button.dataset.controlState = state?.open ? 'open' : 'closed';
          button.dataset.controlPermission = allowed ? 'allowed' : 'denied';
          button.setAttribute('aria-pressed', state?.open ? 'true' : 'false');
          button.setAttribute('aria-disabled', allowed && action ? 'false' : 'true');
          button.title = allowed
            ? featureControlTitle(feature, state)
            : `${featureControlTitle(feature, state)} · Player 暂无权限`;
        }
        positionControls();
      }

      const mapEvents = ['move', 'zoom', 'viewreset', 'resize'];
      mapEvents.forEach((eventName) => api.map.on?.(eventName, positionControls));
      const unsubscribers = [
        api.on?.('interaction:state-change', syncControls),
        api.on?.('interaction:executed', syncControls),
        api.on?.('scene:damage', syncControls),
        api.on?.('scene:restore', syncControls),
        api.on?.('state:import', syncControls),
      ].filter(Boolean);

      syncControls();

      api.featureControls = Object.freeze({
        sync: syncControls,
        descriptors: () => [...controls.values()].map(({ feature, descriptor }) => Object.freeze({
          featureId: String(feature.id),
          ...descriptor,
        })),
      });

      api.on?.('app:destroy', () => {
        mapEvents.forEach((eventName) => api.map.off?.(eventName, positionControls));
        unsubscribers.forEach((unsubscribe) => unsubscribe?.());
        layer.remove();
      });
    },
  };
}
