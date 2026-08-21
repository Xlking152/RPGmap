import { distanceMeters } from '../engine/geometry.js';

function finitePoint(point) {
  return Boolean(point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
}

export function segmentMidpoint(from, to) {
  if (!finitePoint(from) || !finitePoint(to)) return null;
  return { x: (Number(from.x) + Number(to.x)) / 2, y: (Number(from.y) + Number(to.y)) / 2 };
}

export function summarizeRulerPath(points, metersPerUnit = 1) {
  const clean = (Array.isArray(points) ? points : []).filter(finitePoint)
    .map(point => ({ x: Number(point.x), y: Number(point.y) }));
  const segments = [];
  let total = 0;
  for (let index = 1; index < clean.length; index += 1) {
    const from = clean[index - 1];
    const to = clean[index];
    const distance = distanceMeters(from, to, metersPerUnit);
    total += distance;
    segments.push({ index: index - 1, from, to, midpoint: segmentMidpoint(from, to), distance });
  }
  return { points: clean, segments, total };
}

export function formatRulerDistance(meters) {
  const value = Math.max(0, Number(meters) || 0);
  if (value >= 1000) {
    const km = value / 1000;
    return `${km >= 10 ? km.toFixed(1) : km.toFixed(2)} km`;
  }
  if (value >= 100) return `${Math.round(value)} m`;
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} m`;
}
