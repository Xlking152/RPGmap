import { featureToPolygon, pointInPolygon, polygonArea } from './geometry.js';
import { deriveSceneState } from './state.js';

const INSPECTABLE_CATEGORIES = new Set(['building', 'wall', 'vegetation', 'bridge']);
const IMPORTANCE_RANK = Object.freeze({ primary: 3, secondary: 2, detail: 1 });

function importanceRank(feature) {
  return IMPORTANCE_RANK[feature?.importance] || 0;
}

export function featureIdsForEvent(event) {
  if (!event || typeof event !== 'object') return [];
  const ids = event.type === 'restore'
    ? event.featureIds || []
    : [
        ...(event.objectIds || []),
        ...(event.clipHits || []).map(hit => hit.featureId)
      ];
  return [...new Set(ids.filter(id => typeof id === 'string' && id))];
}

export function inspectableFeaturesAtPoint(point, features = []) {
  return features
    .filter(feature => INSPECTABLE_CATEGORIES.has(feature.category) && !feature.severeOnly)
    .map(feature => {
      try {
        const polygon = featureToPolygon(feature);
        if (!pointInPolygon(point, polygon)) return null;
        return { feature, area: polygonArea(polygon) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => (
      importanceRank(right.feature) - importanceRank(left.feature)
      || left.area - right.area
      || left.feature.id.localeCompare(right.feature.id)
    ))
    .map(item => item.feature);
}

export function featureSceneStatus(featureId, sceneEvents = []) {
  const scene = deriveSceneState(sceneEvents);
  if (scene.destroyedObjectIds.includes(featureId)) return 'destroyed';
  if (scene.clipHits.some(hit => hit.featureId === featureId)) return 'partial';
  return 'intact';
}

export function featureBounds(featureIds, features = []) {
  const wanted = new Set(featureIds || []);
  const points = [];
  const collectPoints = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push({ x: Number(value[0]), y: Number(value[1]) });
      return;
    }
    value.forEach(collectPoints);
  };

  features.forEach(feature => {
    if (!wanted.has(feature.id)) return;
    try {
      collectPoints(featureToPolygon(feature));
    } catch {
      if (Array.isArray(feature.center)) collectPoints(feature.center);
    }
  });
  if (!points.length) return null;
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}
