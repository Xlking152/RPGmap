import { readConnectionState } from "../multiplayer/connection-state.js";
import { createVisionBackground } from './background.js';
import { computeFogExplorationAsync } from './fog.js';
import { computeFogExplorationDeltaAsync } from './exploration-delta.js';
import { ownedExplorationSnapshot, prepareOwnedExplorationJob, createQueuedExplorationJob, isOrdinaryExplorationJobs } from './owned-exploration-snapshot.js';

export function createLocalExplorationQueue(api, commit, { getExploredRows } = {}) {
  let state = api.getLocalExploration?.();
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.jobs)) state = { schemaVersion: 1, jobs: [] };
  const snapshotsEnabled = typeof api.setLocalExplorationSnapshot === 'function';
  if (snapshotsEnabled && isOrdinaryExplorationJobs(state.jobs)) state.jobs = state.jobs.map(prepareOwnedExplorationJob);
  let running = false, disposed = false, sequence = 0;
  let controller = null;
  let inFlightJob = null;
  const cancelled = new Set();
  let background = createVisionBackground({ diagnostics: api.diagnostics });
  const session = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const saveMetadata = () => {
    const snapshot = snapshotsEnabled ? ownedExplorationSnapshot(state) : null;
    if (snapshot) api.setLocalExplorationSnapshot(snapshot);
    else api.setLocalExploration?.(state);
  };
  function persist() {
    saveMetadata();
    if (api.persistNow?.() === false) throw new Error('探索路径未能可靠保存');
  }
  async function drain() {
    if (running || disposed || readConnectionState(api)?.connected || !state.jobs.length) return;
    running = true;
    try {
      while (!disposed && !readConnectionState(api)?.connected && state.jobs.length) {
        const job = state.jobs[0];
        inFlightJob = job;
        controller = new AbortController();
        let added;
        try {
          // Capture only confirmed rows at work start. This borrowed private
          // history never becomes part of the durable job or its shared input.
          const workInput = typeof getExploredRows === 'function'
            ? { ...job.input, explorationDelta: true,
              exploredRows: structuredClone(getExploredRows(job.sceneId, job.input.partyId) ?? {}) }
            : job.input;
          const compute = () => typeof getExploredRows === 'function'
            ? computeFogExplorationDeltaAsync(workInput, { signal: controller.signal })
            : computeFogExplorationAsync(workInput, {}, { signal: controller.signal });
          try { added = background ? await background.run(workInput)
            : await compute(); }
          catch (error) {
            if (controller.signal.aborted || disposed || !state.jobs.some(item => item.id === job.id)) continue;
            background?.dispose(); background = null;
            added = await compute();
          }
          if (disposed || controller.signal.aborted || !state.jobs.some(item => item.id === job.id)) continue;
          if (readConnectionState(api)?.connected) break;
          const before = state.jobs;
          state.jobs = before.filter(item => item.id !== job.id);
          saveMetadata();
          try {
            if (typeof getExploredRows === 'function') await commit(job, added, { explorationDelta: true });
            else await commit(job, added);
          }
          catch (error) {
            if (!cancelled.has(job.id) && !state.jobs.some(item => item.id === job.id)) state.jobs.unshift(job);
            saveMetadata();
            if (!cancelled.has(job.id)) throw error;
          }
        } finally { controller = null; inFlightJob = null; cancelled.delete(job.id); }
      }
    } catch (error) { api.showToast?.(`历史探索已保留，处理暂停：${error.message}`, 'error'); }
    finally { running = false; }
  }
  return {
    enqueue(input, sceneId) {
      const id = `${session}:${++sequence}`;
      if (snapshotsEnabled) {
        state.jobs.push(createQueuedExplorationJob(id, String(sceneId), input, session));
        saveMetadata();
        return id;
      }
      const job = { id, sceneId: String(sceneId), input: { ...input,
        contextVersion: `local:${session}:${input.contextVersion ?? id}` } };
      state.jobs.push({ ...job, input: structuredClone(job.input) });
      saveMetadata();
      return id;
    },
    persist,
    start() { queueMicrotask(drain); },
    cancel(sceneId = null, partyId = null) {
      const matches = job => job && (sceneId === null || job.sceneId === String(sceneId))
        && (partyId === null || job.input.partyId === String(partyId));
      const ids = new Set(state.jobs.filter(matches).map(job => job.id));
      if (matches(inFlightJob)) { cancelled.add(inFlightJob.id); controller?.abort(); background?.cancel(); }
      state.jobs = state.jobs.filter(job => !ids.has(job.id)); saveMetadata();
    },
    stats() { return { queued: state.jobs.length, running }; },
    dispose() { disposed = true; controller?.abort(); background?.dispose(); },
  };
}
