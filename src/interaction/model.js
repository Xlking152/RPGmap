import { commitDamageEvent, damagePreviewSignature, normalizeAttackArea, deriveSceneState } from '../engine/state.js';
import { featureToPolygon } from '../engine/geometry.js';
import { recordFeatureInteractionEffects } from './effects.js';
import {
  FEATURE_STATE_KEY,
  LEGACY_FEATURE_INTERACTION_STATE_KEY,
  getFeatureState,
  patchFeatureState,
  setFeatureCustomState,
} from './feature-state.js';
import { evaluateFeatureStatusRule } from './status-rules.js';

export { FEATURE_STATE_KEY, LEGACY_FEATURE_INTERACTION_STATE_KEY, setFeatureCustomState };

export const FEATURE_ACTION_META = Object.freeze({
  inspect: Object.freeze({ id: 'inspect', label: '检查', kind: 'read' }),
  enter: Object.freeze({ id: 'enter', label: '进入', kind: 'movement' }),
  exit: Object.freeze({ id: 'exit', label: '离开', kind: 'movement' }),
  damage: Object.freeze({ id: 'damage', label: '整体破坏', kind: 'scene' }),
  restore: Object.freeze({ id: 'restore', label: '恢复此对象', kind: 'scene' }),
  open: Object.freeze({ id: 'open', label: '打开', kind: 'state' }),
  close: Object.freeze({ id: 'close', label: '关闭', kind: 'state' }),
});

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find(feature => String(feature.id) === String(featureId)) || null;
}

function entityState(state) {
  const entity = state?.preferences?.entitySystem;
  return entity && typeof entity === 'object' ? entity : { actors: [], tokens: [] };
}

function tokenById(state, tokenId) {
  if (tokenId == null) return null;
  const world = state?.preferences?.worldV2;
  const scene = world?.scenes?.find(item => String(item.id) === String(world.activeSceneId));
  return (scene ? scene.tokens || [] : entityState(state).tokens || [])
    .find(token => String(token?.id) === String(tokenId)) || null;
}

/** Internal synchronous read context. Callers must never mutate its state. */
export function createFeatureReadContext(rawState) {
  const world = rawState?.preferences?.worldV2;
  const scene = world?.scenes?.find(item => String(item.id) === String(world.activeSceneId));
  const state = scene ? { ...rawState, sceneEvents: scene.sceneEvents || [] } : rawState;
  return { state, derivedScene: deriveSceneState(state?.sceneEvents || []) };
}

function tokenFeatureId(token) {
  if (!token || token.placement === 'map') return null;
  return token.featureId == null ? null : String(token.featureId);
}

/** Declaration only; runtime status and permissions are checked separately. */
export function declaredFeatureAction(feature, action) {
  const actions = feature?.capabilities?.actions;
  if (actions && typeof actions[action] === 'boolean') return actions[action];
  if (action === 'inspect') return feature?.capabilities?.inspectable ?? feature?.inspectable !== false;
  if (action === 'enter' || action === 'exit') return feature?.capabilities?.enterable ?? feature?.enterable === true;
  if (action === 'damage' || action === 'restore') return feature?.capabilities?.destructible ?? Boolean(feature?.destructible);
  if (action === 'open' || action === 'close') return feature?.capabilities?.openable ?? feature?.openable === true;
  return false;
}

export function getFeatureRuntimeState(state, feature, derivedScene = null) {
  const featureState = getFeatureState(state, feature, derivedScene);
  recordFeatureInteractionEffects(feature, featureState);
  return featureState;
}

export function getFeatureInteractionState(state, feature) {
  const featureState = getFeatureRuntimeState(state, feature);
  return Object.freeze({ open: featureState.open });
}

export function patchFeatureRuntimeState(state, featureId, patch = {}) {
  return patchFeatureState(state, featureId, patch);
}

export function setFeatureOpenState(state, featureId, open) {
  return patchFeatureState(state, featureId, { open: Boolean(open) });
}

function descriptor(action, enabled, reason = '') {
  return Object.freeze({
    ...FEATURE_ACTION_META[action],
    enabled: Boolean(enabled),
    reason: enabled ? '' : String(reason || ''),
  });
}

