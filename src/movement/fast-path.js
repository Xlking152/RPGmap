import {
  createNavigationBase,
  createNavigationGrid,
  findDirectNavigationPath,
  inspectDirectNavigationPath,
} from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import { tokenDiameterMeters, tokenElevationFt } from '../elevation/model.js';
import { moveSceneToken } from '../token/model.js';

const MAX_GRID_CACHE = 8;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function finitePoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function tokenPoint(token) {
  return token?.placement === 'map' ? finitePoint(token) : null;
}

function statusContext(api, token) {
  try { return api.status?.resolve?.({ tokenId: token.id, actorId: token.actorId }) || null; }
  catch { return null; }
}

function moverContext(api, token) {
  const status = statusContext(api, token);
  return {
    elevationFt: tokenElevationFt(token),
    diameterMeters: tokenDiameterMeters(token),
    statusVersion: String(status?.statusVersion || 'none'),
    collisionBypassGroups: [...(status?.capabilities?.collisionBypassGroups || [])].map(String).sort(),
  };
}

function navigationStateKey(api, token) {
  const state = api.getState?.() || {};
  const scene = api.world?.getActiveScene?.() || null;
  const context = moverContext(api, token);
  return JSON.stringify({
    sceneId: scene?.id || null,
    sceneEvents: scene?.sceneEvents || state.sceneEvents || [],
    clipHits: scene?.clipHits || [],
    craterRegions: scene?.craterRegions || [],
    destroyedObjectIds: scene?.destroyedObjectIds || [],
    featureStates: state.preferences?.featureStates || {},
    context,
  });
}

function updateAnchoredAreas(world, tokenId, point) {
  if (!point) return world;
  const next = clone(world);
  const activeId = String(next?.activeSceneId || '');
  const scene = (next?.scenes || []).find(item => String(item?.id || '') === activeId);
  if (!scene) return next;
  scene.attackAreas = (scene.attackAreas || []).map(area => {
    const anchor = area?.anchor || {};
    if (anchor.type !== 'token' || String(anchor.tokenId) !== String(tokenId)) return area;
    return {
      ...area,
      origin: { x: Number(point.x), y: Number(point.y) },
      anchor: { type: 'token', tokenId: String(tokenId) },
    };
  });
  return next;
}

function failure(code, reason, details = {}) {
  return Object.freeze({ valid: false, code, reason, ...clone(details) });
}

export function createMovementFastPathSystem() {
  return Object.freeze({
    register(api) {
      if (!api.movement?.canonicalSceneTokens) throw new Error('Movement fast path requires canonical Movement Runtime');
      const staticBase = createNavigationBase(api.mapPackage);
      const grids = new Map();

      function cacheGrid(key, grid) {
        if (grids.has(key)) grids.delete(key);
        grids.set(key, grid);
        while (grids.size > MAX_GRID_CACHE) grids.delete(grids.keys().next().value);
        return grid;
      }

      function navigation(token) {
        const key = navigationStateKey(api, token);
        const cached = grids.get(key);
        if (cached) {
          grids.delete(key);
          grids.set(key, cached);
          return cached;
        }
        const state = api.getState?.() || {};
        const scene = api.world?.getActiveScene?.() || null;
        const context = moverContext(api, token);
        return cacheGrid(key, createNavigationGrid(
          api.mapPackage,
          deriveSceneState(scene?.sceneEvents || state.sceneEvents || []),
          staticBase,
          { appState: state, moverContext: { ...context, tokenId: String(token.id) } },
        ));
      }

      async function validateTokenMove(tokenId, destination, options = {}) {
        const access = api.movement.inspectMovementAccess?.(tokenId, destination, options);
        if (!access?.valid) return access || failure('movement_access_denied', '当前 Token 无法移动');
        const route = await findDirectNavigationPath(navigation(access.token), access.from, access.destination);
        if (route) return clone({ valid: true, code: 'ok', ...route });
        const inspected = inspectDirectNavigationPath(navigation(access.token), access.from, access.destination);
        return inspected?.valid === false
          ? failure('path_blocked', inspected.reason || '路径不可通行', inspected)
          : failure('path_blocked', '路径不可通行');
      }

      async function moveTokenTo(tokenId, destination) {
        const route = await validateTokenMove(tokenId, destination);
        if (!route?.valid) return route;
        const current = api.tokens?.get?.(tokenId);
        const from = tokenPoint(current);
        if (!current || !from) return failure('token_not_on_map', 'Token 当前不在地图上');
        const target = finitePoint(route.destination || destination);
        if (!target) return failure('invalid_destination', '移动终点无效');

        try {
          let world = moveSceneToken(api.world.get(), current.id, target).world;
          world = updateAnchoredAreas(world, current.id, target);
          await api.world.commit(world, {
            source: 'movement:token-fast',
            reason: 'token.move',
            render: true,
          });
          // Moving a Token does not alter terrain, so the shared fast-grid cache
          // remains valid. The legacy runtime cache is cheap to invalidate and
          // may otherwise retain a stale state signature for older callers.
          api.movement.invalidateNavigation?.();
          const committed = api.tokens.get(current.id);
          api.emit?.('token:move', {
            id: current.id,
            tokenId: current.id,
            actorId: current.actorId,
            token: clone(committed),
            from: clone(from),
            to: clone(target),
            arrival: null,
            reason: 'token.move',
          });
          return clone({ ...route, destination: target, committed: true });
        } catch (error) {
          api.emit?.('token:move-cancelled', {
            id: current.id,
            tokenId: current.id,
            code: error?.code || 'movement_failed',
            reason: error?.message || String(error || 'movement cancelled'),
          });
          return failure(error?.code || 'movement_failed', error?.message || 'Token 移动失败');
        }
      }

      function inspectTokenMove(tokenId, destination, options = {}) {
        const access = api.movement.inspectMovementAccess?.(tokenId, destination, options);
        if (!access?.valid) return access || failure('movement_access_denied', '当前 Token 无法移动');
        const inspected = inspectDirectNavigationPath(navigation(access.token), access.from, access.destination);
        return inspected?.valid === false
          ? failure('path_blocked', inspected.reason || '路径不可通行', inspected)
          : clone({ valid: true, code: 'ok', ...inspected });
      }

      api.movementFast = Object.freeze({
        validateTokenMove,
        inspectTokenMove,
        moveTokenTo,
        clearNavigationCache() { grids.clear(); },
        getNavigationCacheSize() { return grids.size; },
      });

      for (const eventName of ['scene:damage', 'scene:restore', 'scene:undo', 'state:import']) {
        api.on?.(eventName, () => grids.clear());
      }
    },
  });
}
