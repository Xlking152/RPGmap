import {
  damageFeatureState,
  createFeatureReadContext,
  featureInteractionSnapshot,
  getFeatureRuntimeState,
  listFeatureInteractions,
  patchFeatureRuntimeState,
  setFeatureOpenState,
} from './model.js';
import { commitRestoreEvent } from '../engine/state.js';
import { featureStatusMutations, featureStatusRule } from './status-rules.js';

function featureById(mapPackage, featureId) {
  return (mapPackage?.features || []).find(feature => String(feature.id) === String(featureId)) || null;
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
  readState = null,
  getStateRevision = null,
  replaceState,
  performOperations = null,
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

  let cachedRead = null;
  const readContext = () => {
    const state = typeof readState === 'function' ? readState() : getState();
    const revision = typeof getStateRevision === 'function' ? getStateRevision() : null;
    // Only the private runtime reader with a committed revision qualifies for
    // reuse. Legacy/public ports may return mutable objects and are rederived.
    const qualified = typeof readState === 'function' && Number.isSafeInteger(revision);
    if (qualified && cachedRead?.state === state && cachedRead.revision === revision) return cachedRead.context;
    const context = createFeatureReadContext(state);
    cachedRead = qualified ? { state, revision, context } : null;
    return context;
  };

  const statusWorldOperations = mutations => mutations.map(({ type, ...payload }) => ({ type, payload }));

  const actionsForFeature = (featureId, context = {}) => {
    const prepared = context.readContext || readContext();
    return listFeatureInteractions({ mapPackage, state: prepared.state, derivedScene: prepared.derivedScene,
      featureId, tokenId: context.tokenId ?? null, resolveStatus });
  };

  const snapshot = (featureId, context = {}) => {
    const prepared = context.readContext || readContext();
    return featureInteractionSnapshot({ mapPackage, state: prepared.state, derivedScene: prepared.derivedScene,
      featureId, tokenId: context.tokenId ?? null, resolveStatus });
  };

  const statusMutationsFor = (feature, action, state, tokenId) => {
    const effects = featureStatusRule(feature, action)?.onSuccess;
    const apply = effects?.apply || [], remove = effects?.remove || [];
    const empty = Array.isArray(apply) && Array.isArray(remove) && !apply.length && !remove.length;
    return featureStatusMutations({ feature, action, state, tokenId,
      definitions: !empty && typeof getStatusDefinitions === 'function' ? getStatusDefinitions() : [],
    });
  };

  const applyStatusEffects = (draft, feature, action, tokenId) => {
    const mutations = statusMutationsFor(feature, action, draft, tokenId);
    if (!mutations.length) return { state: draft, mutations };
    if (typeof applyStatusMutations !== 'function') throw new Error('Runtime 未提供原子状态副作用 port');
    const next = applyStatusMutations(draft, mutations, {
      source: { type: 'feature', featureId: feature.id, action },
    });
    if (next && typeof next.then === 'function') throw new Error('状态副作用草稿必须同步构造');
    if (!next || typeof next !== 'object') throw new Error('状态副作用未返回有效 World 草稿');
    return { state: next, mutations };
  };

  const stateForFeature = (featureId, prepared = readContext()) => {
    const feature = featureById(mapPackage, featureId);
    return feature ? getFeatureRuntimeState(prepared.state, feature, prepared.derivedScene) : null;
  };

  const patchState = (featureId, patch) => {
    const feature = featureById(mapPackage, featureId);
    if (!feature) return null;
    const commit = typeof performOperations === 'function'
      ? performOperations([{
        type: 'scene.featureState.patch',
        payload: { featureId: feature.id, patch },
      }], { source: 'feature:patch' })
      : replaceState(patchFeatureRuntimeState(getState(), feature.id, patch), {
        source: 'feature:patch', featureId: feature.id,
      });
    return Promise.resolve(commit).then(() => {
      const featureState = getFeatureRuntimeState(getState(), feature);
      send('interaction:state-change', { featureId: feature.id, state: featureState });
      return featureState;
    });
  };

  const execute = async (action, options = {}) => {
    const featureId = options.featureId;
    const rawState = getState();
    const world = rawState.preferences?.worldV2;
    const scene = world?.scenes?.find(item => String(item.id) === String(world.activeSceneId));
    const state = scene ? { ...rawState, sceneEvents: scene.sceneEvents || [] } : rawState;
    const feature = featureById(mapPackage, featureId);
    if (!feature) return result(action, featureId, false, 'Feature 不存在');

    const tokenId = options.tokenId ?? null;
    const descriptor = listFeatureInteractions({
      mapPackage,
      state,
      featureId: feature.id,
      tokenId,
      resolveStatus,
    }).find(entry => entry.id === action);
    if (!descriptor) return result(action, feature.id, false, 'Feature 未声明该 Interaction Capability');
    if (!descriptor.enabled) return result(action, feature.id, false, descriptor.reason);

    try {
      if (action === 'inspect') {
        if (typeof selectFeature !== 'function') return result(action, feature.id, false, 'Runtime 未提供 selectFeature port');
        const ok = selectFeature(feature.id, options) !== false;
        if (!ok) return result(action, feature.id, false, 'Feature 无法被选择', { tokenId });
        const mutations = statusMutationsFor(feature, action, state, tokenId);
        if (mutations.length && typeof performOperations === 'function') {
          await performOperations(statusWorldOperations(mutations), { source: 'feature:inspect' });
        } else if (mutations.length) {
          const draft = applyStatusEffects(state, feature, action, tokenId);
          await Promise.resolve(replaceState(draft.state, { source: 'feature:inspect', featureId: feature.id }));
        }
        return result(action, feature.id, true, '', { tokenId, statusMutations: mutations, message: actionMessage(action, feature) });
      }

      if (action === 'enter') {
        if (typeof planFeatureEntry !== 'function') return result(action, feature.id, false, 'Runtime 未提供 planFeatureEntry port');
        const statusMutations = statusMutationsFor(feature, action, state, tokenId);
        const ok = (await Promise.resolve(planFeatureEntry({ feature, tokenId, entrance: feature.entrance, options, statusMutations }))) !== false;
        return result(action, feature.id, ok, ok ? '' : '无法规划进入 Feature', { tokenId, statusMutations, message: ok ? actionMessage(action, feature) : '' });
      }

      if (action === 'exit') {
        if (typeof exitFeature !== 'function') return result(action, feature.id, false, 'Runtime 未提供 exitFeature port');
        const statusMutations = statusMutationsFor(feature, action, state, tokenId);
        const ok = (await Promise.resolve(exitFeature({ feature, tokenId, options, statusMutations }))) !== false;
        return result(action, feature.id, ok, ok ? '' : '无法离开 Feature', { tokenId, statusMutations, message: ok ? actionMessage(action, feature) : '' });
      }

      if (action === 'damage') {
        const damaged = damageFeatureState(state, mapPackage, feature.id);
        if (damaged === state) return result(action, feature.id, false, '对象当前无法继续破坏');
        const mutations = statusMutationsFor(feature, action, damaged, tokenId);
        if (typeof performOperations === 'function') {
          const sceneId = state.preferences?.worldV2?.activeSceneId;
          await performOperations([
            { type: 'scene.content.replace', payload: { ...(sceneId ? { sceneId } : {}),
              ...(sceneId ? { expectedActiveSceneId: sceneId } : {}),
              expectedSceneEvents: state.sceneEvents || [], sceneEvents: damaged.sceneEvents } },
            ...statusWorldOperations(mutations),
          ], { source: 'feature:damage' });
        } else {
          const draft = applyStatusEffects(damaged, feature, action, tokenId);
          await Promise.resolve(replaceState(draft.state, { source: 'feature:damage', featureId: feature.id }));
        }
        const event = damaged.sceneEvents.at(-1);
        send('scene:damage', event ? structuredClone(event) : null);
        return result(action, feature.id, true, '', { tokenId, event, statusMutations: mutations, message: actionMessage(action, feature) });
      }

      if (action === 'restore') {
        const restored = commitRestoreEvent(state, [feature.id]);
        if (restored === state) return result(action, feature.id, false, '对象当前完整');
        const mutations = statusMutationsFor(feature, action, restored, tokenId);
        if (typeof performOperations === 'function') {
          const sceneId = state.preferences?.worldV2?.activeSceneId;
          await performOperations([
            { type: 'scene.content.replace', payload: { ...(sceneId ? { sceneId } : {}),
              ...(sceneId ? { expectedActiveSceneId: sceneId } : {}),
              expectedSceneEvents: state.sceneEvents || [], sceneEvents: restored.sceneEvents } },
            ...statusWorldOperations(mutations),
          ], { source: 'feature:restore' });
        } else {
          const draft = applyStatusEffects(restored, feature, action, tokenId);
          await Promise.resolve(replaceState(draft.state, { source: 'feature:restore', featureId: feature.id }));
        }
        const event = restored.sceneEvents.at(-1);
        send('scene:restore', event ? structuredClone(event) : null);
        return result(action, feature.id, true, '', {
          tokenId, event, statusMutations: mutations, message: actionMessage(action, feature),
        });
      }

      if (action === 'open' || action === 'close') {
        const open = action === 'open';
        const mutations = statusMutationsFor(feature, action, state, tokenId);
        if (typeof performOperations === 'function') {
          await performOperations([
            { type: 'scene.door.use', payload: {
              featureId: feature.id,
              tokenId,
              action,
            } },
            ...statusWorldOperations(mutations),
          ], { source: `feature:${action}` });
        } else {
          const changed = setFeatureOpenState(state, feature.id, open);
          const draft = applyStatusEffects(changed, feature, action, tokenId);
          await Promise.resolve(replaceState(draft.state, { source: `feature:${action}`, featureId: feature.id }));
        }
        const featureState = getFeatureRuntimeState(getState(), feature);
        send('interaction:state-change', { featureId: feature.id, open, state: featureState, tokenId });
        return result(action, feature.id, true, '', { tokenId, open, state: featureState, statusMutations: mutations, message: actionMessage(action, feature) });
      }

      return result(action, feature.id, false, '未知 Interaction Action');
    } catch (error) {
      return result(action, feature.id, false, error?.message || String(error), { tokenId });
    }
  };

  return Object.freeze({
    readContext,
    dispose() { cachedRead = null; },
    actionsForFeature,
    execute,
    snapshot,
    stateForFeature,
    patchState,
    inspect(featureId, options = {}) { return execute('inspect', { ...options, featureId }); },
    enter(featureId, tokenId = null, options = {}) { return execute('enter', { ...options, featureId, tokenId }); },
    exit(featureId, tokenId = null, options = {}) { return execute('exit', { ...options, featureId, tokenId }); },
    damage(featureId, options = {}) { return execute('damage', { ...options, featureId }); },
    restore(featureId, options = {}) { return execute('restore', { ...options, featureId }); },
    open(featureId, options = {}) { return execute('open', { ...options, featureId }); },
    close(featureId, options = {}) { return execute('close', { ...options, featureId }); },
  });
}
