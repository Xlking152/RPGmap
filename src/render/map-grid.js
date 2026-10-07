import { worldToLatLng, latLngToWorld } from '../engine/geometry.js';

// Grid lines depend on the viewport and spacing, not World/Fog revisions.
export function createMapGridRenderer({ map, mapPackage, layer, leaflet, getSpacing }) {
  let lastViewport = null;
  return function renderGrid() {
    const spacing = getSpacing(), bounds = map.getBounds();
    const northWest = latLngToWorld({ lat: bounds.getNorth(), lng: bounds.getWest() }, mapPackage.height);
    const southEast = latLngToWorld({ lat: bounds.getSouth(), lng: bounds.getEast() }, mapPackage.height);
    const clamp = (value, maximum) => Math.min(maximum, Math.max(0, value));
    const minX = clamp(Math.min(northWest.x, southEast.x), mapPackage.width);
    const maxX = clamp(Math.max(northWest.x, southEast.x), mapPackage.width);
    const minY = clamp(Math.min(northWest.y, southEast.y), mapPackage.height);
    const maxY = clamp(Math.max(northWest.y, southEast.y), mapPackage.height);
    const viewport = [spacing, minX, maxX, minY, maxY, mapPackage.height];
    if (lastViewport && viewport.every((value, index) => value === lastViewport[index])) return false;
    lastViewport = null;
    layer.clearLayers();
    const options = { pane: 'gridPane', interactive: false, weight: 0.7, className: 'grid-minor' };
    for (let x = Math.floor(minX / spacing) * spacing; x <= maxX + spacing; x += spacing) {
      leaflet.polyline([worldToLatLng({ x, y: minY }, mapPackage.height),
        worldToLatLng({ x, y: maxY }, mapPackage.height)], options).addTo(layer);
    }
    for (let y = Math.floor(minY / spacing) * spacing; y <= maxY + spacing; y += spacing) {
      leaflet.polyline([worldToLatLng({ x: minX, y }, mapPackage.height),
        worldToLatLng({ x: maxX, y }, mapPackage.height)], options).addTo(layer);
    }
    lastViewport = viewport;
    return true;
  };
}
