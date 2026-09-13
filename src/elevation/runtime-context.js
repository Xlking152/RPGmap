let appStateProvider = null;
let activeMoverContext = Object.freeze({ tokenId: null, elevationMeters: 0 });

function normalizedContext(context = null) {
  const elevation = Number(context?.elevationMeters);
  return Object.freeze({
    tokenId: context?.tokenId == null ? null : String(context.tokenId),
    elevationMeters: Number.isFinite(elevation) && elevation >= 0 ? elevation : 0,
  });
}

export function configureElevationNavigationRuntime({ getState = null } = {}) {
  appStateProvider = typeof getState === 'function' ? getState : null;
}

export function elevationNavigationAppState() {
  return appStateProvider?.() || null;
}

export function setActiveMoverContext(context = null) {
  activeMoverContext = normalizedContext(context);
  return activeMoverContext;
}

export function getActiveMoverContext() {
  return activeMoverContext;
}

export async function withActiveMoverContext(context, task) {
  const previous = activeMoverContext;
  setActiveMoverContext(context);
  try {
    return await task();
  } finally {
    activeMoverContext = previous;
  }
}

export function resetElevationNavigationRuntime() {
  appStateProvider = null;
  activeMoverContext = Object.freeze({ tokenId: null, elevationMeters: 0 });
}
