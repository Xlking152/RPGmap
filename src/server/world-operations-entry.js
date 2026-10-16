import { applyWorldOperations as applyCoreWorldOperations, applyWorldOperationsAsync as applyCoreWorldOperationsAsync } from '../world/operations.js';

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

function trustedMetricsForScene(scene, context) {
  const ref = typeof context.mapForScene === 'function' ? object(context.mapForScene(scene)) : object(context.mapMetrics);
  let width = positive(ref.width);
  let height = positive(ref.height);

  return width && height ? { metersPerUnit: Number(ref.metersPerUnit) || 1, width, height } : null;
}

function trustedMetricsForOperations(state, operations, context) {
  const fogSceneIds = new Set((Array.isArray(operations) ? operations : [])
    .filter(operation => String(operation?.type || '').startsWith('scene.fog.')
      || ['token.move', 'token.movePath', 'token.reposition'].includes(String(operation?.type || '')))
    .map(operation => String(operation?.payload?.sceneId || state?.preferences?.worldV2?.activeSceneId || ''))
    .filter(Boolean));
  if (!fogSceneIds.size) return null;

  const metrics = [...fogSceneIds].map(sceneId => trustedMetricsForScene(sceneById(state, sceneId), context));
  if (metrics.some(value => !value)) return null;
  const first = metrics[0];
  if (metrics.some(value => value.width !== first.width || value.height !== first.height
    || value.metersPerUnit !== first.metersPerUnit)) return null;
  return first;
}

function trustedContext(state, operations, context) {
  const existing = object(context.mapMetrics);
  const hasTrustedBounds = positive(existing.width) && positive(existing.height);
  const inferred = hasTrustedBounds ? null : trustedMetricsForOperations(state, operations, context);
  return {
    ...context,
    mapMetrics: inferred ? { ...existing, ...inferred } : existing,
  };
}

export function applyWorldOperations(state, operations, context = {}) {
  return applyCoreWorldOperations(state, operations, trustedContext(state, operations, context));
}
export function applyWorldOperationsAsync(state, operations, context = {}) {
  return applyCoreWorldOperationsAsync(state, operations, trustedContext(state, operations, context));
}
