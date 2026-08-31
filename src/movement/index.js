import { MovementSettings } from './settings.js';
import { createMovementControllerV5 } from './controller-v5.js';
import { createMovementFastPathSystem } from './fast-path.js';
import { createMovementGhostRendererV2 } from './ghost-renderer-v2.js';
import { createMovementTokenRuntimeSystem } from './token-runtime.js';

export { MovementSession } from './session.js';
export { calculateWaypointRoute } from './path.js';
export { MovementPhase, TokenDragPhase, TokenDragPlan } from './state.js';
export { MOVEMENT_STEPS, normalizeMovementStep, cycleMovementStep, snapMovementPoint, movementMetersPerPixel, recommendedMovementStep, recommendedMovementStepForMap } from './snap.js';
export { MOVEMENT_DISTANCE_STEPS, normalizeMovementDistanceStep, movementDisplayCost, polylineDistance, pointAlongPolyline, splitRouteByWaypoints, summarizeMovementSegments } from './distance.js';
export { MovementSettings } from './settings.js';
export { applyMovementStatusMutations, createMovementTokenRuntimeSystem } from './token-runtime.js';
export { createMovementControllerV2 } from './controller-v2.js';
export { createMovementControllerV3 } from './controller-v3.js';
export { createMovementControllerV4 } from './controller-v4.js';
export { createMovementControllerV5 } from './controller-v5.js';
export { createMovementFastPathSystem } from './fast-path.js';
export { createMovementGhostRendererV2 } from './ghost-renderer-v2.js';
export { createMovementRouteInspector } from './route-inspector.js';

export function createMovementSystem(options = {}) {
  const settings = new MovementSettings(options);
  return {
    settings,
    register(api) {
      settings.attach(api);
      createMovementTokenRuntimeSystem().register(api);
      createMovementFastPathSystem().register(api);
      createMovementControllerV5({ settings }).register(api);
      createMovementGhostRendererV2().register(api);
    },
  };
}
