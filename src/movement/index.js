import { MovementSettings } from './settings.js';
import { createMovementControllerV2 } from './controller-v2.js';
import { createMovementTokenRuntimeSystem } from './token-runtime.js';

export { MovementSession } from './session.js';
export { calculateWaypointRoute } from './path.js';
export { MovementPhase, TokenDragPhase, TokenDragPlan } from './state.js';
export { MOVEMENT_STEPS, normalizeMovementStep, cycleMovementStep, snapMovementPoint, movementMetersPerPixel, recommendedMovementStep, recommendedMovementStepForMap } from './snap.js';
export { MOVEMENT_DISTANCE_STEPS, normalizeMovementDistanceStep, movementDisplayCost, polylineDistance, pointAlongPolyline, splitRouteByWaypoints, summarizeMovementSegments } from './distance.js';
export { MovementSettings } from './settings.js';
export { applyMovementStatusMutations, createMovementTokenRuntimeSystem } from './token-runtime.js';
export { createMovementControllerV2 } from './controller-v2.js';

export function createMovementSystem(options = {}) {
  const settings = new MovementSettings(options);
  return {
    settings,
    register(api) {
      settings.attach(api);
      createMovementTokenRuntimeSystem().register(api);
      createMovementControllerV2({ settings }).register(api);
    },
  };
}
