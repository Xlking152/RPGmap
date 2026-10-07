import { featureToPolygon } from '../engine/geometry.js';

function isPoint(value) {
  return Array.isArray(value) && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
}

/** Display geometry only: no polygon boolean operation is needed to make SVG masks. */
export function ruinsPolygons(value) {
  const shape = featureToPolygon(value);
  if (!shape.length) return [];
  if (isPoint(shape[0])) return [[shape]];
  if (isPoint(shape[0]?.[0])) return [shape];
  return shape;
}

export function ruinsPath(rings) {
  return rings.map((ring) => ring.length < 3 ? '' : (
    `M ${ring.map((point) => `${point[0]} ${point[1]}`).join(' L ')} Z`
  )).join(' ');
}

export function ruinsBounds(polygons) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of polygons) for (const ring of rings) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return { minX, minY, maxX, maxY };
}

function stableVariant(value, count) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

export function resolveRuinsResource(feature, artAssets = {}, severe = false) {
  const style = artAssets.ruins?.[feature.ruinStyle] ?? artAssets.ruins?.[feature.category];
  const configured = severe ? style?.severe ?? style?.normal : style?.normal;
  const resource = typeof configured === 'string' ? { url: configured } : configured;
  if (resource?.url) return resource;
  const atlas = artAssets.rubbleAtlas;
  if (atlas?.url && feature.category === 'building') return atlas;
  return null;
}

/** Always lay the same texture over the original object, even when only one corner is damaged. */
export function ruinsImageLayout(feature, bounds, resource) {
  const baseWidth = Math.max(1e-8, bounds.maxX - bounds.minX);
  const baseHeight = Math.max(1e-8, bounds.maxY - bounds.minY);
  const align = resource?.align || {};
  const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const columns = Math.max(1, Math.floor(positive(resource?.columns, 1)));
  const rows = Math.max(1, Math.floor(positive(resource?.rows, 1)));
  const variant = stableVariant(feature.id, columns * rows);
  const column = resource?.column == null ? variant % columns : Math.max(0, Math.min(columns - 1, Math.floor(resource.column)));
  const row = resource?.row == null ? Math.floor(variant / columns) : Math.max(0, Math.min(rows - 1, Math.floor(resource.row)));
  const sourceWidth = positive(resource?.width, columns);
  const sourceHeight = positive(resource?.height, rows);
  return {
    x: bounds.minX + finite(align.offsetX), y: bounds.minY + finite(align.offsetY),
    width: baseWidth * positive(align.scaleX, 1), height: baseHeight * positive(align.scaleY, 1),
    sourceWidth, sourceHeight,
    viewBox: `${column * sourceWidth / columns} ${row * sourceHeight / rows} ${sourceWidth / columns} ${sourceHeight / rows}`,
    variant,
  };
}
