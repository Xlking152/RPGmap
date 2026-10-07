import { normalizeVisionOccluder, inspectLineOfSight, visionOccludersForSource, resolveSourceHostOccluderId } from '../spatial/kernel.js';
import { queryOccluders, boundsOf } from '../spatial/index.js';
import { finishWorkSync } from './work.js';

const ascendingNumber = (a, b) => a - b;
const ascendingInterval = (a, b) => a[0] - b[0];
const ringAreas = new WeakMap();

function normalizedRingArea(ring) {
  const cached = ringAreas.get(ring);
  if (cached !== undefined) return cached;
  // Only privately normalized, recursively frozen rings reach this helper.
  // Their winding is independent of the observer; retain the exact sum order.
  const area = ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
  ringAreas.set(ring, area);
  return area;
}

/** Continuous shadows use the same edge projection as authoritative five-metre Fog. */
export function projectVisionOcclusion({ source, radiusUnits, occluders = [], metersPerUnit = 1,
  paddingUnits = 0, includeFacades = true } = {}) {
  const hostOccluderId = resolveSourceHostOccluderId(source, occluders, metersPerUnit);
  const visibleOccluders = visionOccludersForSource(source, occluders, metersPerUnit);
  const shadows = [], facades = [], owners = [];
  const result = { shadows, facades, fallback: false, blocked: false, hostOccluderId };
  if (!source || !Number.isFinite(radiusUnits) || radiusUnits <= 0) return result;
  if (!inspectLineOfSight({ from: source, to: source, occluders: visibleOccluders }).clear) {
    const epsilon = 1e-7 / Math.max(1e-6, metersPerUnit);
    const boundary = queryOccluders(visibleOccluders, [source.x, source.y, source.x, source.y]).some(raw => {
      const obstacle = normalizeVisionOccluder(raw);
      return obstacle?.polygons.some(rings => rings.some(ring => ring.some((a, i) => {
        const b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((source.x - a[0]) * dx + (source.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(a[0] + t * dx - source.x, a[1] + t * dy - source.y) <= epsilon;
      })));
    });
    return { ...result, fallback: boundary, blocked: !boundary };
  }
  const extent = radiusUnits + paddingUnits;
  const candidates = [];
  const add = (rings, id) => { shadows.push(rings); if (includeFacades) owners.push(id); };
  for (const raw of queryOccluders(visibleOccluders, [source.x - extent, source.y - extent, source.x + extent, source.y + extent])) {
    const obstacle = normalizeVisionOccluder(raw);
    if (!obstacle) continue;
    if (includeFacades) candidates.push(obstacle);
    for (const rings of obstacle.polygons) {
      const outer = rings[0];
      if (outer.every(p => p[0] < source.x - extent) || outer.every(p => p[0] > source.x + extent)
        || outer.every(p => p[1] < source.y - extent) || outer.every(p => p[1] > source.y + extent)) continue;
      add(rings, obstacle.id);
      for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
        const ring = rings[ringIndex];
        const area = normalizedRingArea(ring);
        for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((source.x - a[0]) * dx + (source.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const distance = Math.hypot(a[0] + t * dx - source.x, a[1] + t * dy - source.y);
        // Degenerate eye-on-wall cases use the reference kernel.
        if (distance < 1e-7 / Math.max(1e-6, metersPerUnit)) return { ...result, fallback: true };
        // Below a wall top, its entering edges alone cast the same unbounded
        // shadow. Exit edges duplicate it. Hole winding may be arbitrary.
        const side = dx * (source.y - a[1]) - dy * (source.x - a[0]);
        if (source.elevationMeters <= obstacle.blockingHeightMeters && area !== 0
          && (ringIndex === 0 ? side * area > 0 : side * area < 0)) continue;
        const limit = 2 + (radiusUnits + paddingUnits * 2) / distance;
        const factor = source.elevationMeters > obstacle.blockingHeightMeters
          ? Math.min(limit, source.elevationMeters / (source.elevationMeters - obstacle.blockingHeightMeters)) : limit;
        if (factor <= 1) continue;
        const project = p => [source.x + (p[0] - source.x) * factor, source.y + (p[1] - source.y) * factor];
        add([[a, b, project(b), project(a)]], obstacle.id);
        }
      }
    }
  }
  const shadowBounds = includeFacades ? shadows.map(rings => boundsOf(rings.flat())) : [];
  if (includeFacades) for (const obstacle of candidates) {
    if (obstacle.kind !== 'building') continue;
    // A facade is presentation only. It cannot make a Token or Fog cell visible.
    const visibleFront = obstacle.polygons.some(([ring]) => ring.some((a, i) => {
      const b = ring[(i + 1) % ring.length];
      return [0, 0.25, 0.5, 0.75, 1].some(t => {
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        const distance = Math.hypot(x - source.x, y - source.y);
        if (distance > radiusUnits || distance < 1e-9) return false;
        const inset = Math.min(0.5, 1e-6 / Math.max(1e-6, metersPerUnit) / distance);
        return inspectLineOfSight({ from: source, to: {
          x: x + (source.x - x) * inset, y: y + (source.y - y) * inset, elevationMeters: 0,
        }, occluders: visibleOccluders }).clear;
      });
    }));
    if (!visibleFront) continue;
    const box = boundsOf(obstacle.polygons.flat(2));
    const otherShadowIndices = [];
    for (let index = 0; index < shadows.length; index++) {
      const bounds = shadowBounds[index];
      if (owners[index] !== obstacle.id && bounds[0] <= box[2] && bounds[2] >= box[0]
        && bounds[1] <= box[3] && bounds[3] >= box[1]) otherShadowIndices.push(index);
    }
    // Presentation uses an alpha mask instead of floating-point polygon
    // difference. Destruction edges can coincide with several projected edges
    // and make the clipping library's sweep queue fail. Index the shared shadow
    // array so Worker results do not copy the same projected polygons per facade.
    facades.push({ id: obstacle.id, featureId: obstacle.featureId,
      polygons: obstacle.polygons, otherShadowIndices });
  }
  return result;
}

// Rasterize projected regions by row, retaining precise boundary checks and
// the historical exact-ray fallback for wall-adjacent or degenerate sources.
export function* groundShadowRowsSteps(source, radiusUnits, occluders, cellUnits, circleRows, metersPerUnit = 1) {
  const projection = projectVisionOcclusion({ source, radiusUnits, occluders, metersPerUnit,
    paddingUnits: cellUnits, includeFacades: false });
  const visibleOccluders = visionOccludersForSource(source, occluders, metersPerUnit);
  if (projection.blocked) return {};
  if (projection.fallback) return null;
  const shapes = projection.shadows.map(rings => {
    const edges = [];
    let minY = Infinity, maxY = -Infinity;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (a[1] !== b[1]) {
        const edge = { ax: a[0], ay: a[1], dx: b[0] - a[0], dy: b[1] - a[1],
          minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) };
        edges.push(edge);
        minY = Math.min(minY, edge.minY); maxY = Math.max(maxY, edge.maxY);
      }
    }
    return { edges, minY, maxY };
  });
  const result = {};
  shapes.sort((a, b) => a.minY - b.minY);
  let nextShape = 0;
  const active = [], xs = [];
  for (const [rowKey, ranges] of Object.entries(circleRows)) {
    const y = (Number(rowKey) + 0.5) * cellUnits;
    const firstCenter = ranges.length ? (ranges[0][0] + 0.5) * cellUnits : undefined;
    const lastCenter = ranges.length ? (ranges.at(-1)[1] + 0.5) * cellUnits : undefined;
    const intervals = [];
    let fullyBlocked = false;
    while (nextShape < shapes.length && shapes[nextShape].minY <= y) active.push(shapes[nextShape++]);
    let activeCount = 0;
    for (let index = 0; index < active.length; index++) {
      const shape = active[index];
      if (shape.maxY > y) active[activeCount++] = shape;
    }
    active.length = activeCount;
    for (const shape of active) {
      xs.length = 0;
      for (const { ax, ay, dx, dy, minY, maxY } of shape.edges) {
        // Preserve multiplication followed by division; reassociating this
        // expression can change grid tangencies through floating-point rounding.
        if (y >= minY && y < maxY) xs.push(ax + (y - ay) * dx / dy);
      }
      xs.sort(ascendingNumber);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const left = xs[i], right = xs[i + 1];
        intervals.push([left, right]);
        if ((firstCenter ?? (ranges[0][0] + 0.5) * cellUnits) > left + 1e-7
          && (lastCenter ?? (ranges.at(-1)[1] + 0.5) * cellUnits) < right - 1e-7) fullyBlocked = true;
      }
      if (fullyBlocked) break;
    }
    if (fullyBlocked) { yield; continue; }
    intervals.sort(ascendingInterval);
    const merged = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const visible = [];
    for (const [start, end] of ranges) {
      let cursor = start;
      for (const [left, right] of merged) {
        const first = Math.max(start, Math.ceil(left / cellUnits - 0.5));
        const last = Math.min(end, Math.ceil(right / cellUnits - 0.5) - 1);
        if (last < first) continue;
        if (first > cursor) visible.push([cursor, first - 1]);
        cursor = Math.max(cursor, last + 1);
      }
      if (cursor <= end) visible.push([cursor, end]);
    }
    // Exact ray checks only at shadow boundaries preserve tangency semantics.
    const boundary = new Set();
    for (const [left, right] of intervals) for (const x of [left, right]) {
      const column = Math.round(x / cellUnits - 0.5);
      if (Math.abs((column + 0.5) * cellUnits - x) < 1e-7
        && ranges.some(([a, b]) => column >= a && column <= b)) boundary.add(column);
    }
    for (const column of boundary) {
      const clear = inspectLineOfSight({ from: source, to: { x: (column + 0.5) * cellUnits, y, elevationMeters: 0 }, occluders: visibleOccluders }).clear;
      const index = visible.findIndex(([a, b]) => column >= a && column <= b);
      if (clear && index < 0) visible.push([column, column]);
      else if (!clear && index >= 0) {
        const [a, b] = visible.splice(index, 1)[0];
        if (a < column) visible.push([a, column - 1]);
        if (column < b) visible.push([column + 1, b]);
      }
    }
    visible.sort(ascendingInterval);
    const compact = [];
    for (const span of visible) {
      const last = compact.at(-1);
      if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
      else compact.push(span);
    }
    if (compact.length) result[rowKey] = compact;
    yield;
  }
  return result;
}

export function groundShadowRows(...args) {
  return finishWorkSync(groundShadowRowsSteps(...args));
}
