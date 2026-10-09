import { readRuntimeState } from '../engine/state-access.js';

/** Catalog metadata follows confirmed local saves, without exporting the World. */
export function bindRuntimeWorldCatalog({ runtime, worldManager, worldId } = {}) {
  if (!worldManager || !worldId) return () => {};
  const refresh = () => worldManager.updateFromState(worldId, readRuntimeState(runtime));
  refresh();
  return runtime.on?.('state:saved', refresh) || (() => {});
}
