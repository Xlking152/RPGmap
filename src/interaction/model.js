import { createDamagePreview, commitDamageEvent } from '../engine/state.js';
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
  damage: Object.freeze({ id: 'damage', label: '破坏对象', kind: 'scene' }),
  restore: Object.freeze({ id: 'restore', label: '恢复对象', kind: 'scene' }),
  open: Object.freeze({ id: 'open', label: '打开', kind: 'state' }),
  close: Object.freeze({ id: 'close', label: '关闭', kind: 'state' }),
});

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find((feature) => String(feature.id) === String(featureId)) || null;
}

function characterById(state, characterId) {
  return (state?.characters || []).find((character) => String(character.id) === String(characterId)) || null;
}

function characterFeatureId(character) {
  const type = character?.location?.type;
  if (type !== 'feature' && type !== 'building') return null;
  return character.location.featureId == null ? null : String(character.location.featureId);
}

function actionEnabled(feature, action) {
  const actions = feature?.capabilities?.actions;
  if (actions && typeof actions[action] === 'boolean') return actions[action];
  if (action === 'inspect') return feature?.capabilities?.inspectable ?? feature?.inspectable !== false;
  if (action === 'enter' || action === 'exit') return feature?.capabilities?.enterable ?? feature?.enterable === true;
  if (action === 'damage' || action === 'restore') return feature?.capabilities?.destructible ?? Boolean(feature?.destructible);
  if (action === 'open' || action === 'close') return feature?.capabilities?.openable ?? feature?.openable === true;
  return false;
}

export function getFeatureRuntimeState(state, feature) {
  const featureState = getFeatureState(state, feature);
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

export function listFeatureInteractions({ mapPackage, state, featureId, characterId = null, resolveStatus = null } = {}) {
  const feature = featureById(mapPackage, featureId);
  if (!feature) return Object.freeze([]);

  const featureState = getFeatureRuntimeState(state, feature);
  const character = characterId ? characterById(state, characterId) : null;
  const actions = [];
  const statusReason = action => {
    const result = evaluateFeatureStatusRule({ feature, action, characterId, resolveStatus });
    return result.ok ? '' : result.reason;
  };

  if (actionEnabled(feature, 'inspect')) {
    const reason = statusReason('inspect');
    actions.push(descriptor('inspect', !reason, reason));
  }

  if (actionEnabled(feature, 'enter')) {
    let reason = '';
    if (!Array.isArray(feature.entrance) || feature.entrance.length < 2) reason = 'Feature 未声明 entrance';
    else if (featureState.destroyed) reason = '对象已经被摧毁';
    else if (actionEnabled(feature, 'open') && !featureState.open) reason = '对象当前处于关闭状态';
    else if (!character) reason = '请先选择角色';
    else if (character.location?.type !== 'map') reason = '角色当前不在地图上';
    else reason = statusReason('enter');
    actions.push(descriptor('enter', !reason, reason));
  }

  if (actionEnabled(feature, 'exit')) {
    const inside = characterFeatureId(character) === String(feature.id);
    const reason = inside ? statusReason('exit') : '所选角色当前不在该 Feature 内';
    actions.push(descriptor('exit', !reason, reason));
  }

  if (actionEnabled(feature, 'damage')) {
    const reason = featureState.destroyed ? '对象已经被摧毁' : statusReason('damage');
    actions.push(descriptor('damage', !reason, reason));
  }

  if (actionEnabled(feature, 'restore')) {
    const reason = !featureState.damaged ? '对象当前完整' : statusReason('restore');
    actions.push(descriptor('restore', !reason, reason));
  }

  if (actionEnabled(feature, 'open')) {
    const reason = featureState.destroyed
      ? '对象已经被摧毁'
      : featureState.open ? '对象已经打开' : statusReason('open');
    actions.push(descriptor('open', !reason, reason));
  }

  if (actionEnabled(feature, 'close')) {
    const reason = featureState.destroyed
      ? '对象已经被摧毁'
      : !featureState.open ? '对象已经关闭' : statusReason('close');
    actions.push(descriptor('close', !reason, reason));
  }

  return Object.freeze(actions);
}

function featureCenter(feature) {
  if (Array.isArray(feature?.center) && feature.center.length >= 2) {
    return { x: Number(feature.center[0]), y: Number(feature.center[1]) };
  }
  const points = feature?.geometry?.points || [];
  if (!points.length) throw new TypeError(`Feature "${feature?.id || '?'}" has no center or polygon`);
  const sum = points.reduce((accumulator, point) => ({
    x: accumulator.x + Number(point[0]),
    y: accumulator.y + Number(point[1]),
  }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function wholeFeatureRadius(feature, center) {
  const points = feature?.geometry?.points || [];
  if (!points.length) return 10;
  return Math.max(10, ...points.map((point) => Math.hypot(
    Number(point[0]) - center.x,
    Number(point[1]) - center.y,
  ))) + 2;
}

export function damageFeatureState(state, mapPackage, featureId) {
  const feature = featureById(mapPackage, featureId);
  if (!feature) throw new TypeError(`Unknown Feature "${featureId}"`);
  if (!actionEnabled(feature, 'damage')) throw new TypeError(`Feature "${featureId}" is not destructible`);
  if (getFeatureRuntimeState(state, feature).destroyed) return state;

  const center = featureCenter(feature);
  const area = {
    id: `interaction-damage-${feature.id}`,
    type: 'circle',
    center,
    radius: wholeFeatureRadius(feature, center),
  };
  // The explicit Feature operation already selected its target by ID and Capability.
  // Passing only that Feature removes the old need to route a direct action through
  // a map category filter.
  const preview = createDamagePreview(area, [feature], null);
  return commitDamageEvent(state, area, preview);
}

export function featureInteractionSnapshot({ mapPackage, state, featureId, characterId = null, resolveStatus = null } = {}) {
  const feature = featureById(mapPackage, featureId);
  if (!feature) return null;
  const featureState = getFeatureRuntimeState(state, feature);
  return Object.freeze({
    feature,
    featureState,
    sceneStatus: featureState.status,
    interactionState: Object.freeze({ open: featureState.open }),
    actions: listFeatureInteractions({ mapPackage, state, featureId, characterId, resolveStatus }),
  });
}
