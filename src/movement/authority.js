import { createNavigationBase, createNavigationGrid, inspectDirectNavigationPath, nearestWalkablePoint } from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import { tokenDiameterMeters, tokenElevationFt } from '../elevation/model.js';
import { resolveTokenActor } from '../token/actor.js';
import { resolveStatuses, getStatusDefinitions } from '../status/model.js';
import { getFeatureState } from '../interaction/feature-state.js';
import { evaluateFeatureStatusRule, featureStatusMutations } from '../interaction/status-rules.js';

const failure = (code, reason = code, detail = {}) => ({ valid: false, code, reason, ...detail });
const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null;
const featurePoint = feature => Array.isArray(feature?.entrance) ? point({ x: feature.entrance[0], y: feature.entrance[1] }) : null;

export function resolveMovementStatus(world, scene, token, ruleset) {
  const resolved = resolveTokenActor({ ...world, activeSceneId: scene.id, scenes: [scene] }, token.id, { ruleset });
  return resolveStatuses({
    schemaVersion: 4, actors: [resolved.actor], tokens: [token], statusDefinitions: world.statusDefinitions || [],
  }, { actorId: token.actorId, tokenId: token.id, ruleset });
}

/** Shared offline/LAN validator; only the host provides MapPackage and Ruleset data. */
export function createMovementAuthority(resolveMapPackage) {
  const bases = new WeakMap();
  return ({ state, world = state?.preferences?.worldV2, scene, token, origin, waypoints = [], destination = null,
    operationType = 'token.movePath', ruleset, capabilities = null, status = null } = {}) => {
    const reposition = operationType === 'token.reposition';
    if (!reposition && token?.locked === true) return failure('token_locked');
    const snapshot = status || (capabilities ? { capabilities } : resolveMovementStatus(world, scene, token, ruleset));
    const effective = snapshot.capabilities || {};
    if (!reposition && effective.canMove === false) return failure('status_movement_forbidden', effective.reasons?.[0]);
    const mapPackage = resolveMapPackage(scene);
    const transition = destination && (destination.placement === 'feature' || token.placement === 'feature');
    if (!mapPackage) return transition ? failure('movement_map_unavailable') : { valid: true, collisionValidation: 'bounds-only' };
    if (!bases.has(mapPackage)) bases.set(mapPackage, createNavigationBase(mapPackage));
    const derived = deriveSceneState(scene.sceneEvents || []);
    const appState = { ...state, sceneEvents: scene.sceneEvents || [], preferences: { ...state?.preferences, featureStates: scene.featureStates || {} } };
    const navigation = createNavigationGrid(mapPackage, derived, bases.get(mapPackage), { appState, moverContext: {
      tokenId: token.id, elevationFt: tokenElevationFt(token), diameterMeters: tokenDiameterMeters(token),
      statusVersion: snapshot.statusVersion || '', collisionBypassGroups: effective.collisionBypassGroups || [],
    } });
    let from = point(origin), route = waypoints;
    let anchorPoint = null;
    let statusOperations = [];
    if (reposition) {
      if (destination?.placement !== 'map') return failure('invalid_destination');
      from = point(destination); route = [destination];
    } else if (transition) {
      if (String(scene.id) !== String(world.activeSceneId)) return failure('scene_not_active');
      const entering = destination.placement === 'feature';
      if (entering && token.placement !== 'map') return failure('token_not_on_map');
      const featureId = entering ? destination.featureId : token.featureId;
      const feature = mapPackage.features?.find(item => String(item.id) === String(featureId));
      const action = entering ? 'enter' : 'exit';
      if (!feature || (feature.capabilities?.actions?.[action] ?? feature.capabilities?.enterable ?? feature.enterable) !== true) {
        return failure('feature_transition_forbidden');
      }
      const access = evaluateFeatureStatusRule({ feature, action, tokenId: token.id, resolveStatus: () => snapshot });
      if (!access.ok) return failure('feature_status_forbidden', access.reason);
      const entrance = featurePoint(feature);
      if (!entrance) return failure('feature_entrance_missing');
      statusOperations = featureStatusMutations({ feature, action, tokenId: token.id,
        state: { preferences: { entitySystem: { tokens: [token] } } },
        definitions: getStatusDefinitions({ statusDefinitions: world.statusDefinitions || [] }),
      }).map(({ type, ...payload }) => ({ type, payload: {
        ...payload,
        source: { type: 'feature', featureId: String(feature.id), action },
        ...(payload.scope === 'actor' && token.actorLink === false ? { scope: 'syntheticActor', targetId: token.id } : {}),
      } }));
      if (entering) {
        const featureState = getFeatureState(appState, feature);
        if (featureState.destroyed) return failure('feature_destroyed');
        const openable = feature.capabilities?.actions?.open ?? feature.capabilities?.openable ?? feature.openable;
        if (openable && !featureState.open) return failure('feature_closed');
        route = [entrance];
        anchorPoint = Array.isArray(feature.center) ? point({ x: feature.center[0], y: feature.center[1] }) : entrance;
      } else {
        // Exit has one authoritative safe endpoint, not a caller-chosen teleport.
        const safe = nearestWalkablePoint(navigation, entrance, 120);
        if (!safe) return failure('feature_exit_blocked');
        const target = point(destination);
        if (!target || Math.hypot(target.x - safe.x, target.y - safe.y) > 1e-6) return failure('feature_exit_destination_invalid');
        from = point(safe); route = [safe]; anchorPoint = point(safe);
      }
    } else if (destination) {
      if (token.placement !== 'map' || destination.placement !== 'map') return failure('token_not_on_map');
      route = [destination];
    }
    if (!from || !route.length || route.some(value => !point(value))) return failure('invalid_destination');
    for (const [index, waypoint] of route.entries()) {
      const inspection = inspectDirectNavigationPath(navigation, from, waypoint, { diameterMeters: tokenDiameterMeters(token) });
      if (!inspection.valid) return failure('path_blocked', 'Route is blocked', {
        segmentIndex: index, blockedCell: inspection.blockedCell || inspection.blockingCell || null, blockingFlags: inspection.blockingFlags || 0,
      });
      from = point(waypoint);
    }
    return { valid: true, collisionValidation: 'server', ...(anchorPoint ? { anchorPoint } : {}),
      ...(statusOperations.length ? { statusOperations } : {}) };
  };
}
