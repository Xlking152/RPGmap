// Keep the application's Leaflet APIs and original interaction hooks in one
// facade. Its entry adapter chooses the path renderer at the build boundary.
import { map } from 'leaflet/src/map/index.js';
import { Simple } from 'leaflet/src/geo/crs/CRS.Simple.js';
import * as DomEvent from 'leaflet/src/dom/DomEvent.js';
import { toLatLngBounds as latLngBounds } from 'leaflet/src/geo/LatLngBounds.js';
import { svgOverlay } from 'leaflet/src/layer/SVGOverlay.js';
import { layerGroup } from 'leaflet/src/layer/LayerGroup.js';
import { marker } from 'leaflet/src/layer/marker/Marker.js';
import { divIcon } from 'leaflet/src/layer/marker/DivIcon.js';
import { circleMarker } from 'leaflet/src/layer/vector/CircleMarker.js';
import { polyline } from 'leaflet/src/layer/vector/Polyline.js';
import { polygon } from 'leaflet/src/layer/vector/Polygon.js';
import { rectangle } from 'leaflet/src/layer/vector/Rectangle.js';
import { tooltip } from 'leaflet/src/layer/Tooltip.js';
import 'leaflet/src/control/Control.Zoom.js';

export default { map, CRS: { Simple }, DomEvent, latLngBounds, svgOverlay,
  layerGroup, marker, divIcon, circleMarker, polyline, polygon, rectangle, tooltip };
