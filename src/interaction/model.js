import { createDamagePreview, commitDamageEvent } from '../engine/state.js';
import { featureSceneStatus } from '../engine/feature-selection.js';

export const FEATURE_INTERACTION_STATE_KEY = 'featureInteractions';

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

function actionEnabled(feature, action) {
  const actions = feature?.capabilities?.actions;
  if (actions && typeof actions[action] === 'boolean') return actions[action];
  if (action === 'inspect') return feature?.capabilities?.inspectable ?? feature?.inspectable !== false;
  if (action === 'enter' || action === 'exit') return feature?.capabilities?.enterable ?? feature?.enterable === true;
  if (action === 'damage' || action === 'restore') return feature?.capabilities?.destructible ?? Boolean(feature?.destructible);
  if (action === 'open' || action === 'close') return feature?.capabilities?.openable ?? feature?.openable === true;
  return false;
}

export function getFeatureInteractionState(state, feature) {
  const saved = state?.preferences?.[FEATURE_INTERACTION_STATE_KEY]?.[feature?.id];
  const initialOpen = Boolean(feature?.interaction?.initialOpen ?? feature?.initialOpen ?? false);
  return Object.freeze({
    open: typeof saved?.open === 'boolean' ? saved.open : initialOpen,
  });
}

export function setFeatureOpenState(state, featureId, open) {
  const next = structuredClone(state);
  next.preferences ||= {};
  next.preferences[FEATURE_INTERACTION_STATE_KEY] ||= {};
  next.preferences[FEATURE_INTERACTION_STATE_KEY][String(featureId)] = { open: Boolean(open) };
  return next;
}

function descriptor(action, enabled, reason = '') {
  return Object.freeze({
    ...FEATURE_ACTION_META[action],
    enabled: Boolean(enabled),
    reason: enabled ? '' : String(reason || ''),
  });
}

export function listFeatureInteractions({ mapPackage, state, featureId, characterId = null } = {}) {
  const feature = featureById(mapPackage, featureId);
  if (!feature) return Object.freeze([]);

  const sceneStatus = featureSceneStatus(feature.id, state?.sceneEvents || []);
  const interactionState = getFeatureInteractionState(state, feature);
  const character = characterId ? characterById(state, characterId) : null;
  const actions = [];

  if (actionEnabled(feature, 'inspect')) {
    actions.push(descriptor('inspect', true));
  }

  if (actionEnabled(feature, 'enter')) {
    let reason = '';
    if (!Array.isArray(feature.entrance) || feature.entrance.length < 2) reason = 'Feature 未声明 entrance';
    else if (sceneStatus === 'destroyed') reason = '对象已经被摧毁';
    else if (actionEnabled(feature, 'open') && !interactionState.open) reason = '对象当前处于关闭状态';
    else if (!character) reason = '请先选择角色';
    else if (character.location?.type !== 'map') reason = '角色当前不在地图上';
    actions.push(descriptor('enter', !reason, reason));
  }

  if (actionEnabled(feature, 'exit')) {
    const inside = Boolean(character?.location?.type === 'building'
      && String(character.location.featureId) === String(feature.id));
    actions.push(descriptor('exit', inside, inside ? '' : '所选角色当前不在该 Feature 内'));
  }

  if (actionEnabled(feature, 'damage')) {
    actions.push(descriptor('damage', sceneStatus !== 'destroyed', '对象已经被摧毁'));
  }

  if (actionEnabled(feature, 'restore')) {
    actions.push(descriptor('restore', sceneStatus !== 'intact', '对象当前完整'));
  }

  if (actionEnabled(feature, 'open')) {
    actions.push(descriptor(
      'open',
      sceneStatus !== 'destroyed' && !interactionState.open,
      sceneStatus === 'destroyed' ? '对象已经被摧毁' : '对象已经打开',
    ));
  }

  if (actionEnabled(feature, 'close')) {
    actions.push(descriptor(
      'close',
      sceneStatus !== 'destroyed' && interactionState.open,
      sceneStatus === 'destroyed' ? '对象已经被摧毁' : '对象已经关闭',
    ));
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
  if (featureSceneStatus(feature.id, state?.sceneEvents || []) === 'destroyed') return state;

  const center = featureCenter(feature);
  const area = {
    id: `interaction-damage-${feature.id}`,
    type: 'circle',
    center,
    radius: wholeFeatureRadius(feature, center),
  };
  const preview = createDamagePreview(area, [feature], [feature.category]);
  return commitDamageEvent(state, area, preview);
}

export function featureInteractionSnapshot({ mapPackage, state, featureId, characterId = null } = {}) {
  const feature = featureById(mapPackage, featureId);
  if (!feature) return null;
  return Object.freeze({
    feature,
    sceneStatus: featureSceneStatus(feature.id, state?.sceneEvents || []),
    interactionState: getFeatureInteractionState(state, feature),
    actions: listFeatureInteractions({ mapPackage, state, featureId, characterId }),
  });
}
