import { createDefaultMapPackage, DEFAULT_REFERENCE_MAP_ID } from './default-map.js';
import { mapPackageRegistry } from './registry.js';

export function registerBuiltInMapPackages(registry = mapPackageRegistry) {
  if (!registry.has(DEFAULT_REFERENCE_MAP_ID)) {
    registry.registerLoader({
      id: DEFAULT_REFERENCE_MAP_ID,
      title: '北宋兰州 Reference Map',
      source: 'reference/maps/lanzhou',
      load: async () => createDefaultMapPackage(),
    });
  }
  return registry;
}
