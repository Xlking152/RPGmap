import { readConnectionState } from "../multiplayer/connection-state.js";
import {
  WORLD_STATE_KEY,
  activeWorldScene,
  createEmptyWorldScene,
  createWorldV2FromRuntimeState,
  normalizeWorldV2,
  projectWorldV2ToRuntimeState,
} from './model.js';
import { pruneProjectedWorldReferences } from './references.js';
import { assertWorldRuleset } from './validation.js';
import { reduceStatusOperation, STATUS_SCHEMA_VERSION } from '../status/model.js';
import { applyWorldOperations, deriveWorldOperations, prepareFogOperation } from './operations.js';
import { createDocumentChanges } from '../documents/changes.js';
import { createMovementAuthority } from '../movement/authority.js';
import { createVisionBackground } from '../vision/background.js';
import { mergeExploration, computeFogExplorationAsync } from '../vision/fog.js';
import { createLocalExplorationQueue } from '../vision/local-exploration.js';
import { createExplorationOperationCapture } from '../vision/exploration-operations.js';
import { readRuntimeState } from '../engine/state-access.js';

const clone = structuredClone;
const TRUSTED_SAVE_TYPES = new Set(['token.create', 'token.move', 'token.reposition', 'token.movePath', 'scene.fog.explore']);

function currentWorldFromState(state) {
  return state?.preferences?.[WORLD_STATE_KEY] || null;
}

function requireRuntimeRuleset(world, ruleset) {
  assertWorldRuleset(world, ruleset);
  return ruleset;
}

function sameMap(scene, mapPackage) {
  const currentId = String(mapPackage?.mapId ?? mapPackage?.id ?? mapPackage?.manifest?.mapId ?? mapPackage?.manifest?.id ?? '');
  return Boolean(scene && currentId && String(scene.mapPackage?.id) === currentId);
}

