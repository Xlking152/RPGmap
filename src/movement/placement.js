import {
  createNavigationBase,
  createNavigationGrid,
  inspectDirectNavigationPath,
} from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import {
  normalizeElevationMeters,
  normalizeTokenDiameterMeters,
  tokenDiameterMeters,
  tokenElevationMeters,
} from '../elevation/model.js';

function finitePoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function failure(code, reason, details = {}) {
  return Object.freeze({ valid: false, code, reason, ...structuredClone(details) });
}

/**
 * Build the canonical map-shell placement validator from the same navigation
 * field used by Movement. Placement is intentionally stricter than recovery
 * movement: a new/repositioned Token must end in a fully walkable footprint.
 */
export function createMovementPlacementInspector(api) {
  const staticBase = createNavigationBase(api.mapPackage);

  return function inspectTokenPlacement(tokenId, rawPoint, options = {}) {
    const point = finitePoint(rawPoint);
    if (!point) return failure('invalid_destination', 'Token 放置位置无效');

    const token = tokenId ? api.tokens?.get?.(tokenId) : null;
    const diameterMeters = normalizeTokenDiameterMeters(
      options.diameterMeters,
      tokenDiameterMeters(token),
    );
    const elevationMeters = normalizeElevationMeters(
      options.elevationMeters,
      tokenElevationMeters(token),
    );
    const state = api.getState?.() || {};
    const scene = api.world?.getActiveScene?.() || null;
    if (!scene) return failure('scene_not_active', '当前没有可放置 Token 的活动 Scene');

    const navigation = createNavigationGrid(
      api.mapPackage,
      deriveSceneState(scene.sceneEvents || state.sceneEvents || []),
      staticBase,
      {
        appState: state,
        moverContext: {
          tokenId: token?.id || (tokenId == null ? null : String(tokenId)),
          elevationMeters,
          diameterMeters,
          statusVersion: 'placement',
          collisionBypassGroups: [],
        },
      },
    );
    const inspected = inspectDirectNavigationPath(navigation, point, point, {
      diameterMeters,
      allowBlockedStartEscape: false,
    });
    if (!inspected.valid) {
      return failure(
        inspected.reason === 'outside-map' ? 'placement_outside_map' : 'placement_blocked',
        inspected.reason === 'outside-map' ? 'Token 放置位置超出地图范围' : 'Token 放置位置与不可通行地形或结构重叠',
        inspected,
      );
    }
    return Object.freeze({ valid: true, code: 'ok', point, diameterMeters, elevationMeters });
  };
}