export function listFeatureInteractions({ mapPackage, state, featureId, tokenId = null, resolveStatus = null, derivedScene = null } = {}) {
  const feature = featureById(mapPackage, featureId);
  if (!feature) return Object.freeze([]);

  const featureState = getFeatureRuntimeState(state, feature, derivedScene);
  const token = tokenId ? tokenById(state, tokenId) : null;
  const actions = [];
  // Every descriptor in this synchronous list reads the same Token. Keep one
  // coherent snapshot for this call; a later list or execution resolves again.
  let statusResolved = false, statusSnapshot;
  const resolveListStatus = typeof resolveStatus === 'function' ? context => {
    if (!statusResolved) {
      statusSnapshot = resolveStatus(context);
      statusResolved = true;
    }
    return statusSnapshot;
  } : resolveStatus;
  const statusReason = action => {
    const result = evaluateFeatureStatusRule({ feature, action, tokenId, resolveStatus: resolveListStatus });
    return result.ok ? '' : result.reason;
  };

  if (declaredFeatureAction(feature, 'inspect')) {
    const reason = statusReason('inspect');
    actions.push(descriptor('inspect', !reason, reason));
  }

  if (declaredFeatureAction(feature, 'enter')) {
    let reason = '';
    if (!Array.isArray(feature.entrance) || feature.entrance.length < 2) reason = 'Feature 未声明 entrance';
    else if (featureState.destroyed) reason = '对象已经被摧毁';
    else if (declaredFeatureAction(feature, 'open') && !featureState.open) reason = '对象当前处于关闭状态';
    else if (!token) reason = '请先选择 Token';
    else if (token.placement !== 'map') reason = 'Token 当前不在地图上';
    else reason = statusReason('enter');
    actions.push(descriptor('enter', !reason, reason));
  }

  if (declaredFeatureAction(feature, 'exit')) {
    const inside = tokenFeatureId(token) === String(feature.id);
    const reason = inside ? statusReason('exit') : '所选 Token 当前不在该 Feature 内';
    actions.push(descriptor('exit', !reason, reason));
  }

  if (declaredFeatureAction(feature, 'damage')) {
    const reason = featureState.destroyed ? '对象已经被摧毁' : statusReason('damage');
    actions.push(descriptor('damage', !reason, reason));
  }

  if (declaredFeatureAction(feature, 'restore')) {
    const reason = !featureState.damaged ? '对象当前完整' : statusReason('restore');
    actions.push(descriptor('restore', !reason, reason));
  }

  if (declaredFeatureAction(feature, 'open')) {
    const reason = featureState.destroyed
      ? '对象已经被摧毁'
      : featureState.open ? '对象已经打开' : statusReason('open');
    actions.push(descriptor('open', !reason, reason));
  }

  if (declaredFeatureAction(feature, 'close')) {
    const reason = featureState.destroyed
      ? '对象已经被摧毁'
      : !featureState.open ? '对象已经关闭' : statusReason('close');
    actions.push(descriptor('close', !reason, reason));
  }

  return Object.freeze(actions);
}

function geometryPoints(feature) {
  const result = [];
  const collect = value => {
    if (Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      result.push({ x: Number(value[0]), y: Number(value[1]) });
    } else if (Array.isArray(value)) value.forEach(collect);
  };
  collect(featureToPolygon(feature));
  return result;
}

function featureCenter(feature, points) {
  if (Array.isArray(feature?.center) && feature.center.length >= 2) {
    return { x: Number(feature.center[0]), y: Number(feature.center[1]) };
  }
  if (!points.length) throw new TypeError(`Feature "${feature?.id || '?'}" has no center or polygon`);
  const sum = points.reduce((accumulator, point) => ({
    x: accumulator.x + point.x,
    y: accumulator.y + point.y,
  }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function wholeFeatureRadius(points, center) {
  if (!points.length) return 10;
  return Math.max(10, ...points.map(point => Math.hypot(
    point.x - center.x,
    point.y - center.y,
  ))) + 2;
}

export function damageFeatureState(state, mapPackage, featureId) {
  const feature = featureById(mapPackage, featureId);
  if (!feature) throw new TypeError(`Unknown Feature "${featureId}"`);
  if (!declaredFeatureAction(feature, 'damage')) throw new TypeError(`Feature "${featureId}" is not destructible`);
  if (getFeatureRuntimeState(state, feature).destroyed) return state;

  const points = geometryPoints(feature);
  const center = featureCenter(feature, points);
  const area = {
    id: `interaction-damage-${feature.id}`,
    type: 'circle',
    center,
    radius: wholeFeatureRadius(points, center),
  };
  // An explicit object action affects exactly this ID. It does not need to
  // intersect a synthetic attack with every fragment of a large wall.
  const preview = { areaSnapshot: normalizeAttackArea(area), categories: null,
    signature: damagePreviewSignature(area, null), objectIds: [String(feature.id)], clipHits: [] };
  return commitDamageEvent(state, area, preview);
}

export function featureInteractionSnapshot({ mapPackage, state, featureId, tokenId = null, resolveStatus = null, derivedScene = null } = {}) {
  const feature = featureById(mapPackage, featureId);
  if (!feature) return null;
  const featureState = getFeatureRuntimeState(state, feature, derivedScene);
  return Object.freeze({
    feature: structuredClone(feature),
    featureState,
    sceneStatus: featureState.status,
    interactionState: Object.freeze({ open: featureState.open }),
    actions: listFeatureInteractions({ mapPackage, state, featureId, tokenId, resolveStatus, derivedScene }),
  });
}