export function createWorldSystem({ worldId = 'world-default', worldName = '' } = {}) {
  return Object.freeze({
    register(api) {
      if (!api || api.world) return;
      const mapPackage = api.mapPackage;
      const runtimeRuleset = api.ruleset;
      const movementAuthority = createMovementAuthority(scene => sameMap(scene, mapPackage)
        && String(scene.mapPackage?.version || '') === String(mapPackage.version || mapPackage.mapVersion || '') ? mapPackage : null);
      const coreCommitState = api.commitState?.bind(api);
      const coreCommitAuthoritativeState = api.commitAuthoritativeState?.bind(api);
      if (typeof coreCommitState !== 'function') throw new Error('World V2 requires api.commitState()');
      if (!runtimeRuleset?.id) throw new Error('World V2 requires api.ruleset');

      function normalizeForRuntime(state) {
        const rawWorld = currentWorldFromState(state);
        let ruleset = runtimeRuleset;
        let world;
        if (rawWorld) {
          ruleset = requireRuntimeRuleset(rawWorld, runtimeRuleset);
          world = normalizeWorldV2(rawWorld, { mapPackage, ruleset });
          return projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
        }

        // Legacy save conversion happens before WorldSystem, at the persistence
        // and import boundary. A state without World V2 here is therefore only
        // a new modern runtime seed.
        world = createWorldV2FromRuntimeState(state, { mapPackage, ruleset, worldId, worldName });
        return projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
      }

      function hydrateCanonical(state) {
        return normalizeForRuntime(state);
      }

      const initialState = api.getState?.() || {};
      const created = !currentWorldFromState(initialState);
      const initial = hydrateCanonical(initialState);
      coreCommitState(initial, { source: 'world-v2:hydrate', render: false });

      function applyProjectionIntent(nextState, options = {}) {
        const current = api.getState?.() || {};
        if (!currentWorldFromState(current)) return coreCommitState(normalizeForRuntime(nextState), options);
        if (JSON.stringify(currentWorldFromState(nextState)) !== JSON.stringify(currentWorldFromState(current))) {
          const error = new Error('Runtime state was based on a stale canonical World snapshot');
          error.code = 'world_state_stale';
          throw error;
        }
        const derived = deriveWorldOperations(current, nextState);
        const blocking = derived.unsupported.filter(reason => reason === 'world_identity' || reason === 'operation_limit');
        if (blocking.length) {
          const error = new Error(`Runtime state cannot change canonical World boundary: ${blocking.join(', ')}`);
          error.code = 'world_operation_unsupported';
          throw error;
        }
        const applied = derived.operations.length
          ? reduceOperations(current, derived.operations, { source: options.source || 'state:commit' })
          : { state: current };
        const merged = clone(nextState);
        merged.preferences ||= {};
        merged.preferences[WORLD_STATE_KEY] = clone(currentWorldFromState(applied.state));
        return coreCommitState(hydrateCanonical(merged), options);
      }

      api.commitState = applyProjectionIntent;

      if (typeof coreCommitAuthoritativeState === 'function') {
        api.commitAuthoritativeState = (nextState, options = {}) => coreCommitAuthoritativeState(
          hydrateCanonical(nextState),
          options,
        );
      }

      function snapshot() {
        const state = readRuntimeState(api);
        const raw = currentWorldFromState(state);
        const ruleset = raw ? requireRuntimeRuleset(raw, runtimeRuleset) : runtimeRuleset;
        return clone(raw || createWorldV2FromRuntimeState(state, {
          mapPackage,
          ruleset,
          worldId,
          worldName,
        }));
      }

      async function commitWorld(world, { source = 'world-v2', reason = source, render = true } = {}) {
        const ruleset = requireRuntimeRuleset(world, runtimeRuleset);
        const normalized = normalizeWorldV2(world, { mapPackage, ruleset });
        const scene = activeWorldScene(normalized);
        if (!sameMap(scene, mapPackage)) {
          const error = new Error(`Scene ${scene?.id || '(missing)'} requires MapPackage ${scene?.mapPackage?.id || '(missing)'}`);
          error.code = 'world_scene_map_reload_required';
          throw error;
        }
        const projected = pruneProjectedWorldReferences(
          projectWorldV2ToRuntimeState(api.getState?.() || {}, normalized, { mapPackage, ruleset }),
        );
        invalidateExploration();
        if (!['world-v2:scene.activate', 'world-v2:rename', 'world-v2:scene.create'].includes(source)) localExploration.cancel();
        if (typeof coreCommitAuthoritativeState === 'function') {
          return coreCommitAuthoritativeState(projected, { source, reason, render });
        }
        coreCommitState(projected, { source, render });
        return { offline: true };
      }

      const background = createVisionBackground({ diagnostics: api.diagnostics });
      const localExploration = createLocalExplorationQueue(api, (job, added) => {
        if (api.isLocalWorldActive?.() === false) throw new Error('联机续传期间保留离线探索任务');
        return performOperations([
          { type: 'scene.fog.explore', payload: { ...job.input.payload, sceneId: job.sceneId, partyId: job.input.partyId } },
        ], { source: 'vision:exploration-commit', addedExploration: added });
      });
      const measure = api.diagnostics?.measure
        ? (name, callback) => api.diagnostics.measure(name, callback)
        : (_name, callback) => callback();
      let explorationEpoch = 0;
      let explorationAbort = new AbortController();
      function invalidateExploration() {
        explorationEpoch += 1; explorationAbort.abort(); explorationAbort = new AbortController(); background?.cancel();
        api.emit?.('vision:exploration-cancel', null);
      }
      for (const event of ['state:import', 'scene:activate', 'vision:source-change']) api.on?.(event, () => { invalidateExploration(); });
      api.on?.('state:import', ({ detail } = {}) => {
        if (detail?.persist === false && ['server', 'offline:resume'].includes(detail?.source)) return;
        localExploration.cancel();
      });
      api.on?.('multiplayer:capabilities', () => {
        if (api.isLocalWorldActive?.() !== false) localExploration.start();
      });
      api.on?.('app:destroy', () => { invalidateExploration(); background?.dispose(); localExploration.dispose(); });

      function reduceOperations(state, operations, { source = 'world.operation', now = new Date().toISOString(), computeFogExploration,
        prepareOperation, onOperationApplied } = {}) {
        return applyWorldOperations(state, operations, {
          now,
          ruleset: runtimeRuleset,
          source: { role: 'offline', source },
          mapMetrics: mapPackage,
          mapForScene: scene => sameMap(scene, mapPackage)
            && String(scene.mapPackage?.version || '') === String(mapPackage.version || mapPackage.mapVersion || '') ? mapPackage : null,
          computeFogExploration,
          prepareOperation, onOperationApplied,
          validateTokenMovePath: args => movementAuthority({ ...args, ruleset: runtimeRuleset }),
          applyStatus(statusState, message, context) {
            const next = clone(statusState);
            next.preferences ||= {};
            const reduced = reduceStatusOperation(next.preferences.entitySystem, message, {
              source: context.source,
              now: context.now,
              ruleset: runtimeRuleset,
            });
            next.preferences.entitySystem = reduced.state;
            return { state: next, results: reduced.results };
          },
        });
      }

      async function performOperations(operations, {
        source = 'world.operation',
        render = true,
        kind = 'world',
        requestedOperationId = null,
        addedExploration = null,
      } = {}) {
        const multiplayer = readConnectionState(api);
        if (multiplayer?.connected) {
          if (typeof api.multiplayer?.performOperations !== 'function') {
            throw new Error('当前局域网控制器不支持通用 World 操作');
          }
          return api.multiplayer.performOperations(operations, { kind, requestedOperationId });
        }
        if (api.isLocalWorldActive?.() === false)
          throw Object.assign(new Error('请等待联机续传或主动退出后再编辑离线 World'), { code: 'world_reconnect_pending' });
        let computeFogExploration;
        if (addedExploration) computeFogExploration = (_input, fog) => mergeExploration(fog, addedExploration, mapPackage);
        if (!addedExploration && operations.length === 1 && operations[0].type === 'scene.fog.explore' && source === 'vision:explore') {
          const sceneId = operations[0].payload.sceneId ?? snapshot().activeSceneId;
          const operation = { ...operations[0], payload: { ...operations[0].payload, sceneId } };
          const request = prepareFogOperation(readRuntimeState(api), operation, { ruleset: runtimeRuleset, mapPackage }).input;
          const region = api.vision?.getVisibleRegion?.();
          if (region && String(region.tokenId || api.vision?.getSource?.()) === String(request.payload.visionSourceTokenId))
            request.sourceRangeMeters = Number(region.vagueRangeMeters ?? region.rangeMeters) || 0;
          const jobId = localExploration.enqueue(request, sceneId);
          localExploration.persist(); localExploration.start();
          return { offline: true, queued: true, jobId };
        }
        if (!addedExploration && operations.length === 1 && operations[0].type === 'scene.fog.explore') {
          operations = [{ ...operations[0], payload: { ...operations[0].payload,
            sceneId: operations[0].payload.sceneId ?? snapshot().activeSceneId,
          } }];
          const epoch = explorationEpoch;
          const options = { ruleset: runtimeRuleset, mapMetrics: mapPackage };
          const request = measure('world.fogPrepare', () => prepareFogOperation(readRuntimeState(api), operations[0], options).input);
          let added;
          try { added = background ? await background.run(request)
            : await computeFogExplorationAsync(request, {}, { signal: explorationAbort.signal }); }
          catch (error) { if (epoch !== explorationEpoch) return { unchanged: true }; throw error; }
          if (epoch !== explorationEpoch || readConnectionState(api)?.connected) return { unchanged: true };
          const active = currentWorldFromState(readRuntimeState(api));
          if (String(active?.activeSceneId) !== String(operations[0].payload.sceneId)
            || (source === 'vision:explore' && api.vision?.getSource?.() !== request.payload.visionSourceTokenId)) return { unchanged: true };
          const currentRequest = measure('world.fogPrepare', () => prepareFogOperation(readRuntimeState(api), operations[0], options).input);
          // Exploration is additive: merge concurrent results into the latest fog.
          // Resets, hides and full World replacements invalidate the epoch instead.
          if (currentRequest.contextVersion !== request.contextVersion || currentRequest.lineOfSightEnabled !== request.lineOfSightEnabled) return { unchanged: true };
          computeFogExploration = (_input, fog) => mergeExploration(fog, added, mapPackage);
        }
        const before = readRuntimeState(api);
        const selectedSource = api.vision?.getSource?.();
        const explorationCapture = createExplorationOperationCapture({ sourceIds: selectedSource ? [selectedSource] : [],
          ruleset: runtimeRuleset, mapForScene: scene => sameMap(scene, mapPackage) ? mapPackage : null });
        const applied = measure('world.reduce', () => reduceOperations(before, operations, { source, computeFogExploration,
          prepareOperation: explorationCapture.prepareOperation, onOperationApplied: explorationCapture.onOperationApplied }));
        // Validation must succeed before destructive operations invalidate any
        // previously confirmed paths. Save the cancellation with the new World.
        const invalidating = applied.results.filter(result => ['scene.fog.hide', 'scene.fog.reset',
          'scene.delete', 'scene.reset', 'scene.upsert'].includes(result.action));
        if (invalidating.length) invalidateExploration();
        for (const event of explorationCapture.events) {
          if (event.type === 'cancel') localExploration.cancel(event.sceneId, event.partyId);
          else for (const input of event.inputs) localExploration.enqueue(input, event.sceneId);
        }
        const changes = measure('world.changes', () => createDocumentChanges(before, applied.state, null, {
          motion: applied.results.flatMap(result => result.motion || []),
          fog: applied.results.filter(result => Object.hasOwn(result, 'dirtyBounds')),
        }));
        for (const result of applied.results) {
          for (const motion of result.motion || []) {
            api.renderer?.prepareTokenVisualRoute?.(motion.tokenId, motion.waypoints || []);
          }
        }
        const authorityDocuments = typeof api.applyAuthoritativeDocumentChanges === 'function';
        if (authorityDocuments) {
          measure('world.commit', () => api.applyAuthoritativeDocumentChanges(changes, {
            source: `document.${source}`, operationId: requestedOperationId,
            updatedAt: applied.state.preferences.worldV2.updatedAt,
          }));
        } else {
          coreCommitState(hydrateCanonical(applied.state), { source, render });
          api.documents?.applyCommitted?.(changes, { operationId: requestedOperationId });
        }
        // Validated movement/Fog writes use the small trusted save path. Finish
        // those immediately instead of adding a timer between commit and ACK;
        // heavier full validation can still yield before its synchronous write.
        const trustedWorldRevision = authorityDocuments && applied.operations.length === 1
          && TRUSTED_SAVE_TYPES.has(applied.operations[0].type) ? api.getStateRevision?.() : null;
        if (trustedWorldRevision === null) await new Promise(resolve => setTimeout(resolve, 0));
        const persisted = measure('world.persist', () => api.persistNow?.({ trustedWorldRevision }));
        if (persisted === false) throw new Error('World 操作未能可靠保存，写入已暂停');
        localExploration.start();
        return { offline: true, operations: clone(applied.operations), results: clone(applied.results), changes };
      }

      api.world = {
        queuesConfirmedExploration: true,
        getExplorationStatus: () => localExploration.stats(),
        schemaVersion: STATUS_SCHEMA_VERSION,
        get: snapshot,
        getActiveScene() { return clone(activeWorldScene(snapshot())); },
        listScenes() { return clone(snapshot().scenes); },
        listActors() { return clone(snapshot().actors); },
        async commit(world, options = {}) {
          await commitWorld(world, options);
          return snapshot();
        },
        async createScene(options = {}) {
          const next = createEmptyWorldScene(snapshot(), { mapPackage, ...options });
          await commitWorld(next, { source: 'world-v2:scene.create', reason: 'scene.create', render: false });
          return clone(next.scenes[next.scenes.length - 1]);
        },
        async setActiveScene(sceneId) {
          const world = snapshot();
          const target = world.scenes.find(scene => String(scene.id) === String(sceneId));
          if (!target) throw new Error(`Unknown Scene: ${sceneId}`);
          if (!sameMap(target, mapPackage)) {
            const error = new Error(`Scene ${target.id} uses MapPackage ${target.mapPackage.id}; a map reload is required`);
            error.code = 'world_scene_map_reload_required';
            throw error;
          }
          await commitWorld({ ...world, activeSceneId: target.id, updatedAt: new Date().toISOString() }, {
            source: 'world-v2:scene.activate', reason: 'scene.activate', render: true,
          });
          return clone(target);
        },
        async rename(name) {
          const world = snapshot();
          await commitWorld({ ...world, name: String(name || '').trim() || world.name, updatedAt: new Date().toISOString() }, {
            source: 'world-v2:rename', reason: 'world.rename', render: false,
          });
          return snapshot();
        },
        performOperations,
        patchFeatureState(featureId, patch, options = {}) {
          return performOperations([{
            type: 'scene.featureState.patch',
            payload: {
              sceneId: options.sceneId ?? snapshot().activeSceneId,
              featureId,
              patch,
            },
          }], { ...options, source: options.source || 'scene.featureState.patch' });
        },
        reduceOperations(state, operations, options = {}) {
          return reduceOperations(state, operations, options);
        },
        syncState(state) { return hydrateCanonical(state); },
        projectState(state) { return hydrateCanonical(state); },
      };

      api.emit?.('world:ready', {
        world: snapshot(),
        created,
      });
      localExploration.start();
    },
  });
}
