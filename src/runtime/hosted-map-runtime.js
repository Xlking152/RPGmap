import { startMapRuntimeBase } from './map-runtime-base.js';
import { createMemoryStorage } from '../app/storage-adapter.js';
import { hostedRuntimeAdapters } from '../adapters/hosted-runtime.js';
import { createHostedWorldSystem } from '../world/hosted-system.js';
import { createContentSystemBase } from '../content/runtime-base.js';

export function startHostedMapRuntime(options = {}) {
  return startMapRuntimeBase({ ...options, serverRuntime: true,
    runtimeAdapters: hostedRuntimeAdapters, storageAdapter: createMemoryStorage(),
    createWorldSystem: createHostedWorldSystem,
    createContentSystem: () => createContentSystemBase({ serverRuntime: true, worldId: options.worldId }),
  });
}
