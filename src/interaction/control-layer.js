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
    .feature-map-control { position:absolute; display:grid; place-items:center; width:28px; height:28px; padding:0; border:2px solid rgba(33,45,47,.9); border-radius:7px; background:rgba(246,244,232,.95); box-shadow:0 2px 7px rgba(0,0,0,.28); color:#263436; font:800 15px/1 system-ui,sans-serif; cursor:pointer; pointer-events:auto; user-select:none; transform:translate(-50%,-50%); }
    .feature-map-control:hover { transform:translate(-50%,-50%) scale(1.08); }
    .feature-map-control[data-control-state="open"] { background:rgba(224,243,231,.96); border-color:#397858; }
    .feature-map-control[data-control-state="closed"] { background:rgba(249,236,220,.97); border-color:#8b5a32; }
    .feature-map-control[data-control-permission="denied"] { opacity:.62; cursor:not-allowed; }
    .feature-map-control[hidden] { display:none !important; }
    .feature-map-control .feature-control-glyph { pointer-events:none; }
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
        controls.set(String(feature.id), { feature, descriptor, button, glyph });
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
        for (const { feature, button, glyph } of controls.values()) {
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
          glyph.textContent = state?.open ? '◇' : '▮';
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
