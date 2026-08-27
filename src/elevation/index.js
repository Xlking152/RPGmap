import { createTokenElevationSystem } from './token-system.js';

export {
  entityStateFromAppState,
  featureBlockingHeightFt,
  featureBlocksMover,
  formatFt,
  normalizeBlockingHeightFt,
  normalizeElevationFt,
  normalizeTokenDiameterMeters,
  TOKEN_DIAMETERS_METERS,
  tokenDiameterMeters,
  tokenElevationFt,
} from './model.js';

export {
  configureElevationNavigationRuntime,
  elevationNavigationAppState,
  getActiveMoverContext,
  resetElevationNavigationRuntime,
  setActiveMoverContext,
  withActiveMoverContext,
} from './runtime-context.js';

export { createTokenElevationSystem } from './token-system.js';

export function createElevationSystem() {
  return createTokenElevationSystem();
}
