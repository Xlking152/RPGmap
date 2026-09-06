import { createMovementAuthority } from '../movement/authority.js';
import { createMinimalReferencePackage } from '../../reference/maps/minimal/package.js';
import lanzhouMapPackage from '../../reference/maps/lanzhou/runtime.json' with { type: 'json' };

const packages = new Map([
  [String(lanzhouMapPackage.id), lanzhouMapPackage],
]);
const minimal = createMinimalReferencePackage();
packages.set(String(minimal.id), minimal);

function mapForScene(scene) {
  const reference = scene?.mapPackage || {};
  const mapPackage = packages.get(String(reference.id ?? reference.mapId ?? '')) || null;
  if (!mapPackage) return null;
  const requestedVersion = String(reference.version ?? reference.mapVersion ?? '');
  const actualVersion = String(mapPackage.version ?? mapPackage.mapVersion ?? '');
  return requestedVersion && requestedVersion !== actualVersion ? null : mapPackage;
}

export const validateAuthoritativeTokenMovePath = createMovementAuthority(mapForScene);
