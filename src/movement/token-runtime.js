import {
  createNavigationBase,
  createNavigationGrid,
  findDirectNavigationPath,
  inspectDirectNavigationPath,
  nearestWalkablePoint,
} from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import { tokenDiameterMeters, tokenElevationFt } from '../elevation/model.js';
import { reduceStatusOperation } from '../status/model.js';
import {
  getActiveSceneToken,
  moveSceneToken,
  placeSceneTokenInFeature,
} from '../token/model.js';
import { applySyntheticActorStatusOperation } from '../token/synthetic-status.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function finitePoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function activeSceneIndex(world) {
  const scenes = array(world?.scenes);
  const activeId = String(world?.activeSceneId ?? '');
  const index = scenes.findIndex(scene => String(scene?.id ?? '') === activeId);
  if (index < 0) throw new Error(`World has no active Scene: ${activeId || '(missing)'}`);
  return index;
}

function tokenMapPoint(token) {
  if (!token || token.placement !== 'map') return null;
  return finitePoint(token);
}

function featureById(mapPackage, featureId) {
  return array(mapPackage?.features).find(feature => String(feature?.id) === String(featureId)) || null;
}

function featurePoint(feature) {
  if (Array.isArray(feature?.center) && feature.center.length >= 2) {
    const point = finitePoint({ x: feature.center[0], y: feature.center[1] });
    if (point) return point;
  }
  if (Array.isArray(feature?.entrance) && feature.entrance.length >= 2) {
    return finitePoint({ x: feature.entrance[0], y: feature.entrance[1] });
  }
  return null;
}

function updateAnchoredAreas(world, tokenId, point) {
  if (!point) return world;
  const next = clone(world);
  const index = activeSceneIndex(next);
  next.scenes[index].attackAreas = array(next.scenes[index].attackAreas).map(area => {
    const anchor = area?.anchor || {};
    const canonical = anchor.type === 'token' && String(anchor.tokenId) === String(tokenId);
    const legacy = anchor.type === 'character' && String(anchor.characterId) === String(tokenId);
    if (!canonical && !legacy) return area;
    return {
      ...area,
      origin: { x: Number(point.x), y: Number(point.y) },
      anchor: { type: 'token', tokenId: String(tokenId) },
    };
  });
  return next;
}

function movementStatusContext(api, token) {
  try {
    return api.status?.resolve?.({ tokenId: token.id, actorId: token.actorId }) || null;
  } catch {
    return null;
  }
}

function moverContext(api, token) {
  const status = movementStatusContext(api, token);
  return Object.freeze({
    tokenId: String(token.id),
    elevationFt: tokenElevationFt(token),
    diameterMeters: tokenDiameterMeters(token),
    statusVersion: status?.statusVersion || 'none',
    collisionBypassGroups: Object.freeze([...(status?.capabilities?.collisionBypassGroups || [])]),
  });
}

function movementCapability(api, token) {
  const snapshot = movementStatusContext(api, token);
  return snapshot?.capabilities || { canMove: true, canInteract: true, reasons: [] };
}

function applyStatusOperationToWorld(rawWorld, operation, context = {}) {
  const world = clone(rawWorld);
  const sceneIndex = activeSceneIndex(world);
  const entityState = {
    schemaVersion: 3,
    statusDefinitions: clone(array(world.statusDefinitions)),
    actors: clone(array(world.actors)),
    tokens: clone(array(world.scenes[sceneIndex]?.tokens)),
  };
  const reduced = reduceStatusOperation(entityState, operation, context);
  world.statusDefinitions = clone(reduced.state.statusDefinitions);
  world.actors = clone(reduced.state.actors);
  world.scenes[sceneIndex].tokens = clone(reduced.state.tokens);
  return world;
}

