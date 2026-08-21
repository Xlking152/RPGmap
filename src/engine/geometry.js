import polygonClipping from 'polygon-clipping';

const DEFAULT_WORLD_HEIGHT = 5000;
const DEFAULT_CIRCLE_SEGMENTS = 72;
const DEFAULT_MIN_COVERAGE = 0.25;
const EPSILON = 1e-9;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return number;
}

function pointXY(point, label = 'point') {
  if (Array.isArray(point) && point.length >= 2) {
    return {
      x: finiteNumber(point[0], `${label}.x`),
      y: finiteNumber(point[1], `${label}.y`),
    };
  }
  if (point && typeof point === 'object') {
    return {
      x: finiteNumber(point.x, `${label}.x`),
      y: finiteNumber(point.y, `${label}.y`),
    };
  }
  throw new TypeError(`${label} must be an {x, y} object or [x, y] tuple`);
}

function latLngValues(latLng) {
  if (Array.isArray(latLng) && latLng.length >= 2) {
    return {
      lat: finiteNumber(latLng[0], 'latLng.lat'),
      lng: finiteNumber(latLng[1], 'latLng.lng'),
    };
  }
  if (latLng && typeof latLng === 'object') {
    return {
      lat: finiteNumber(latLng.lat, 'latLng.lat'),
      lng: finiteNumber(latLng.lng ?? latLng.lon, 'latLng.lng'),
    };
  }
  throw new TypeError('latLng must be a {lat, lng} object or [lat, lng] tuple');
}

function cleanZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

function sameTuple(a, b) {
  return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

function isPointLike(value) {
  return (
    (Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) ||
    (value && typeof value === 'object' && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)))
  );
}

function closeRing(points) {
  if (!Array.isArray(points)) {
    throw new TypeError('polygon ring must be an array of points');
  }

  const ring = [];
  for (const point of points) {
    const { x, y } = pointXY(point, 'polygon point');
    const tuple = [x, y];
    if (!ring.length || !sameTuple(tuple, ring.at(-1))) ring.push(tuple);
  }

  if (ring.length > 1 && sameTuple(ring[0], ring.at(-1))) ring.pop();
  if (ring.length < 3) return [];
  ring.push([...ring[0]]);
  return ring;
}

function closePolygonShape(shape) {
  if (!Array.isArray(shape) || shape.length === 0) return [];
  if (isPointLike(shape[0])) return closeRing(shape);
  if (Array.isArray(shape[0]) && shape[0].length && isPointLike(shape[0][0])) {
    return shape.map(closeRing).filter((ring) => ring.length >= 4);
  }
  if (
    Array.isArray(shape[0]) &&
    Array.isArray(shape[0][0]) &&
    shape[0][0].length &&
    isPointLike(shape[0][0][0])
  ) {
    return shape
      .map((polygon) => polygon.map(closeRing).filter((ring) => ring.length >= 4))
      .filter((polygon) => polygon.length);
  }
  throw new TypeError('unsupported polygon nesting');
}

function isAttackArea(value) {
  const type = String(value?.shape ?? value?.attackShape ?? value?.type ?? '').toLowerCase();
  return Boolean(value && typeof value === 'object' && ['circle', 'sector', 'rectangle', 'rect'].includes(type));
}

function shapeFromValue(value) {
  if (isAttackArea(value)) return attackAreaToPolygon(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) return featureToPolygon(value);
  return value;
}

function toMultiPolygon(value) {
  const shape = closePolygonShape(shapeFromValue(value));
  if (!shape.length) return [];
  if (isPointLike(shape[0])) return [[shape]];
  if (Array.isArray(shape[0]) && shape[0].length && isPointLike(shape[0][0])) return [shape];
  return shape;
}

function signedRingArea(ring) {
  let doubleArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    doubleArea += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return doubleArea / 2;
}

function bearingVector(degrees) {
  const radians = (degrees * Math.PI) / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

function pointOnBearing(origin, distance, degrees) {
  const direction = bearingVector(degrees);
  return [origin.x + direction.x * distance, origin.y + direction.y * distance];
}

function positiveSize(value, label) {
  const size = finiteNumber(value, label);
  if (size <= 0) throw new RangeError(`${label} must be greater than zero`);
  return size;
}

function rectangleFromBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;

  if (
    Number.isFinite(Number(bounds.minX)) &&
    Number.isFinite(Number(bounds.minY)) &&
    Number.isFinite(Number(bounds.maxX)) &&
    Number.isFinite(Number(bounds.maxY))
  ) {
    const minX = Number(bounds.minX);
    const minY = Number(bounds.minY);
    const maxX = Number(bounds.maxX);
    const maxY = Number(bounds.maxY);
    return closeRing([
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ]);
  }

  if (
    Number.isFinite(Number(bounds.x)) &&
    Number.isFinite(Number(bounds.y)) &&
    Number.isFinite(Number(bounds.width)) &&
    Number.isFinite(Number(bounds.height))
  ) {
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    return closeRing([
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ]);
  }

  return null;
}

