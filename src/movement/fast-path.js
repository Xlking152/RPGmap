import { tokenElevationMeters } from '../elevation/model.js';
import { createMovementAuthority } from './authority.js';
import { normalizeMovementMode } from './model.js';

const clone = structuredClone;

function finitePoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const elevationMeters = Number(value?.elevationMeters);
  return Number.isFinite(x) && Number.isFinite(y)
    ? { x, y, ...(Number.isFinite(elevationMeters) && elevationMeters >= 0 ? { elevationMeters } : {}) }
    : null;
}

function tokenPoint(token) {
  return token?.placement === 'map' ? finitePoint(token) : null;
}

function failure(code, reason, details = {}) {
  const messages = {
    path_blocked: '路径被建筑或其他障碍阻挡',
    token_locked: '此 Token 已锁定，无法移动',
    status_movement_forbidden: '当前状态禁止移动',
    entity_conflict: 'Token 位置已更新，请重新拖动',
    world_state_stale: '地图状态已更新，请重新拖动',
  };
  return Object.freeze({ ...clone(details), valid: false, code,
    reason: /[\u3400-\u9fff]/.test(reason || '') ? reason : messages[code] || '移动未能完成，请重试' });
}

export function createMovementFastPathSystem() {
  return Object.freeze({
    register(api) {
      if (!api.movement?.canonicalSceneTokens) throw new Error('Movement fast path requires canonical Movement Runtime');

      const authoritativeValidate = createMovementAuthority(() => api.mapPackage);
      const grids = new Map();

      async function validateTokenMove(tokenId, destination, options = {}) {
        const access = api.movement.inspectMovementAccess?.(tokenId, destination, options);
        if (!access?.valid) return access || failure('movement_access_denied', '当前 Token 无法移动');
        const movementMode = normalizeMovementMode(options.movementMode, access.token.movement?.mode || 'walk');
        const state = api.getState?.() || {};
        const scene = api.world?.getActiveScene?.() || null;
        const authoritative = authoritativeValidate({
          state, world: api.world.get(), scene, token: access.token,
          origin: { ...access.from, elevationMeters: access.from.elevationMeters ?? tokenElevationMeters(access.token) },
          waypoints: [{ ...access.destination, elevationMeters: destination.elevationMeters ?? tokenElevationMeters(access.token) }],
          ruleset: api.ruleset, movementMode, verticalAction: options.verticalAction,
        });
        if (authoritative.valid) return clone({ valid: true, code: 'ok', points: [access.from, access.destination],
          distance: authoritative.costMeters, destination: access.destination, ...authoritative });
        return failure(authoritative.code || 'path_blocked', authoritative.reason, authoritative);
      }

      async function moveTokenTo(tokenId, destination) {
        return moveTokenPath([tokenId], tokenId, [destination], { method: 'drag' });
      }

      async function moveTokenPath(rawTokenIds, leaderId, rawWaypoints, { method = 'drag', movementMode = null, verticalAction = null } = {}) {
        const tokenIds = [...new Set((Array.isArray(rawTokenIds) ? rawTokenIds : []).map(String).filter(Boolean))];
        const leader = api.tokens?.get?.(leaderId);
        movementMode ||= api.movement?.getPreferredMode?.(leaderId) || leader?.movement?.mode || 'walk';
        const leaderOrigin = tokenPoint(leader);
        const waypoints = (Array.isArray(rawWaypoints) ? rawWaypoints : []).map(finitePoint).filter(Boolean);
        if (!leader || !leaderOrigin || !tokenIds.length || tokenIds.length > 64 || !tokenIds.includes(String(leaderId))) {
          return failure('invalid_move_group', '移动目标无效');
        }
        if (!waypoints.length || waypoints.length > 64) return failure('invalid_move_path', '移动路径必须包含 1-64 个节点');
        const expectedOrigins = {};
        let distance = 0;
        try {
          for (const tokenId of tokenIds) {
            const token = api.tokens.get(tokenId);
            const origin = tokenPoint(token);
            if (!token || !origin) return failure('token_not_on_map', `Token ${tokenId} 当前不在地图上`);
            const offset = {
              x: origin.x - leaderOrigin.x,
              y: origin.y - leaderOrigin.y,
              elevationMeters: (origin.elevationMeters || 0) - (leaderOrigin.elevationMeters || 0),
            };
            const route = waypoints.map(point => ({
              x: point.x + offset.x,
              y: point.y + offset.y,
              elevationMeters: Math.max(0, (point.elevationMeters ?? leaderOrigin.elevationMeters ?? 0) + offset.elevationMeters),
            }));
            let from = origin;
            for (const destination of route) {
              const validation = await validateTokenMove(tokenId, destination, { from, movementMode, verticalAction });
              if (!validation?.valid) return validation;
              distance += Number(validation.distance) || Math.hypot(destination.x - from.x, destination.y - from.y);
              from = destination;
            }
            expectedOrigins[tokenId] = origin;
          }
          // Both offline and LAN animation starts from committed document changes.
          // A render during prediction could otherwise enqueue the old canonical origin.
          const sceneId = String(api.world.get()?.activeSceneId || '');
          const result = await api.documents.dispatch({
            action: 'move',
            document: { type: 'Token', id: String(leaderId), parent: { type: 'Scene', id: sceneId } },
            intent: 'token.movePath',
            data: { tokenIds, waypoints, method: method === 'keyboard' ? 'keyboard' : 'drag',
              movementMode: normalizeMovementMode(movementMode, leader.movement?.mode || 'walk'), verticalAction },
            precondition: { expectedOrigins },
          });
          api.movement.invalidateNavigation?.();
          return { valid: true, code: 'ok', committed: true, distance, destination: waypoints.at(-1), result };
        } catch (error) {
          api.emit?.('token:move-cancelled', {
            id: String(leaderId), tokenId: String(leaderId), tokenIds,
            code: error?.code || 'movement_failed', reason: error?.message || String(error || 'movement cancelled'),
          });
          return failure(error?.code || 'movement_failed', error?.message || 'Token 移动失败');
        }
      }

      function inspectTokenMove(tokenId, destination, options = {}) {
        const access = api.movement.inspectMovementAccess?.(tokenId, destination, options);
        if (!access?.valid) return access || failure('movement_access_denied', '当前 Token 无法移动');
        const movementMode = normalizeMovementMode(options.movementMode,
          api.movement?.getPreferredMode?.(tokenId) || access.token.movement?.mode || 'walk');
        const state = api.getState?.() || {};
        const authoritative = authoritativeValidate({
          state, world: api.world.get(), scene: api.world?.getActiveScene?.(), token: access.token,
          origin: { ...access.from, elevationMeters: access.from.elevationMeters ?? tokenElevationMeters(access.token) },
          waypoints: [{ ...access.destination,
            elevationMeters: access.destination.elevationMeters ?? tokenElevationMeters(access.token) }],
          ruleset: api.ruleset, movementMode, verticalAction: options.verticalAction,
        });
        return authoritative.valid
          ? clone({ valid: true, code: 'ok', ...authoritative })
          : failure(authoritative.code || 'path_blocked', authoritative.reason || '路径不可通行', authoritative);
      }

      api.movementFast = Object.freeze({
        validateTokenMove,
        inspectTokenMove,
        moveTokenTo,
        moveTokenPath,
        clearNavigationCache() { grids.clear(); },
        getNavigationCacheSize() { return grids.size; },
      });

      for (const eventName of ['scene:damage', 'scene:restore', 'scene:undo', 'state:import']) {
        api.on?.(eventName, () => grids.clear());
      }
      api.on?.('scene:content-change', event => {
        if (event.detail?.types?.includes('SceneEvent')) grids.clear();
      });
    },
  });
}
