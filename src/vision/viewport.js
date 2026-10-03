import { worldToLatLng } from '../engine/geometry.js';

// Leaflet's latLngToContainerPoint rounds projected pixels. Fog needs an
// unrounded affine transform, especially at fractional negative zoom levels.
export function createVisionViewport(map, mapHeight) {
  let zero, unit;
  if (map.project && map.getPixelOrigin && map.layerPointToContainerPoint) {
    const pixelOrigin = map.getPixelOrigin();
    const project = point => {
      const projected = map.project(worldToLatLng(point, mapHeight), map.getZoom());
      return map.layerPointToContainerPoint([projected.x - pixelOrigin.x, projected.y - pixelOrigin.y]);
    };
    zero = project({ x: 0, y: 0 });
    unit = project({ x: 1, y: 1 });
  } else {
    // Adapters without project (including test doubles) still use a wide
    // baseline so a one-unit pixel-rounding collision cannot erase the mask.
    zero = map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, mapHeight));
    const far = map.latLngToContainerPoint(worldToLatLng({ x: 1024, y: 1024 }, mapHeight));
    unit = { x: zero.x + (far.x - zero.x) / 1024, y: zero.y + (far.y - zero.y) / 1024 };
  }
  const scaleX = unit.x - zero.x, scaleY = unit.y - zero.y;
  if (![zero.x, zero.y, scaleX, scaleY].every(Number.isFinite) || !scaleX || !scaleY)
    throw new Error('无法投影视野：地图坐标比例无效');
  const project = (x, y) => ({ x: zero.x + x * scaleX, y: zero.y + y * scaleY });
  const unproject = (x, y) => ({ x: (x - zero.x) / scaleX, y: (y - zero.y) / scaleY });
  return { zero, scaleX, scaleY, project, unproject,
    rectangle(x, y, width, height) {
      const corner = project(scaleX < 0 ? x + width : x, scaleY < 0 ? y + height : y);
      return { ...corner, width: Math.abs(width * scaleX), height: Math.abs(height * scaleY) };
    },
  };
}

export function visionZoomTransform(map, mapHeight, view) {
  const origin = map.containerPointToLayerPoint([0, 0]);
  if (!view) return `translate3d(${origin.x}px,${origin.y}px,0)`;
  const viewport = createVisionViewport(map, mapHeight), size = map.getSize();
  const scale = map.getZoomScale(view.zoom, map.getZoom());
  const zero = map.project(worldToLatLng({ x: 0, y: 0 }, mapHeight), view.zoom);
  const center = map.project(view.center, view.zoom);
  const x = origin.x + zero.x - center.x + size.x / 2 - scale * viewport.zero.x;
  const y = origin.y + zero.y - center.y + size.y / 2 - scale * viewport.zero.y;
  return `translate3d(${x}px,${y}px,0) scale(${scale})`;
}