function normalizeCoverageThreshold(value) {
  if (value == null) return DEFAULT_MIN_COVERAGE;
  let threshold = finiteNumber(value, 'minCoverage');
  if (threshold > 1 && threshold <= 100) threshold /= 100;
  if (threshold < 0 || threshold > 1) throw new RangeError('minCoverage must be between 0 and 1');
  return threshold;
}

function ringPointRelation(point, ring) {
  let inside = false;

  for (let current = 0, previous = ring.length - 2; current < ring.length - 1; previous = current, current += 1) {
    const [x1, y1] = ring[previous];
    const [x2, y2] = ring[current];
    const cross = (point.x - x1) * (y2 - y1) - (point.y - y1) * (x2 - x1);
    const scale = Math.max(1, Math.abs(x2 - x1), Math.abs(y2 - y1));
    if (Math.abs(cross) <= EPSILON * scale) {
      const dot = (point.x - x1) * (point.x - x2) + (point.y - y1) * (point.y - y2);
      if (dot <= EPSILON) return { inside: true, boundary: true };
    }

    const crossesRay = y1 > point.y !== y2 > point.y;
    if (crossesRay) {
      const intersectionX = x1 + ((point.y - y1) * (x2 - x1)) / (y2 - y1);
      if (intersectionX > point.x) inside = !inside;
    }
  }

  return { inside, boundary: false };
}

function categoryFilter(categories) {
  if (categories == null) return null;
  if (categories instanceof Set) return categories;
  if (Array.isArray(categories)) return new Set(categories);
  return new Set([categories]);
}

/** Convert top-left-origin world coordinates to Leaflet's Simple CRS coordinates. */
export function worldToLatLng(point, height = DEFAULT_WORLD_HEIGHT) {
  const { x, y } = pointXY(point, 'world point');
  const worldHeight = finiteNumber(height, 'height');
  return { lat: worldHeight - y, lng: x };
}

/** Convert Leaflet Simple CRS coordinates back to top-left-origin world coordinates. */
export function latLngToWorld(latLng, height = DEFAULT_WORLD_HEIGHT) {
  const { lat, lng } = latLngValues(latLng);
  const worldHeight = finiteNumber(height, 'height');
  return { x: lng, y: worldHeight - lat };
}

export function distanceMeters(from, to, metersPerUnit = 1) {
  const start = pointXY(from, 'from');
  const end = pointXY(to, 'to');
  const scale = positiveSize(metersPerUnit, 'metersPerUnit');
  return Math.hypot(end.x - start.x, end.y - start.y) * scale;
}

export function formatDistance(meters) {
  const distance = finiteNumber(meters, 'meters');
  if (distance < 0) throw new RangeError('meters must not be negative');
  return distance >= 1000 ? `${(distance / 1000).toFixed(2)}公里` : `${Math.round(distance)}米`;
}

export function snapValue(value, step = 'free') {
  const number = finiteNumber(value, 'value');
  if (step == null || step === false || step === 'free' || step === 0 || step === '0') return number;
  const grid = positiveSize(step, 'step');
  const snapped = Math.sign(number) * Math.round(Math.abs(number) / grid) * grid;
  return cleanZero(snapped);
}

export function snapPoint(point, step = 'free') {
  const { x, y } = pointXY(point);
  return { x: snapValue(x, step), y: snapValue(y, step) };
}

export function markerIdsInBounds(markers, start, end) {
  if (!Array.isArray(markers)) throw new TypeError('markers must be an array');
  const from = pointXY(start, 'start');
  const to = pointXY(end, 'end');
  const minX = Math.min(from.x, to.x);
  const maxX = Math.max(from.x, to.x);
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);

  return markers
    .filter((marker, index) => {
      const point = pointXY(marker, `markers[${index}]`);
      return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
    })
    .map(marker => String(marker.id));
}

