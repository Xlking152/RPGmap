import { BUILT_IN_LANZHOU_MAP, BUILT_IN_LANZHOU_MAP_BOUNDS } from '../map-package/constants.js';
import { applyWorldOperations as applyCoreWorldOperations } from '../world/operations.js';

export * from '../world/operations.js';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sceneById(state, sceneId) {
  const world = state?.preferences?.worldV2;
  const scenes = Array.isArray(world?.scenes) ? world.scenes : [];
  const target = String(sceneId ?? world?.activeSceneId ?? '');
  return scenes.find(scene => String(scene?.id ?? '') === target) || null;
}

function trustedMetricsForScene(scene) {
  const ref = object(scene?.mapPackage);
  let width = positive(ref.width);
  let height = positive(ref.height);

  // Existing v2.2.x worlds persisted only map id/version. Keep a trusted
  // built-in fallback so old Lanzhou saves immediately gain exact bounds after
  // upgrading, without requiring the client to rewrite the Scene first.
  if ((!width || !height) && String(ref.id ?? ref.mapId ?? '') === BUILT_IN_LANZHOU_MAP.id) {
    width = BUILT_IN_LANZHOU_MAP_BOUNDS.width;
    height = BUILT_IN_LANZHOU_MAP_BOUNDS.height;
  }

  return width && height ? { metersPerUnit: 1, width, height } : null;
}

function trustedMetricsForOperations(state, operations) {
  const fogSceneIds = new Set((Array.isArray(operations) ? operations : [])
    .filter(operation => String(operation?.type || '').startsWith('scene.fog.'))
    .map(operation => String(operation?.payload?.sceneId || ''))
    .filter(Boolean));
  if (!fogSceneIds.size) return null;

  const metrics = [...fogSceneIds].map(sceneId => trustedMetricsForScene(sceneById(state, sceneId)));
  if (metrics.some(value => !value)) return null;
  const first = metrics[0];
  if (metrics.some(value => value.width !== first.width || value.height !== first.height
    || value.metersPerUnit !== first.metersPerUnit)) return null;
  return first;
}

export function applyWorldOperations(state, operations, context = {}) {
  const existing = object(context.mapMetrics);
  const hasTrustedBounds = positive(existing.width) && positive(existing.height);
  const inferred = hasTrustedBounds ? null : trustedMetricsForOperations(state, operations);
  return applyCoreWorldOperations(state, operations, {
    ...context,
    mapMetrics: inferred ? { ...existing, ...inferred } : existing,
  });
}