export function applyMovementStatusMutations(rawWorld, tokenId, mutations = [], context = {}) {
  let world = clone(rawWorld);
  for (const raw of array(mutations)) {
    const operation = clone(object(raw));
    if (!operation.type) continue;
    const token = getActiveSceneToken(world, tokenId);
    if (!token) throw new Error(`Unknown Token: ${tokenId}`);

    if (operation.scope === 'actor' && token.actorLink === false
      && String(operation.targetId ?? '') === String(token.actorId)) {
      const applied = applySyntheticActorStatusOperation(world, {
        ...operation,
        scope: 'syntheticActor',
        targetId: token.id,
      }, context);
      world = applied.world;
      continue;
    }

    world = applyStatusOperationToWorld(world, operation, context);
  }
  return world;
}

export function createMovementTokenRuntimeSystem() {
  return Object.freeze({
    register(api) {
      if (!api || api.movement?.canonicalSceneTokens === true) return;
      if (!api.tokens?.get || !api.world?.get || !api.world?.commit) {
        throw new Error('Movement Token Runtime requires Token Runtime V2 and World V2');
      }

      const staticBase = createNavigationBase(api.mapPackage);
      let navigationGrid = null;
      let navigationRevision = null;
      let pendingPlan = null;

      function navigation(token) {
        const state = api.getState?.() || {};
        const scene = api.world.getActiveScene?.() || null;
        const context = moverContext(api, token);
        const revision = JSON.stringify({
          sceneId: scene?.id || null,
          sceneEvents: scene?.sceneEvents || state.sceneEvents || [],
          featureStates: state.preferences?.featureStates || {},
          context,
        });
        if (!navigationGrid || navigationRevision !== revision) {
          navigationGrid = createNavigationGrid(
            api.mapPackage,
            deriveSceneState(scene?.sceneEvents || state.sceneEvents || []),
            staticBase,
            { appState: state, moverContext: context },
          );
          navigationRevision = revision;
        }
        return navigationGrid;
      }

      function invalidateNavigation() {
        navigationGrid = null;
        navigationRevision = null;
      }

      function emitMoved(token, { from = null, to = null, arrival = null, reason = 'token.move' } = {}) {
        api.emit?.('token:move', {
          id: token.id,
          tokenId: token.id,
          actorId: token.actorId,
          token: clone(token),
          from: clone(from),
          to: clone(to),
          arrival: clone(arrival),
          reason,
        });
      }

      function emitCancelled(tokenId, error) {
        api.emit?.('token:move-cancelled', {
          id: tokenId,
          tokenId,
          reason: error?.message || String(error || 'movement cancelled'),
        });
      }

      async function planTokenMove(tokenId, destination, arrival = null) {
        const token = api.tokens.get(tokenId);
        const from = tokenMapPoint(token);
        const to = finitePoint(destination);
        if (!token || !from || !to) {
          pendingPlan = null;
          return null;
        }
        const capability = movementCapability(api, token);
        if (capability.canMove === false) {
          pendingPlan = null;
          return null;
        }
        const route = await findDirectNavigationPath(navigation(token), from, to);
        if (!route) {
          pendingPlan = null;
          return null;
        }
        pendingPlan = {
          tokenId: token.id,
          actorId: token.actorId,
          from,
          destination: clone(route.destination || to),
          route: clone(route),
          arrival: clone(arrival),
        };
        return clone({ valid: true, ...route, arrival });
      }

      async function executePlan(plan) {
        const current = api.tokens.get(plan.tokenId);
        const from = tokenMapPoint(current);
        if (!current || !from) throw new Error('Token 已不在地图上，请重新规划移动');
        const capability = movementCapability(api, current);
        if (capability.canMove === false) {
          throw new Error(capability.reasons?.[0] || '当前状态禁止 Token 移动');
        }

        const route = await findDirectNavigationPath(navigation(current), from, plan.destination);
        if (!route) throw new Error('执行时路径已不可通行');

        let world = api.world.get();
        let reason = 'token.move';
        let anchorPoint = route.destination || plan.destination;
        if (plan.arrival?.type === 'feature') {
          const featureId = String(plan.arrival.featureId || '');
          const feature = featureById(api.mapPackage, featureId);
          if (!feature) throw new Error(`Feature 不存在：${featureId}`);
          const action = api.interaction?.actionsForFeature?.(featureId, { tokenId: current.id })
            ?.find?.(entry => entry.id === 'enter');
          if (action?.enabled === false) throw new Error(action.reason || '当前无法进入 Feature');
          world = placeSceneTokenInFeature(world, current.id, featureId).world;
          anchorPoint = featurePoint(feature) || anchorPoint;
          reason = `feature.enter:${featureId}`;
        } else {
          world = moveSceneToken(world, current.id, route.destination || plan.destination).world;
        }

        if (array(plan.arrival?.statusMutations).length) {
          world = applyMovementStatusMutations(world, current.id, plan.arrival.statusMutations, {
            source: {
              type: 'feature',
              featureId: plan.arrival.featureId || null,
              action: plan.arrival.featureAction || 'enter',
            },
          });
        }
        world = updateAnchoredAreas(world, current.id, anchorPoint);

        await api.world.commit(world, {
          source: reason.startsWith('feature.') ? 'feature:enter' : 'movement:token',
          reason,
          render: true,
        });
        invalidateNavigation();
        const committed = api.tokens.get(current.id);
        emitMoved(committed, { from, to: anchorPoint, arrival: plan.arrival, reason });
        return committed;
      }

      function commitTokenMove() {
        if (!pendingPlan) return false;
        const plan = pendingPlan;
        pendingPlan = null;
        void executePlan(plan).catch(error => emitCancelled(plan.tokenId, error));
        return true;
      }

      async function exitFeature(tokenId, options = {}) {
        const token = api.tokens.get(tokenId);
        if (!token || token.placement !== 'feature' || !token.featureId) return false;
        const capability = movementCapability(api, token);
        if (capability.canMove === false || capability.canInteract === false) return false;
        const feature = featureById(api.mapPackage, token.featureId);
        if (!feature) return false;
        const target = Array.isArray(feature.entrance)
          ? { x: Number(feature.entrance[0]), y: Number(feature.entrance[1]) }
          : featurePoint(feature);
        if (!target) return false;
        const safe = nearestWalkablePoint(navigation(token), target, 120);
        if (!safe) return false;

        let world = moveSceneToken(api.world.get(), token.id, safe).world;
        if (array(options.statusMutations).length) {
          world = applyMovementStatusMutations(world, token.id, options.statusMutations, {
            source: options.source || { type: 'feature', featureId: feature.id, action: 'exit' },
          });
        }
        world = updateAnchoredAreas(world, token.id, safe);
        try {
          await api.world.commit(world, {
            source: 'feature:exit',
            reason: `feature.exit:${feature.id}`,
            render: true,
          });
        } catch (error) {
          emitCancelled(token.id, error);
          return false;
        }
        invalidateNavigation();
        const committed = api.tokens.get(token.id);
        emitMoved(committed, {
          from: { placement: 'feature', featureId: feature.id },
          to: safe,
          reason: `feature.exit:${feature.id}`,
        });
        api.emit?.('token:exit-feature', { id: token.id, tokenId: token.id, featureId: feature.id, token: clone(committed) });
        return true;
      }

      async function inspectTokenMove(tokenId, destination) {
        const token = api.tokens.get(tokenId);
        const from = tokenMapPoint(token);
        const to = finitePoint(destination);
        if (!token || !from || !to) return { valid: false, reason: 'Token 不在地图上' };
        return inspectDirectNavigationPath(navigation(token), from, to);
      }

      api.movement = Object.freeze({
        canonicalSceneTokens: true,
        planTokenMove,
        commitTokenMove,
        inspectTokenMove,
        exitFeature,
        cancelPending() { pendingPlan = null; },
        invalidateNavigation,
        getPendingPlan() { return clone(pendingPlan); },
      });

      for (const eventName of ['scene:damage', 'scene:restore', 'scene:undo', 'state:import', 'status:change', 'token:size-change', 'elevation:token-change']) {
        api.on?.(eventName, invalidateNavigation);
      }
      api.emit?.('movement:token-runtime-ready', { schemaVersion: 2, canonical: 'Scene.tokens[]' });
    },
  });
}
