import { MovementSettings } from './settings.js';
import { createMovementController } from './controller.js';
import { createMovementFastPathSystem } from './fast-path.js';
import { createMovementGhostRenderer } from './ghost-renderer.js';
import { createMovementTokenRuntimeSystem } from './token-runtime.js';

export { MovementSession } from './session.js';
export { calculateWaypointRoute } from './path.js';
export { MovementPhase, TokenDragPhase, TokenDragPlan } from './state.js';
export { MOVEMENT_STEPS, normalizeMovementStep, cycleMovementStep, snapMovementPoint, movementMetersPerPixel, recommendedMovementStep, recommendedMovementStepForMap } from './snap.js';
export { MOVEMENT_DISTANCE_STEPS, normalizeMovementDistanceStep, movementDisplayCost, polylineDistance, pointAlongPolyline, splitRouteByWaypoints, summarizeMovementSegments } from './distance.js';
export { MovementSettings } from './settings.js';
export { applyMovementStatusMutations, createMovementTokenRuntimeSystem } from './token-runtime.js';
export { createMovementController } from './controller.js';
export { createMovementFastPathSystem } from './fast-path.js';
export { createMovementGhostRenderer } from './ghost-renderer.js';
export { createMovementRouteInspector } from './route-inspector.js';

export function createMovementSystem(options = {}) {
  const settings = new MovementSettings(options);
  return {
    settings,
    register(api) {
      settings.attach(api);
      createMovementTokenRuntimeSystem().register(api);
      createMovementFastPathSystem().register(api);
      createMovementController({ settings }).register(api);
      createMovementGhostRenderer().register(api);
    },
  };
}
