import { WORLD_STATE_KEY, activeWorldScene, createEmptyWorldScene, normalizeWorldV2,
  projectWorldV2ToRuntimeState } from './model.js';
import { assertWorldRuleset } from './validation.js';
import { pruneProjectedWorldReferences } from './references.js';
import { deriveWorldOperations } from './operation-intents.js';
import { readConnectionState } from '../multiplayer/connection-state.js';
import { readRuntimeState } from '../engine/state-access.js';
import { createRuntimeSessionCore } from '../runtime/core/session-base.js';
import { worldOperationsToDocumentWrites } from '../documents/protocol.js';

const clone = structuredClone;
const fail = (message, code) => Object.assign(new Error(message), { code });

export function createHostedWorldSystem() {
  return { register(api) {
    if (!api || api.world) return;
    const mapPackage = api.mapPackage, ruleset = api.ruleset;
    const coreCommitState = api.commitState.bind(api);
    const state = () => readRuntimeState(api);
    const worldOf = value => value?.preferences?.[WORLD_STATE_KEY];
    const snapshot = () => {
      const world = worldOf(state());
      assertWorldRuleset(world, ruleset);
      return clone(world);
    };
    const requireConnected = () => {
      const connection = readConnectionState(api);
      if (!connection?.connected) throw fail('请连接服务器后再编辑 World', 'world_reconnect_pending');
      return connection;
    };
    const sameMap = scene => String(scene?.mapPackage?.id) === String(mapPackage.id)
      && String(scene?.mapPackage?.version) === String(mapPackage.version);
    const hydrateCanonical = value => {
      assertWorldRuleset(worldOf(value), ruleset);
      const world = normalizeWorldV2(worldOf(value), { mapPackage, ruleset });
      return projectWorldV2ToRuntimeState(value, world, { mapPackage, ruleset });
    };
    let transition = null;
    const requireTransitionCommand = operations => {
      if (transition && !operations.every(operation => String(operation.payload?.sceneId || '') === transition.sceneId
        && (transition.kind === 'switch' ? operation.type === 'scene.activate'
          : ['scene.environment.reset', 'scene.clear'].includes(operation.type)))) {
        throw fail('场景正在切换或重置，请等待完成后重新操作', 'scene_transition_pending');
      }
    };
    const invalidateExploration = () => api.emit?.('vision:exploration-cancel', null);
    for (const event of ['state:import', 'scene:activate', 'vision:source-change']) api.on?.(event, invalidateExploration);
    for (const event of ['scene:switch-starting', 'scene:reset-starting']) api.on?.(event, ({ detail } = {}) => {
      transition = { kind: event === 'scene:switch-starting' ? 'switch' : 'reset', sceneId: String(detail?.sceneId || '') };
      invalidateExploration();
    });
    for (const event of ['scene:switch-complete', 'scene:switch-failed', 'scene:environment-reset', 'scene:cleared', 'scene:reset-failed']) {
      api.on?.(event, () => { transition = null; });
    }

    async function commitWorld(world, { source = 'world-v2', reason = source, render = true } = {}) {
      requireConnected();
      assertWorldRuleset(world, ruleset);
      const normalized = normalizeWorldV2(world, { mapPackage, ruleset });
      if (!sameMap(activeWorldScene(normalized))) throw fail('目标场景需要重新载入地图 Runtime', 'world_scene_map_reload_required');
      const projected = pruneProjectedWorldReferences(projectWorldV2ToRuntimeState(state(), normalized, { mapPackage, ruleset }));
      return api.commitAuthoritativeState(projected, { source, reason, render });
    }

    // Legacy UI projection intents are submitted to the server. The existing
    // canonical World stays intact until its acknowledged Document changes arrive.
    api.commitState = (next, options = {}) => {
      requireConnected();
      const current = state();
      if (JSON.stringify(worldOf(next)) !== JSON.stringify(worldOf(current))) {
        throw fail('Runtime state was based on a stale canonical World snapshot', 'world_state_stale');
      }
      const derived = deriveWorldOperations(current, next);
      if (derived.unsupported.some(reason => ['world_identity', 'operation_limit'].includes(reason))) {
        throw fail('Runtime state cannot change canonical World boundary', 'world_operation_unsupported');
      }
      if (derived.operations.length) return api.world.performOperations(derived.operations, { source: options.source || 'state:commit' });
      return coreCommitState(next, options);
    };

    api.runtimeSession = createRuntimeSessionCore({
      ruleset, mapForScene: scene => sameMap(scene) ? mapPackage : null,
      getCanonicalState: state, getCanonicalRevision: () => api.getStateRevision?.(),
      authority: { managesScheduling: true, apply({ operations, context, operationId }) {
        requireConnected(); requireTransitionCommand(operations);
        if (typeof api.multiplayer?.performOperations !== 'function') throw fail('服务器不支持 World 操作', 'world_operation_unavailable');
        return api.multiplayer.performOperations(operations, { kind: context.kind || 'world', requestedOperationId: operationId });
      } },
    });
    api.on?.('app:destroy', () => { api.runtimeSession.dispose(); invalidateExploration(); });
    api.world = {
      queuesConfirmedExploration: true,
      isSceneTransitionPending: () => Boolean(transition),
      get: snapshot,
      getActiveScene: () => clone(activeWorldScene(snapshot())),
      getExplorationStatus: () => ({ queued: 0, running: false }),
      listScenes: () => snapshot().scenes,
      listActors: () => snapshot().actors,
      async createSceneRecoveryPoint(sceneId, { reason = 'scene.reset' } = {}) {
        const connection = requireConnected(), world = snapshot();
        if (!world.scenes.some(scene => String(scene.id) === String(sceneId))) throw fail('Scene not found', 'scene_not_found');
        const role = connection.session?.role ?? connection.role ?? api.multiplayer?.getCapabilities?.()?.role;
        if (role !== 'gm') throw fail('只有 GM 可以创建场景恢复点', 'scene_reset_gm_only');
        if (typeof api.multiplayer?.fetchManagement !== 'function') throw fail('服务器不支持场景恢复点', 'recovery_point_required');
        const response = await api.multiplayer.fetchManagement('/api/manage/worlds/scene-backup', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId: String(sceneId), reason: String(reason) }),
        });
        const receipt = await response.json();
        if (!response.ok || receipt.error) throw fail(receipt.message || receipt.error || '场景备份失败', receipt.code || 'recovery_point_failed');
        return receipt;
      },
      async commit(world, options = {}) { await commitWorld(world, options); return snapshot(); },
      async createScene(options = {}) {
        const world = createEmptyWorldScene(snapshot(), { mapPackage, ...options, ruleset });
        await commitWorld(world, { source: 'world-v2:scene.create', reason: 'scene.create', render: false });
        return clone(world.scenes[world.scenes.length - 1]);
      },
      async setActiveScene(sceneId) {
        const world = snapshot(), target = world.scenes.find(scene => String(scene.id) === String(sceneId));
        if (!target) throw fail('Scene not found', 'scene_not_found');
        if (!sameMap(target)) throw fail('目标场景需要重新载入地图 Runtime', 'world_scene_map_reload_required');
        const ownsTransition = !transition;
        if (ownsTransition) api.emit?.('scene:switch-starting', { sceneId: target.id, mapPackage: clone(target.mapPackage) });
        try {
          await commitWorld({ ...world, activeSceneId: target.id, updatedAt: new Date().toISOString() }, { source: 'world-v2:scene.activate', reason: 'scene.activate' });
          if (ownsTransition) api.emit?.('scene:switch-complete', { sceneId: target.id, mapPackage: clone(target.mapPackage) });
          return clone(target);
        } catch (error) {
          if (ownsTransition) api.emit?.('scene:switch-failed', { sceneId: target.id });
          throw error;
        }
      },
      async rename(name) { const world = snapshot(); await commitWorld({ ...world, name: String(name || '').trim() || world.name }, { reason: 'world.rename' }); return snapshot(); },
      async performOperations(operations, options = {}) {
        requireConnected(); requireTransitionCommand(operations);
        const world = worldOf(state());
        const writes = worldOperationsToDocumentWrites(operations, { worldId: world.id, sceneId: world.activeSceneId });
        try { return await api.runtimeSession.dispatch(writes, { operationId: options.requestedOperationId, context: options }); }
        catch (error) {
          if (error?.code === 'runtime_session_disposed') throw fail('当前 World 已切换，请重新执行操作', 'world_operation_context_changed');
          throw error;
        }
      },
      patchFeatureState(featureId, patch, options = {}) {
        return api.world.performOperations([{ type: 'scene.featureState.patch', payload: { sceneId: options.sceneId ?? snapshot().activeSceneId, featureId, patch } }], options);
      },
      syncState: hydrateCanonical, projectState: hydrateCanonical,
    };
    api.emit?.('world:ready', { world: snapshot(), created: false });
  } };
}
