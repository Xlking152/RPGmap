import {
  damageFeatureState,
  featureInteractionSnapshot,
  getFeatureRuntimeState,
  listFeatureInteractions,
  patchFeatureRuntimeState,
  setFeatureOpenState,
} from './model.js';
import { commitRestoreEvent } from '../engine/state.js';
import { featureStatusMutations } from './status-rules.js';

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
  resolveStatus = null,
  getStatusDefinitions = null,
  applyStatusMutations = null,
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
    resolveStatus,
  });

  const snapshot = (featureId, context = {}) => featureInteractionSnapshot({
    mapPackage,
    state: getState(),
    featureId,
    characterId: context.characterId ?? null,
    resolveStatus,
  });

  const statusMutationsFor = (feature, action, state, characterId) => featureStatusMutations({
    feature,
    action,
    state,
    characterId,
    definitions: typeof getStatusDefinitions === 'function' ? getStatusDefinitions() : [],
  });

  const applyStatusEffects = (draft, feature, action, characterId) => {
    const mutations = statusMutationsFor(feature, action, draft, characterId);
    if (!mutations.length) return { state: draft, mutations };
    if (typeof applyStatusMutations !== 'function') throw new Error('Runtime 未提供原子状态副作用 port');
    const next = applyStatusMutations(draft, mutations, {
      source: { type: 'feature', featureId: feature.id, action },
    });
    if (next && typeof next.then === 'function') throw new Error('状态副作用草稿必须同步构造');
    if (!next || typeof next !== 'object') throw new Error('状态副作用未返回有效 World 草稿');
    return { state: next, mutations };
  };

  const stateForFeature = (featureId) => {
    const feature = featureById(mapPackage, featureId);
    return feature ? getFeatureRuntimeState(getState(), feature) : null;
  };

  const patchState = (featureId, patch) => {
    const feature = featureById(mapPackage, featureId);
    if (!feature) return null;
    const next = patchFeatureRuntimeState(getState(), feature.id, patch);
    return Promise.resolve(replaceState(next, { source: 'feature:patch', featureId: feature.id })).then(() => {
      const featureState = getFeatureRuntimeState(getState(), feature);
      send('interaction:state-change', { featureId: feature.id, state: featureState });
      return featureState;
    });
  };

  const execute = async (action, options = {}) => {
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
      resolveStatus,
    }).find((entry) => entry.id === action);
    if (!descriptor) return result(action, feature.id, false, 'Feature 未声明该 Interaction Capability');
    if (!descriptor.enabled) return result(action, feature.id, false, descriptor.reason);

    try {
      if (action === 'inspect') {
        if (typeof selectFeature !== 'function') return result(action, feature.id, false, 'Runtime 未提供 selectFeature port');
        const ok = selectFeature(feature.id, options) !== false;
        if (!ok) return result(action, feature.id, false, 'Feature 无法被选择', { characterId });
        const draft = applyStatusEffects(state, feature, action, characterId);
        if (draft.state !== state) await Promise.resolve(replaceState(draft.state, { source: 'feature:inspect', featureId: feature.id }));
        return result(action, feature.id, true, '', { characterId, statusMutations: draft.mutations, message: actionMessage(action, feature) });
      }

      if (action === 'enter') {
        if (typeof planFeatureEntry !== 'function') return result(action, feature.id, false, 'Runtime 未提供 planFeatureEntry port');
        const statusMutations = statusMutationsFor(feature, action, state, characterId);
        const ok = (await Promise.resolve(planFeatureEntry({ feature, characterId, entrance: feature.entrance, options, statusMutations }))) !== false;
        return result(action, feature.id, ok, ok ? '' : '无法规划进入 Feature', { characterId, statusMutations, message: ok ? actionMessage(action, feature) : '' });
      }

      if (action === 'exit') {
        if (typeof exitFeature !== 'function') return result(action, feature.id, false, 'Runtime 未提供 exitFeature port');
        const statusMutations = statusMutationsFor(feature, action, state, characterId);
        const ok = (await Promise.resolve(exitFeature({ feature, characterId, options, statusMutations }))) !== false;
        return result(action, feature.id, ok, ok ? '' : '无法离开 Feature', { characterId, statusMutations, message: ok ? actionMessage(action, feature) : '' });
      }

      if (action === 'damage') {
        const damaged = damageFeatureState(state, mapPackage, feature.id);
        if (damaged === state) return result(action, feature.id, false, '对象当前无法继续破坏');
        const draft = applyStatusEffects(damaged, feature, action, characterId);
        await Promise.resolve(replaceState(draft.state, { source: 'feature:damage', featureId: feature.id }));
        const committed = getState();
        const event = committed.sceneEvents?.at?.(-1) || null;
        getFeatureRuntimeState(committed, feature);
        send('scene:damage', event ? structuredClone(event) : null);
        return result(action, feature.id, true, '', { characterId, event, statusMutations: draft.mutations, message: actionMessage(action, feature) });
      }

      if (action === 'restore') {
        const restored = commitRestoreEvent(state, [feature.id]);
        if (restored === state) return result(action, feature.id, false, '对象当前完整');
        const draft = applyStatusEffects(restored, feature, action, characterId);
        await Promise.resolve(replaceState(draft.state, { source: 'feature:restore', featureId: feature.id }));
        const event = getState().sceneEvents?.at?.(-1) || null;
        send('scene:restore', event ? structuredClone(event) : null);
        return result(action, feature.id, true, '', {
          characterId, event, statusMutations: draft.mutations, message: actionMessage(action, feature),
        });
      }

      if (action === 'open' || action === 'close') {
        const open = action === 'open';
        const changed = setFeatureOpenState(state, feature.id, open);
        const draft = applyStatusEffects(changed, feature, action, characterId);
        await Promise.resolve(replaceState(draft.state, { source: `feature:${action}`, featureId: feature.id }));
        const featureState = getFeatureRuntimeState(getState(), feature);
        send('interaction:state-change', { featureId: feature.id, open, state: featureState, characterId });
        return result(action, feature.id, true, '', { characterId, open, state: featureState, statusMutations: draft.mutations, message: actionMessage(action, feature) });
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
