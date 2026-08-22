import { MOVEMENT_STEPS, normalizeMovementStep } from './snap.js';
export const MOVEMENT_DISTANCE_STEPS = MOVEMENT_STEPS;
export const normalizeMovementDistanceStep = normalizeMovementStep;

export function movementDisplayCost(distance, step = 5) {
  const normalizedStep = normalizeMovementStep(step);
  const meters = Math.max(0, Number(distance) || 0);
  if (!meters) return 0;
  return Math.ceil((meters - 1e-9) / normalizedStep) * normalizedStep;
}
function copyPoint(point) { return { x: Number(point.x), y: Number(point.y) }; }
function pointDistance(a, b) { return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y)); }
export function polylineDistance(points, metersPerUnit = 1) {
  let distance = 0;
  for (let index = 1; index < (points?.length || 0); index += 1) distance += pointDistance(points[index - 1], points[index]);
  return distance * Number(metersPerUnit || 1);
}
export function pointAlongPolyline(points, fraction = 0.5) {
  if (!points?.length) return null;
  if (points.length === 1) return copyPoint(points[0]);
  const lengths = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) { const length = pointDistance(points[index - 1], points[index]); lengths.push(length); total += length; }
  if (!total) return copyPoint(points[0]);
  const target = Math.max(0, Math.min(1, Number(fraction))) * total;
  let walked = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (walked + length >= target) {
      const local = length ? (target - walked) / length : 0;
      const from = points[index]; const to = points[index + 1];
      return { x: Number(from.x) + (Number(to.x) - Number(from.x)) * local, y: Number(from.y) + (Number(to.y) - Number(from.y)) * local };
    }
    walked += length;
  }
  return copyPoint(points.at(-1));
}
function nearestForwardIndex(points, point, startIndex) {
  let bestIndex = startIndex; let bestDistance = Infinity;
  for (let index = startIndex; index < points.length; index += 1) {
    const distance = pointDistance(points[index], point);
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  }
  return bestIndex;
}
export function splitRouteByWaypoints(routePoints, waypoints = [], metersPerUnit = 1) {
  const points = (routePoints || []).map(copyPoint);
  if (points.length < 2) return [];
  const boundaries = [0];
  let searchFrom = 1;
  for (const waypoint of waypoints) {
    const index = nearestForwardIndex(points, waypoint, searchFrom);
    const last = boundaries.at(-1);
    if (index <= last || index >= points.length - 1) continue;
    boundaries.push(index);
    searchFrom = Math.min(points.length - 1, index + 1);
  }
  boundaries.push(points.length - 1);
  const segments = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const fromIndex = boundaries[index]; const toIndex = boundaries[index + 1];
    if (toIndex <= fromIndex) continue;
    const segmentPoints = points.slice(fromIndex, toIndex + 1);
    const distance = polylineDistance(segmentPoints, metersPerUnit);
    if (distance <= 1e-9) continue;
    segments.push({ index: segments.length, points: segmentPoints, distance, midpoint: pointAlongPolyline(segmentPoints, 0.5) });
  }
  return segments;
}
export function summarizeMovementSegments(segments, step = 5) {
  const normalizedStep = normalizeMovementStep(step);
  const rows = (segments || []).map(segment => ({ ...segment, displayCost: movementDisplayCost(segment.distance, normalizedStep) }));
  return {
    step: normalizedStep,
    segments: rows,
    actualDistance: rows.reduce((sum, segment) => sum + segment.distance, 0),
    displayCost: rows.reduce((sum, segment) => sum + segment.displayCost, 0),
  };
}
