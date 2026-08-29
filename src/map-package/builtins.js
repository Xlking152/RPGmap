import { BUILT_IN_LANZHOU_MAP, DEFAULT_REFERENCE_MAP_ID } from './constants.js';
import { mapPackageRegistry } from './registry.js';

export function registerBuiltInMapPackages(registry = mapPackageRegistry) {
  if (!registry.has(DEFAULT_REFERENCE_MAP_ID)) {
    registry.registerLoader({
      id: DEFAULT_REFERENCE_MAP_ID,
      version: BUILT_IN_LANZHOU_MAP.version,
      title: BUILT_IN_LANZHOU_MAP.title,
      source: 'reference/maps/lanzhou',
      load: async () => {
        const { createDefaultMapPackage } = await import('./default-map.js');
        return createDefaultMapPackage();
      },
    });
  }
  return registry;
}
