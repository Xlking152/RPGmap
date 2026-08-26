import L from 'leaflet';

export function createStatusBadgeLayer(map) {
  return L.layerGroup([], { pane: 'statusBadgePane' }).addTo(map);
}

export function addStatusBadgeMarker(layer, { latLng, html, tokenPixels }) {
  return L.marker(latLng, {
    pane: 'statusBadgePane',
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: 'rpgmap-status-badge-marker',
      html,
      iconSize: [1, 1],
      iconAnchor: [-(tokenPixels / 2 + 3), tokenPixels / 2],
    }),
  }).addTo(layer);
}
