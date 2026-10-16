import { Map } from 'leaflet/src/map/Map.js';
import { svg } from 'leaflet/src/layer/vector/SVG.js';

// RPGmap always renders Leaflet paths as SVG; Fog uses its own Canvas. Preserve
// upstream renderer selection and pane ownership without loading unused Canvas.
Map.include({
  getRenderer(layer) {
    let renderer = layer.options.renderer || this._getPaneRenderer(layer.options.pane) || this.options.renderer || this._renderer;
    if (!renderer) renderer = this._renderer = this._createRenderer();
    if (!this.hasLayer(renderer)) this.addLayer(renderer);
    return renderer;
  },
  _getPaneRenderer(name) {
    if (name === 'overlayPane' || name === undefined) return false;
    let renderer = this._paneRenderers[name];
    if (renderer === undefined) renderer = this._paneRenderers[name] = this._createRenderer({ pane: name });
    return renderer;
  },
  _createRenderer(options) {
    if (this.options.preferCanvas) throw new Error('RPGmap Leaflet paths require the SVG renderer');
    return svg(options);
  },
});
