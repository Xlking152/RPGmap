import {
  createNavigationBase,
  createNavigationGrid,
  inspectDirectNavigationPath,
} from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import { tokenDiameterMeters, tokenElevationFt } from '../elevation/model.js';
import { createMinimalReferencePackage } from '../../reference/maps/minimal/package.js';
import { lanzhouMapPackage } from '../../reference/maps/lanzhou/package.js';

const packages = new Map([
  [String(lanzhouMapPackage.id), lanzhouMapPackage],
]);
const minimal = createMinimalReferencePackage();
packages.set(String(minimal.id), minimal);

const navigationBases = new Map();

function mapForScene(scene) {
  const reference = scene?.mapPackage || {};
  const mapPackage = packages.get(String(reference.id ?? reference.mapId ?? '')) || null;
  if (!mapPackage) return null;
  const requestedVersion = String(reference.version ?? reference.mapVersion ?? '');
  const actualVersion = String(mapPackage.version ?? mapPackage.mapVersion ?? '');
  return requestedVersion && requestedVersion !== actualVersion ? null : mapPackage;
}

function navigationBase(mapPackage) {
  const key = `${String(mapPackage.id)}@${String(mapPackage.version ?? mapPackage.mapVersion ?? '')}`;
  if (!navigationBases.has(key)) navigationBases.set(key, createNavigationBase(mapPackage));
  return navigationBases.get(key);
}

function failure(code, reason, detail = {}) {
  return { valid: false, code, reason, ...detail };
}

export function validateAuthoritativeTokenMovePath({
  state, scene, token, origin, waypoints, capabilities = {},
} = {}) {
  if (token?.locked === true) return failure('token_locked', 'Token is locked');
  if (capabilities.canMove === false) {
    return failure(
      'status_movement_forbidden',
      capabilities.reasons?.[0] || 'Current status prevents movement',
    );
  }

  const mapPackage = mapForScene(scene);
  // External MapPackages are not loaded by the Local Server in v2.3.2. Their
  // trusted dimensions are still checked by the reducer, while built-in maps
  // receive full server-side collision validation below.
  if (!mapPackage) return { valid: true, collisionValidation: 'bounds-only' };

  const appState = {
    ...(state || {}),
    preferences: {
      ...(state?.preferences || {}),
      featureStates: scene?.featureStates || {},
    },
  };
  const moverContext = {
    tokenId: String(token.id),
    elevationFt: tokenElevationFt(token),
    diameterMeters: tokenDiameterMeters(token),
    statusVersion: String(capabilities.statusVersion || ''),
    collisionBypassGroups: [...(capabilities.collisionBypassGroups || [])].map(String).sort(),
  };
  const navigation = createNavigationGrid(
    mapPackage,
    deriveSceneState(scene?.sceneEvents || []),
    navigationBase(mapPackage),
    { appState, moverContext },
  );

  let from = { x: Number(origin?.x), y: Number(origin?.y) };
  for (const [index, waypoint] of (waypoints || []).entries()) {
    const inspection = inspectDirectNavigationPath(navigation, from, waypoint, {
      diameterMeters: moverContext.diameterMeters,
    });
    if (!inspection.valid) {
      return failure('path_blocked', `Token ${token.id} route segment ${index + 1} is blocked`, {
        segmentIndex: index,
        blockedCell: inspection.blockedCell || inspection.blockingCell || null,
        blockingFlags: inspection.blockingFlags || 0,
      });
    }
    from = { x: Number(waypoint.x), y: Number(waypoint.y) };
  }
  return { valid: true, collisionValidation: 'server' };
}