/**
 * Build a closed polygon ring from an attack-area description.
 * Headings use game-map bearings: 0 degrees is up and positive angles turn clockwise.
 * A rectangle's origin is the center of its rear edge and its length extends forward.
 */
export function attackAreaToPolygon(area, options = {}) {
  if (!area || typeof area !== 'object') throw new TypeError('attack area must be an object');
  const shape = String(area.shape ?? area.attackShape ?? area.type ?? '').toLowerCase();
  const origin = pointXY(area.origin ?? area.center, 'attack area origin');
  const heading = finiteNumber(area.headingDeg ?? area.heading ?? 0, 'headingDeg');
  const requestedSegments = options.segments ?? area.segments ?? DEFAULT_CIRCLE_SEGMENTS;
  const segments = Math.max(8, Math.round(positiveSize(requestedSegments, 'segments')));

  if (shape === 'circle') {
    const radius = positiveSize(area.radius ?? area.range, 'radius');
    const points = [];
    for (let index = 0; index < segments; index += 1) {
      points.push(pointOnBearing(origin, radius, heading + (index * 360) / segments));
    }
    return closeRing(points);
  }

  if (shape === 'sector') {
    const range = positiveSize(area.range ?? area.radius, 'range');
    const angle = positiveSize(area.angleDeg ?? area.angle, 'angleDeg');
    if (angle >= 360 - EPSILON) {
      return attackAreaToPolygon({ ...area, shape: 'circle', origin, radius: range }, { segments });
    }
    const arcSegments = Math.max(2, Math.ceil((segments * angle) / 360));
    const startHeading = heading - angle / 2;
    const points = [[origin.x, origin.y]];
    for (let index = 0; index <= arcSegments; index += 1) {
      points.push(pointOnBearing(origin, range, startHeading + (index * angle) / arcSegments));
    }
    return closeRing(points);
  }

  if (shape === 'rectangle' || shape === 'rect') {
    const length = positiveSize(area.length ?? area.range, 'length');
    const width = positiveSize(area.width, 'width');
    const forward = bearingVector(heading);
    const right = { x: -forward.y, y: forward.x };
    const halfWidth = width / 2;
    const end = { x: origin.x + forward.x * length, y: origin.y + forward.y * length };
    return closeRing([
      [origin.x - right.x * halfWidth, origin.y - right.y * halfWidth],
      [origin.x + right.x * halfWidth, origin.y + right.y * halfWidth],
      [end.x + right.x * halfWidth, end.y + right.y * halfWidth],
      [end.x - right.x * halfWidth, end.y - right.y * halfWidth],
    ]);
  }

  throw new RangeError(`unsupported attack area shape: ${shape || '(empty)'}`);
}

export function polygonArea(polygon) {
  const multiPolygon = toMultiPolygon(polygon);
  let total = 0;
  for (const rings of multiPolygon) {
    if (!rings.length) continue;
    let area = Math.abs(signedRingArea(rings[0]));
    for (let index = 1; index < rings.length; index += 1) {
      area -= Math.abs(signedRingArea(rings[index]));
    }
    total += Math.max(0, area);
  }
  return cleanZero(total);
}

export function featureToPolygon(feature) {
  if (Array.isArray(feature)) return closePolygonShape(feature);
  if (!feature || typeof feature !== 'object') throw new TypeError('feature must be an object');
  if (isAttackArea(feature)) return attackAreaToPolygon(feature);

  const geometry = feature.geometry ?? feature;
  const type = String(geometry.type ?? '').toLowerCase();
  if (type === 'polygon') {
    const points = geometry.points ?? geometry.coordinates;
    if (!points) throw new TypeError('polygon geometry requires points');
    return closePolygonShape(points);
  }
  if (type === 'multipolygon') {
    if (!geometry.coordinates) throw new TypeError('MultiPolygon geometry requires coordinates');
    return closePolygonShape(geometry.coordinates);
  }

  if (geometry.points) return closePolygonShape(geometry.points);
  if (feature.polygon) return closePolygonShape(feature.polygon);
  const boundsPolygon = rectangleFromBounds(geometry.bounds ?? feature.bounds);
  if (boundsPolygon) return boundsPolygon;
  throw new RangeError(`unsupported feature geometry type: ${geometry.type ?? '(empty)'}`);
}

