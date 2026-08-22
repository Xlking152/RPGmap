import { createElevationSystem as createCoreElevationSystem } from './system.js';
import { createPlacementContextGuard } from './placement-context.js';

export {
  actorForCharacter,
  entityStateFromAppState,
  featureBlockingHeightFt,
  featureBlocksMover,
  formatFt,
  normalizeBlockingHeightFt,
  normalizeElevationFt,
  tokenElevationFt,
  tokenForCharacter,
} from './model.js';

export {
  configureElevationNavigationRuntime,
  elevationNavigationAppState,
  getActiveMoverContext,
  resetElevationNavigationRuntime,
  setActiveMoverContext,
  withActiveMoverContext,
} from './runtime-context.js';

export {
  GROUND_PLACEMENT_MOVER_CONTEXT,
  isCharacterPlacementControl,
} from './placement-context.js';
export { createPlacementContextGuard };

export function createElevationSystem() {
  return {
    register(api) {
      createCoreElevationSystem().register(api);
      createPlacementContextGuard().register(api);
    },
  };
}
