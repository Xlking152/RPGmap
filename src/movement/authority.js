import { createNavigationBase, createNavigationGrid, inspectDirectNavigationPath, nearestWalkablePoint } from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import { tokenDiameterMeters, tokenElevationMeters } from '../elevation/model.js';
import { resolveTokenActor } from '../token/actor.js';
import { resolveStatuses, getStatusDefinitions } from '../status/model.js';
import { getFeatureState } from '../interaction/feature-state.js';
import { evaluateFeatureStatusRule, featureStatusMutations } from '../interaction/status-rules.js';
import {
  movementCapabilityFailure,
  movementTerrainCostMeters,
  movementTurnKey,
  nextMovementState,
  normalizeMovementBudget,
  normalizeMovementMode,
  spatialDistanceMeters,
} from './model.js';

const failure = (code, reason = code, detail = {}) => ({ valid: false, code, reason, ...detail });
const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null;
const spatialPoint = (value, fallbackElevation = 0) => {
  const base = point(value);
  if (!base) return null;
  const elevation = value?.elevationMeters === undefined ? Number(fallbackElevation) : Number(value.elevationMeters);
  return Number.isFinite(elevation) && elevation >= 0 ? { ...base, elevationMeters: elevation } : null;
};
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
    operationType = 'token.movePath', ruleset, capabilities = null, status = null,
    movementMode = null, verticalAction = null } = {}) => {
    const reposition = operationType === 'token.reposition';
    if (!reposition && token?.locked === true) return failure('token_locked');
    const snapshot = status || (capabilities ? { capabilities } : resolveMovementStatus(world, scene, token, ruleset));
    const effective = snapshot.capabilities || {};
    if (!reposition && effective.canMove === false) return failure('status_movement_forbidden', effective.reasons?.[0]);
    const mapPackage = resolveMapPackage(scene);
    let resolvedActor = null;
    try { resolvedActor = resolveTokenActor({ ...world, activeSceneId: scene.id, scenes: [scene] }, token.id, { ruleset })?.actor || null; }
    catch { resolvedActor = null; }
    const movement = ruleset?.movement?.describe?.(resolvedActor, { token, scene, world, status: snapshot }) || {};
    const requestedMode = normalizeMovementMode(movementMode, token?.movement?.mode || 'walk');
    const capabilityFailure = reposition ? null : movementCapabilityFailure(movement, requestedMode, verticalAction);
    if (capabilityFailure) return failure(capabilityFailure);
    const transition = destination && (destination.placement === 'feature' || token.placement === 'feature');
    if (!mapPackage) return transition ? failure('movement_map_unavailable') : { valid: true, collisionValidation: 'bounds-only' };
    if (!bases.has(mapPackage)) bases.set(mapPackage, createNavigationBase(mapPackage));
    const derived = deriveSceneState(scene.sceneEvents || []);
    const appState = { ...state, sceneEvents: scene.sceneEvents || [], preferences: { ...state?.preferences, featureStates: scene.featureStates || {} } };
    const baseMoverContext = {
      tokenId: token.id, elevationMeters: tokenElevationMeters(token), diameterMeters: tokenDiameterMeters(token),
      statusVersion: snapshot.statusVersion || '', collisionBypassGroups: effective.collisionBypassGroups || [],
      movementMode: requestedMode,
    };
    const navigation = createNavigationGrid(mapPackage, derived, bases.get(mapPackage), { appState, moverContext: baseMoverContext });
    let from = spatialPoint(origin, tokenElevationMeters(token));
    let route = waypoints.map(value => spatialPoint(value, from?.elevationMeters ?? tokenElevationMeters(token)));
    let anchorPoint = null;
    let statusOperations = [];
    if (reposition) {
      if (destination?.placement !== 'map') return failure('invalid_destination');
      from = spatialPoint(destination, tokenElevationMeters(token)); route = [from];
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
        route = [spatialPoint(entrance, tokenElevationMeters(token))];
        anchorPoint = Array.isArray(feature.center) ? point({ x: feature.center[0], y: feature.center[1] }) : entrance;
      } else {
        // Exit has one authoritative safe endpoint, not a caller-chosen teleport.
        const safe = nearestWalkablePoint(navigation, entrance, 120);
        if (!safe) return failure('feature_exit_blocked');
        const target = point(destination);
        if (!target || Math.hypot(target.x - safe.x, target.y - safe.y) > 1e-6) return failure('feature_exit_destination_invalid');
        from = spatialPoint(safe, tokenElevationMeters(token)); route = [from]; anchorPoint = point(safe);
      }
    } else if (destination) {
      if (token.placement !== 'map' || destination.placement !== 'map') return failure('token_not_on_map');
      route = [spatialPoint(destination, tokenElevationMeters(token))];
    }
    if (!from || !route.length || route.some(value => !point(value))) return failure('invalid_destination');
    const initialElevation = tokenElevationMeters(token);
    const finalElevation = route.at(-1).elevationMeters;
    const changesElevation = Math.abs(finalElevation - initialElevation) > 1e-9;
    if (!reposition && changesElevation && movement.fly !== true) return failure('movement_flight_forbidden');
    if (!reposition && changesElevation && requestedMode !== 'fly' && verticalAction !== 'landing') {
      return failure('movement_vertical_mode_required');
    }
    if (!reposition && verticalAction === 'takeoff' && !(initialElevation === 0 && finalElevation > 0)) {
      return failure('movement_takeoff_invalid');
    }
    if (!reposition && verticalAction === 'landing' && finalElevation !== 0) return failure('movement_landing_invalid');
    let costMeters = 0;
    for (const [index, waypoint] of route.entries()) {
      const dx = waypoint.x - from.x;
      const dy = waypoint.y - from.y;
      const denominator = dx * dx + dy * dy;
      const elevationAtPoint = current => {
        const ratio = denominator <= Number.EPSILON ? 1
          : Math.max(0, Math.min(1, ((current.x - from.x) * dx + (current.y - from.y) * dy) / denominator));
        return from.elevationMeters + (waypoint.elevationMeters - from.elevationMeters) * ratio;
      };
      const segmentNavigation = createNavigationGrid(mapPackage, derived, bases.get(mapPackage), { appState, moverContext: {
        ...baseMoverContext,
        elevationMeters: Math.max(from.elevationMeters, waypoint.elevationMeters),
        elevationAtPoint,
        heightProfileKey: `${from.x},${from.y},${from.elevationMeters}:${waypoint.x},${waypoint.y},${waypoint.elevationMeters}`,
      } });
      const inspection = inspectDirectNavigationPath(segmentNavigation, from, waypoint, { diameterMeters: tokenDiameterMeters(token) });
      if (!inspection.valid) return failure('path_blocked', 'Route is blocked', {
        segmentIndex: index, blockedCell: inspection.blockedCell || inspection.blockingCell || null, blockingFlags: inspection.blockingFlags || 0,
      });
      const distanceMeters = spatialDistanceMeters(from, waypoint, mapPackage.metersPerUnit ?? 1);
      const defaultCostMeters = movementTerrainCostMeters(distanceMeters, inspection.terrainCellCounts, {
        difficult: Boolean(inspection.encounteredFlags & 8),
        water: Boolean(inspection.encounteredFlags & 4),
        mode: requestedMode,
        swimCostMultiplier: movement.swimCostMultiplier,
      });
      const calculated = Number(ruleset?.movement?.calculateCost?.({
        actor: resolvedActor, token, scene, world, mode: requestedMode,
        distanceMeters, defaultCostMeters, encounteredFlags: inspection.encounteredFlags,
      }) ?? defaultCostMeters);
      if (!Number.isFinite(calculated) || calculated < 0) return failure('movement_cost_invalid');
      costMeters += calculated;
      from = point(waypoint);
      from.elevationMeters = waypoint.elevationMeters;
    }
    const budgetMeters = normalizeMovementBudget(scene.settings?.movementBudgetMetersPerTurn);
    const turnKey = movementTurnKey(state?.preferences?.combatSystem?.combat);
    let movementState;
    try {
      movementState = nextMovementState(token.movement, {
        costMeters, budgetMeters, turnKey,
        mode: verticalAction === 'landing' ? 'walk' : requestedMode,
        capabilityAvailable: true,
      });
    } catch (error) {
      return failure(error.code || 'movement_budget_exceeded', error.message, {
        costMeters: error.costMeters, spentMeters: error.spentMeters, budgetMeters: error.budgetMeters,
      });
    }
    return { valid: true, collisionValidation: 'server', ...(anchorPoint ? { anchorPoint } : {}),
      movementMode: requestedMode, costMeters, movementState,
      ...(statusOperations.length ? { statusOperations } : {}) };
  };
}
