import { DEFAULT_REFERENCE_MAP_ID } from './constants.js';
import { mapPackageRegistry } from './registry.js';

export function registerBuiltInMapPackages(registry = mapPackageRegistry) {
  if (!registry.has(DEFAULT_REFERENCE_MAP_ID)) {
    registry.registerLoader({
      id: DEFAULT_REFERENCE_MAP_ID,
      title: '北宋兰州 Reference Map',
      source: 'reference/maps/lanzhou',
      load: async () => {
        const { createDefaultMapPackage } = await import('./default-map.js');
        return createDefaultMapPackage();
      },
    });
  }
  return registry;
}
