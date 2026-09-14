import { createNavigationBase, createNavigationGrid, inspectDirectNavigationPath } from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import { tokenDiameterMeters, tokenElevationMeters } from '../elevation/model.js';

const DIAMETERS = new Set([1, 5, 10, 20]);

export function createMovementPlacementInspector(api) {
  const base = createNavigationBase(api.mapPackage);
  return (tokenId, rawPoint, options = {}) => {
    const point = { x: Number(rawPoint?.x), y: Number(rawPoint?.y) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { valid: false, code: 'invalid_destination', reason: 'Token 放置位置无效' };
    }
    const token = tokenId ? api.tokens?.get?.(tokenId) : null;
    const requestedDiameter = Number(options.diameterMeters);
    const requestedElevation = Number(options.elevationMeters);
    const diameterMeters = DIAMETERS.has(requestedDiameter) ? requestedDiameter : tokenDiameterMeters(token);
    const elevationMeters = Number.isFinite(requestedElevation) && requestedElevation >= 0
      ? requestedElevation : tokenElevationMeters(token);
    const state = api.getState?.() || {};
    const scene = api.world?.getActiveScene?.();
    if (!scene) return { valid: false, code: 'scene_not_active', reason: '当前没有活动 Scene' };
    const result = inspectDirectNavigationPath(createNavigationGrid(
      api.mapPackage,
      deriveSceneState(scene.sceneEvents || state.sceneEvents || []),
      base,
      { appState: state, moverContext: { tokenId, elevationMeters, diameterMeters, collisionBypassGroups: [] } },
    ), point, point, { diameterMeters, allowBlockedStartEscape: false });
    if (result.valid) return { valid: true, code: 'ok' };
    const outside = result.reason === 'outside-map';
    return {
      valid: false,
      code: outside ? 'placement_outside_map' : 'placement_blocked',
      reason: outside ? 'Token 放置位置超出地图范围' : 'Token 放置位置与不可通行区域重叠',
    };
  };
}
