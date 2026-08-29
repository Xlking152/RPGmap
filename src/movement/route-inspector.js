import {
  createNavigationBase,
  createNavigationGrid,
  findDirectNavigationPath,
  inspectDirectNavigationPath,
} from '../engine/navigation.js';
import { deriveSceneState } from '../engine/state.js';
import { tokenDiameterMeters, tokenElevationFt } from '../elevation/model.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function finitePoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
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

export function createMovementRouteInspector(api) {
  const staticBase = createNavigationBase(api.mapPackage);
  let navigationGrid = null;
  let navigationRevision = null;

  function navigation(token) {
    const state = api.getState?.() || {};
    const scene = api.world?.getActiveScene?.() || null;
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

  function invalidate() {
    navigationGrid = null;
    navigationRevision = null;
  }

  async function findSegment(tokenId, from, to) {
    const token = api.tokens?.get?.(tokenId);
    const start = finitePoint(from);
    const destination = finitePoint(to);
    if (!token || !start || !destination) return null;
    return clone(await findDirectNavigationPath(navigation(token), start, destination));
  }

  function inspectSegment(tokenId, from, to) {
    const token = api.tokens?.get?.(tokenId);
    const start = finitePoint(from);
    const destination = finitePoint(to);
    if (!token || !start || !destination) return { valid: false, reason: '无效移动端点' };
    return clone(inspectDirectNavigationPath(navigation(token), start, destination));
  }

  return Object.freeze({ findSegment, inspectSegment, invalidate });
}
