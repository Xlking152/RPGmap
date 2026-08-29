import { createLanzhouReferencePackage } from '../../reference/maps/lanzhou/index.js';
import { prepareMapPackage } from './contract.js';

export function createDefaultMapPackage() {
  return prepareMapPackage(createLanzhouReferencePackage(), {
    source: 'reference/maps/lanzhou',
  });
}
