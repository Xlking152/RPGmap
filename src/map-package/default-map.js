import { createLanzhouReferencePackage } from '../../reference/maps/lanzhou/index.js';
import { prepareMapPackage } from './contract.js';

export const DEFAULT_REFERENCE_MAP_ID = 'northern-song-lanzhou-1104';

export function createDefaultMapPackage() {
  return prepareMapPackage(createLanzhouReferencePackage(), {
    source: 'reference/maps/lanzhou',
  });
}
