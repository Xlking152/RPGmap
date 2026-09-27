import { normalizeVisionOccluder, inspectLineOfSight } from '../spatial/kernel.js';
import { queryOccluders } from '../spatial/index.js';
import { finishWorkSync } from './work.js';

// A ground target is hidden by a solid footprint or by the projection of one
// of its edges away from the eye. Rasterize those shadows by row, not by ray
// casting every cell against every building. Holes remain separate rings.
export function* groundShadowRowsSteps(source, radiusUnits, occluders, cellUnits, circleRows) {
  const insideSolid = !inspectLineOfSight({ from: source, to: source, occluders }).clear;
  const shapes = [];
  const add = rings => {
    const edges = [];
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (a[1] === b[1]) continue;
      edges.push({ a, b, minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
    }
    shapes.push({ edges, minY: Math.min(...edges.map(e => e.minY)), maxY: Math.max(...edges.map(e => e.maxY)) });
  };
  const extent = radiusUnits + cellUnits;
  for (const raw of queryOccluders(occluders, [source.x - extent, source.y - extent, source.x + extent, source.y + extent])) {
    const obstacle = normalizeVisionOccluder(raw);
    if (!obstacle) continue;
    for (const rings of obstacle.polygons) {
      const outer = rings[0];
      if (outer.every(p => p[0] < source.x - radiusUnits - cellUnits)
        || outer.every(p => p[0] > source.x + radiusUnits + cellUnits)
        || outer.every(p => p[1] < source.y - radiusUnits - cellUnits)
        || outer.every(p => p[1] > source.y + radiusUnits + cellUnits)) continue;
      add(rings);
      for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
        const ring = rings[ringIndex];
        const area = ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
        for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((source.x - a[0]) * dx + (source.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const distance = Math.hypot(a[0] + t * dx - source.x, a[1] + t * dy - source.y);
        // Degenerate eye-on-wall cases use the reference kernel.
        if (distance < 1e-7) return null;
        // Below a wall top, its entering edges alone cast the same unbounded
        // shadow. Exit edges duplicate it. Hole winding may be arbitrary.
        const side = dx * (source.y - a[1]) - dy * (source.x - a[0]);
        if (source.elevationMeters <= obstacle.blockingHeightMeters && area !== 0
          && (ringIndex === 0 ? side * area > 0 : side * area < 0)) continue;
        const limit = 2 + (radiusUnits + cellUnits * 2) / distance;
        const factor = source.elevationMeters > obstacle.blockingHeightMeters
          ? Math.min(limit, source.elevationMeters / (source.elevationMeters - obstacle.blockingHeightMeters)) : limit;
        if (factor <= 1) continue;
        const project = p => [source.x + (p[0] - source.x) * factor, source.y + (p[1] - source.y) * factor];
        add([[a, b, project(b), project(a)]]);
        }
      }
    }
  }
  if (insideSolid) return {};
  const result = {};
  shapes.sort((a, b) => a.minY - b.minY);
  let nextShape = 0;
  let active = [];
  for (const [rowKey, ranges] of Object.entries(circleRows)) {
    const y = (Number(rowKey) + 0.5) * cellUnits;
    const intervals = [];
    let fullyBlocked = false;
    while (nextShape < shapes.length && shapes[nextShape].minY <= y) active.push(shapes[nextShape++]);
    active = active.filter(shape => shape.maxY > y);
    for (const shape of active) {
      const xs = [];
      for (const { a, b, minY, maxY } of shape.edges) {
        if (y >= minY && y < maxY) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const left = xs[i], right = xs[i + 1];
        intervals.push([left, right]);
        if ((ranges[0][0] + 0.5) * cellUnits > left + 1e-7
          && (ranges.at(-1)[1] + 0.5) * cellUnits < right - 1e-7) fullyBlocked = true;
      }
      if (fullyBlocked) break;
    }
    if (fullyBlocked) { yield; continue; }
    intervals.sort((a, b) => a[0] - b[0]);
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
      const clear = inspectLineOfSight({ from: source, to: { x: (column + 0.5) * cellUnits, y, elevationMeters: 0 }, occluders }).clear;
      const index = visible.findIndex(([a, b]) => column >= a && column <= b);
      if (clear && index < 0) visible.push([column, column]);
      else if (!clear && index >= 0) {
        const [a, b] = visible.splice(index, 1)[0];
        if (a < column) visible.push([a, column - 1]);
        if (column < b) visible.push([column + 1, b]);
      }
    }
    visible.sort((a, b) => a[0] - b[0]);
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
