import {
  damageFeatureState,
  featureInteractionSnapshot,
  getFeatureRuntimeState,
  listFeatureInteractions,
  patchFeatureRuntimeState,
  setFeatureOpenState,
} from './model.js';

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find((feature) => String(feature.id) === String(featureId)) || null;
}

function result(action, featureId, ok, reason = '', detail = {}) {
  return Object.freeze({
    action,
    featureId: featureId == null ? null : String(featureId),
    ok: Boolean(ok),
    reason: String(reason || ''),
    ...detail,
  });
}

function actionMessage(action, feature) {
  const name = feature?.name || feature?.id || 'Feature';
  if (action === 'inspect') return `检查：${name}`;
  if (action === 'enter') return `前往进入：${name}`;
  if (action === 'exit') return `离开：${name}`;
  if (action === 'damage') return `已破坏：${name}`;
  if (action === 'restore') return `已恢复：${name}`;
  if (action === 'open') return `已打开：${name}`;
  if (action === 'close') return `已关闭：${name}`;
  return name;
}

export function createFeatureOperations({
  mapPackage,
  getState,
  replaceState,
  selectFeature = null,
  planFeatureEntry = null,
  exitFeature = null,
  restoreFeatures = null,
  emit = null,
} = {}) {
  if (!mapPackage || !Array.isArray(mapPackage.features)) {
    throw new TypeError('Feature Operations require a prepared MapPackage');
  }
  if (typeof getState !== 'function') throw new TypeError('Feature Operations require getState()');
  if (typeof replaceState !== 'function') throw new TypeError('Feature Operations require replaceState(state)');

  const send = (name, detail) => emit?.(name, detail);

  const actionsForFeature = (featureId, context = {}) => listFeatureInteractions({
    mapPackage,
    state: getState(),
    featureId,
    characterId: context.characterId ?? null,
  });

  const snapshot = (featureId, context = {}) => featureInteractionSnapshot({
    mapPackage,
    state: getState(),
    featureId,
    characterId: context.characterId ?? null,
  });

  const stateForFeature = (featureId) => {
    const feature = featureById(mapPackage, featureId);
    return feature ? getFeatureRuntimeState(getState(), feature) : null;
  };

  const patchState = (featureId, patch) => {
    const feature = featureById(mapPackage, featureId);
    if (!feature) return null;
    const next = patchFeatureRuntimeState(getState(), feature.id, patch);
    replaceState(next);
    const featureState = getFeatureRuntimeState(next, feature);
    send('interaction:state-change', { featureId: feature.id, state: featureState });
    return featureState;
  };

  const execute = (action, options = {}) => {
    const featureId = options.featureId;
    const state = getState();
    const feature = featureById(mapPackage, featureId);
    if (!feature) return result(action, featureId, false, 'Feature 不存在');

    const characterId = options.characterId ?? null;
    const descriptor = listFeatureInteractions({
      mapPackage,
      state,
      featureId: feature.id,
      characterId,
    }).find((entry) => entry.id === action);
    if (!descriptor) return result(action, feature.id, false, 'Feature 未声明该 Interaction Capability');
    if (!descriptor.enabled) return result(action, feature.id, false, descriptor.reason);

    try {
      if (action === 'inspect') {
        if (typeof selectFeature !== 'function') return result(action, feature.id, false, 'Runtime 未提供 selectFeature port');
        const ok = selectFeature(feature.id, options) !== false;
        return result(action, feature.id, ok, ok ? '' : 'Feature 无法被选择', { characterId, message: ok ? actionMessage(action, feature) : '' });
      }

      if (action === 'enter') {
        if (typeof planFeatureEntry !== 'function') return result(action, feature.id, false, 'Runtime 未提供 planFeatureEntry port');
        const ok = planFeatureEntry({ feature, characterId, entrance: feature.entrance, options }) !== false;
        return result(action, feature.id, ok, ok ? '' : '无法规划进入 Feature', { characterId, message: ok ? actionMessage(action, feature) : '' });
      }

      if (action === 'exit') {
        if (typeof exitFeature !== 'function') return result(action, feature.id, false, 'Runtime 未提供 exitFeature port');
        const ok = exitFeature({ feature, characterId, options }) !== false;
        return result(action, feature.id, ok, ok ? '' : '无法离开 Feature', { characterId, message: ok ? actionMessage(action, feature) : '' });
      }

      if (action === 'damage') {
        const next = damageFeatureState(state, mapPackage, feature.id);
        if (next === state) return result(action, feature.id, false, '对象当前无法继续破坏');
        replaceState(next);
        const event = next.sceneEvents?.at?.(-1) || null;
        getFeatureRuntimeState(next, feature);
        send('scene:damage', event ? structuredClone(event) : null);
        return result(action, feature.id, true, '', { characterId, event, message: actionMessage(action, feature) });
      }

      if (action === 'restore') {
        if (typeof restoreFeatures !== 'function') return result(action, feature.id, false, 'Runtime 未提供 restoreFeatures port');
        const ok = restoreFeatures([feature.id]) === true;
        return result(action, feature.id, ok, ok ? '' : '对象当前完整', { characterId, message: ok ? actionMessage(action, feature) : '' });
      }

      if (action === 'open' || action === 'close') {
        const open = action === 'open';
        const next = setFeatureOpenState(state, feature.id, open);
        replaceState(next);
        const featureState = getFeatureRuntimeState(next, feature);
        send('interaction:state-change', { featureId: feature.id, open, state: featureState, characterId });
        return result(action, feature.id, true, '', { characterId, open, state: featureState, message: actionMessage(action, feature) });
      }

      return result(action, feature.id, false, '未知 Interaction Action');
    } catch (error) {
      return result(action, feature.id, false, error?.message || String(error), { characterId });
    }
  };

  return Object.freeze({
    actionsForFeature,
    execute,
    snapshot,
    stateForFeature,
    patchState,
    inspect(featureId, options = {}) { return execute('inspect', { ...options, featureId }); },
    enter(featureId, characterId = null, options = {}) { return execute('enter', { ...options, featureId, characterId }); },
    exit(featureId, characterId = null, options = {}) { return execute('exit', { ...options, featureId, characterId }); },
    damage(featureId, options = {}) { return execute('damage', { ...options, featureId }); },
    restore(featureId, options = {}) { return execute('restore', { ...options, featureId }); },
    open(featureId, options = {}) { return execute('open', { ...options, featureId }); },
    close(featureId, options = {}) { return execute('close', { ...options, featureId }); },
  });
}
