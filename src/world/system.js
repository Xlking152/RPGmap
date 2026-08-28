import {
  WORLD_STATE_KEY,
  activeWorldScene,
  attachWorldV2,
  createEmptyWorldScene,
  createWorldV2FromRuntimeState,
  normalizeWorldV2,
  projectWorldV2ToRuntimeState,
  synchronizeWorldV2FromRuntimeState,
} from './model.js';
import { pruneProjectedWorldReferences } from './references.js';
import { assertWorldRuleset } from './validation.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

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
      const coreCommitState = api.commitState?.bind(api);
      const coreCommitAuthoritativeState = api.commitAuthoritativeState?.bind(api);
      if (typeof coreCommitState !== 'function') throw new Error('World V2 requires api.commitState()');
      if (!runtimeRuleset?.id) throw new Error('World V2 requires api.ruleset');

      function normalizeForRuntime(state, { preferCanonical = false } = {}) {
        const rawWorld = currentWorldFromState(state);
        let ruleset = runtimeRuleset;
        let world;
        if (rawWorld) {
          ruleset = requireRuntimeRuleset(rawWorld, runtimeRuleset);
          world = normalizeWorldV2(rawWorld, { mapPackage, ruleset });
          world = normalizeWorldV2(world, { mapPackage, ruleset });
          if (preferCanonical) return projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
          world = synchronizeWorldV2FromRuntimeState(state, { mapPackage, ruleset, existingWorld: world });
          return attachWorldV2(state, world);
        }

        // Legacy save conversion happens before WorldSystem, at the persistence
        // and import boundary. A state without World V2 here is therefore only
        // a new modern runtime seed.
        world = createWorldV2FromRuntimeState(state, { mapPackage, ruleset, worldId, worldName });
        return projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
      }

      function hydrateCanonical(state) {
        const rawWorld = currentWorldFromState(state);
        if (!rawWorld) return normalizeForRuntime(state);
        return normalizeForRuntime(state, { preferCanonical: true });
      }

      const initialState = api.getState?.() || {};
      const created = !currentWorldFromState(initialState);
      const initial = hydrateCanonical(initialState);
      coreCommitState(initial, { source: 'world-v2:hydrate', render: false });

      api.commitState = (nextState, options = {}) => coreCommitState(
        normalizeForRuntime(nextState),
        options,
      );

      if (typeof coreCommitAuthoritativeState === 'function') {
        api.commitAuthoritativeState = (nextState, options = {}) => coreCommitAuthoritativeState(
          normalizeForRuntime(nextState),
          options,
        );
      }

      function snapshot() {
        const state = api.getState?.() || {};
        const raw = currentWorldFromState(state);
        const ruleset = raw ? requireRuntimeRuleset(raw, runtimeRuleset) : runtimeRuleset;
        return normalizeWorldV2(raw || createWorldV2FromRuntimeState(state, {
          mapPackage,
          ruleset,
          worldId,
          worldName,
        }), { mapPackage, ruleset });
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
        if (typeof coreCommitAuthoritativeState === 'function') {
          return coreCommitAuthoritativeState(projected, { source, reason, render });
        }
        coreCommitState(projected, { source, render });
        return { offline: true };
      }

      api.world = {
        schemaVersion: 2,
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
        syncState(state) { return normalizeForRuntime(state); },
        projectState(state) { return hydrateCanonical(state); },
      };

      api.emit?.('world:ready', {
        world: snapshot(),
        created,
      });
    },
  });
}
