import { MovementSettings } from './settings.js';
import { createMovementController } from './controller.js';
import { createMovementGhostRenderer } from './ghost-renderer.js';
import { createMovementDistanceRenderer } from './distance-renderer.js';
import { createMovementTokenRuntimeSystem } from './token-runtime.js';

export { MovementSession } from './session.js';
export { calculateWaypointRoute } from './path.js';
export { MovementPhase, TokenDragPhase, TokenDragPlan } from './state.js';
export { MOVEMENT_STEPS, normalizeMovementStep, cycleMovementStep, snapMovementPoint, movementMetersPerPixel, recommendedMovementStep, recommendedMovementStepForMap } from './snap.js';
export { MOVEMENT_DISTANCE_STEPS, normalizeMovementDistanceStep, movementDisplayCost, polylineDistance, pointAlongPolyline, splitRouteByWaypoints, summarizeMovementSegments } from './distance.js';
export { createTokenGhostDescriptor, isMovementEndpointLayer } from './ghost.js';
export { MovementSettings } from './settings.js';
export { applyMovementStatusMutations, createMovementTokenRuntimeSystem } from './token-runtime.js';

export function createMovementSystem(options = {}) {
  const settings = new MovementSettings(options);
  return {
    settings,
    register(api) {
      settings.attach(api);
      // Canonical movement APIs must exist before the map-facing controller is
      // mounted. The controller may keep legacy event names for UI compatibility,
      // but every position write now crosses Scene.tokens[] through World V2.
      createMovementTokenRuntimeSystem().register(api);
      createMovementController({ settings }).register(api);
      createMovementGhostRenderer().register(api);
      createMovementDistanceRenderer({ defaultStep: settings.defaultStep, settings }).register(api);
    },
  };
}
