import { startMapRuntimeBase } from "./map-runtime-base.js";
import { offlineRuntimeAdapters } from "../adapters/offline-runtime.js";
import { createBrowserStorage, createMemoryStorage } from "../app/storage-adapter.js";
import { createWorldSystem } from "../world/system.js";
import { createContentSystem } from "../content/runtime.js";
import { bindRuntimeWorldCatalog } from "./world-catalog-sync.js";

// Preserved standalone/development entry. Production uses hosted-map-runtime.
export function startMapRuntime(options = {}) {
  return startMapRuntimeBase({ ...options, runtimeAdapters: offlineRuntimeAdapters,
    storageAdapter: options.serverRuntime ? createMemoryStorage() : options.bootstrapStorage || createBrowserStorage(),
    createWorldSystem, createContentSystem, bindRuntimeWorldCatalog });
}