export function intersectionArea(left, right) {
  const leftMulti = toMultiPolygon(left);
  const rightMulti = toMultiPolygon(right);
  if (!leftMulti.length || !rightMulti.length) return 0;
  const intersection = polygonClipping.intersection(leftMulti, rightMulti);
  return polygonArea(intersection);
}

/**
 * Subtract `clipping` from `subject` and return the resulting MultiPolygon
 * (an array of polygons, each an array of rings). Returns an empty array when
 * nothing remains.
 */
export function polygonDifference(subject, clipping) {
  const subjectMulti = toMultiPolygon(subject);
  const clipMulti = toMultiPolygon(clipping);
  if (!subjectMulti.length) return [];
  if (!clipMulti.length) return subjectMulti;
  return polygonClipping.difference(subjectMulti, clipMulti);
}

export function coverageRatio(target, coveringPolygon) {
  const targetArea = polygonArea(target);
  if (targetArea <= EPSILON) return 0;
  const ratio = intersectionArea(target, coveringPolygon) / targetArea;
  return Math.min(1, Math.max(0, ratio));
}

export function pointInPolygon(point, polygon, includeBoundary = true) {
  const candidate = pointXY(point);
  const multiPolygon = toMultiPolygon(polygon);

  for (const rings of multiPolygon) {
    if (!rings.length) continue;
    const outer = ringPointRelation(candidate, rings[0]);
    if (outer.boundary) {
      if (includeBoundary) return true;
      continue;
    }
    if (!outer.inside) continue;

    let excludedByHole = false;
    for (let index = 1; index < rings.length; index += 1) {
      const hole = ringPointRelation(candidate, rings[index]);
      if (hole.boundary) {
        if (includeBoundary) return true;
        excludedByHole = true;
        break;
      }
      if (hole.inside) {
        excludedByHole = true;
        break;
      }
    }
    if (!excludedByHole) return true;
  }
  return false;
}

/**
 * Return hit details for the requested categories.
 * - clip features hit on any positive-area intersection.
 * - center mode hits when the feature center lies in the attack polygon.
 * - object mode hits at minCoverage (25% by default), inclusively, or on center hit.
 */
export function hitTestFeatures(areaOrPolygon, features, categories = null) {
  if (!Array.isArray(features)) throw new TypeError('features must be an array');
  const attackPolygon = isAttackArea(areaOrPolygon)
    ? attackAreaToPolygon(areaOrPolygon)
    : closePolygonShape(shapeFromValue(areaOrPolygon));
  const allowedCategories = categoryFilter(categories);
  const hits = [];

  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue;
    const category = feature.category ?? null;
    if (allowedCategories && !allowedCategories.has(category)) continue;

    let polygon;
    try {
      polygon = featureToPolygon(feature);
    } catch {
      continue;
    }

    const overlapArea = intersectionArea(polygon, attackPolygon);
    const targetArea = polygonArea(polygon);
    const coverage = targetArea <= EPSILON ? 0 : Math.min(1, Math.max(0, overlapArea / targetArea));
    const centerHit = feature.center ? pointInPolygon(feature.center, attackPolygon) : false;
    const mode = String(feature.mode ?? feature.damageMode ?? (category === 'clip' ? 'clip' : 'object')).toLowerCase();
    const threshold = normalizeCoverageThreshold(feature.minCoverage);

    let hit;
    if (category === 'clip' || ['clip', 'intersection', 'any', 'any-intersection'].includes(mode)) {
      hit = overlapArea > EPSILON;
    } else if (['center', 'centre', 'center-hit'].includes(mode)) {
      hit = centerHit;
    } else if (['object', 'coverage-or-center', 'coverage+center', 'either', 'coverage'].includes(mode)) {
      // Object-like features are hit by any positive-area overlap; the
      // whole-vs-localized decision happens in createDamagePreview.
      hit = overlapArea > EPSILON;
    } else {
      hit = coverage + EPSILON >= threshold;
    }

    if (hit) {
      hits.push({
        feature,
        featureId: feature.id,
        category,
        mode,
        coverage,
        centerHit,
        intersectionArea: overlapArea,
      });
    }
  }

  return hits;
}

export function routeSegments(points) {
  if (!Array.isArray(points)) throw new TypeError('points must be an array');
  const route = points.map((point, index) => pointXY(point, `points[${index}]`));
  const segments = [];
  let total = 0;

  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1];
    const to = route[index];
    const length = distanceMeters(from, to);
    total += length;
    segments.push({ from: { ...from }, to: { ...to }, length, cumulative: total });
  }

  return { segments, total };
}
