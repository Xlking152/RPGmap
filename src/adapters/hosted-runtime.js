import { createInitialRuntimeState } from '../engine/runtime-state.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../world/model.js';
import { readConnectionState } from '../multiplayer/connection-state.js';
import { prepareWorldContentState } from './world-import.js';

const reconnectError = () => Object.assign(new Error('请连接服务器后再编辑 World'), { code: 'world_reconnect_pending' });

// Hosted state is a server projection. This adapter never owns a local save or
// transitions to standalone authority, including an explicit socket logout.
export const hostedRuntimeAdapters = Object.freeze({
  prepare({ worldId, worldName, mapPackage, ruleset }) {
    const seed = createInitialRuntimeState(mapPackage, { ruleset });
    const world = createWorldV2FromRuntimeState(seed, { worldId, worldName, mapPackage, ruleset });
    return { state: projectWorldV2ToRuntimeState(seed, world, { mapPackage, ruleset }), blocked: false, notice: null };
  },
  prepareImport: prepareWorldContentState,
  persistImport() { throw reconnectError(); },
  isolation() {
    return { enter() { return false; }, updateConnection() { return false; }, get active() { return true; } };
  },
  persistence({ initialLoad, getApi }) {
    const connected = () => readConnectionState(getApi())?.connected === true;
    return {
      load: () => initialLoad,
      schedule() {}, cancel() {}, dispose() {}, suspend() {}, resume() {},
      // ACKed server operations are already durable; no client write is queued.
      persistNow: connected, persistTrustedNow: connected,
      persistValidatedAsync: async () => connected(),
      replace() { throw reconnectError(); },
      getLocalExploration: () => null,
      setLocalExploration() { throw reconnectError(); },
      setLocalExplorationSnapshot() { throw reconnectError(); },
      get blocked() { return false; },
    };
  },
});
