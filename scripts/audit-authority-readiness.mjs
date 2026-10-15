import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createWorldWal } from '../deployment/local-server/world-wal.mjs';
import { applyWorldOperationPatch } from '../src/world/operations.js';

const fail = (message, code, detail = {}) => Object.assign(new Error(message), { code, ...detail });
const partyKey = job => JSON.stringify([job.sceneId, job.partyId]);
const epoch = (snapshot, job) => snapshot.exploration.partyEpochs[partyKey(job)] || 0;

// Read only. A checkpoint can replace world.json and then compact the WAL
// between reads; that observation is discarded, never repaired or written.
export function createAuditAuthorityReader(mapDir) {
  if (!mapDir) throw fail('Environment audit requires its actual server data directory', 'audit_authority_required');
  const file = path.join(mapDir, 'world.json');
  const wal = createWorldWal({ filePath: path.join(mapDir, 'world.operations.ndjson'),
    applyPatch: (state, patch) => applyWorldOperationPatch(state, patch, { project: false }) });
  return async () => {
    const before = JSON.parse(await readFile(file, 'utf8'));
    let snapshot, replayError;
    try { snapshot = await wal.replay(before, { repairTail: false }); }
    catch (error) { replayError = error; }
    const after = JSON.parse(await readFile(file, 'utf8'));
    if (Number(before.revision) !== Number(after.revision)) return null;
    if (replayError) throw replayError;
    return snapshot;
  };
}

export const auditReplicaExpression = `(() => {
  const api = document.querySelector('#app').rpgMapApp;
  return { status: api.multiplayer.getStatus(), world: api.world.get(), hostRevision: api.getStateRevision(),
    map: { id: api.mapPackage.id, version: api.mapPackage.version, fingerprint: api.mapPackage.fingerprint },
    ruleset: { id: api.ruleset.id, version: api.ruleset.version }, sourceId: api.vision.getSource() };
})()`;

export function comparableAuditWorld(world) {
  const value = structuredClone(world);
  // normalizeStatusDefinition maps an omitted defaultDuration to null. This
  // optional no-duration view default is the sole permitted shape difference;
  // keep timestamps, actual durations, private data and every other key exact.
  if (Array.isArray(value?.statusDefinitions)) for (const definition of value.statusDefinitions) {
    if (definition && typeof definition === 'object' && !Array.isArray(definition)
      && !Object.hasOwn(definition, 'defaultDuration')) definition.defaultDuration = null;
  }
  return value;
}

export function auditWorldDifferences(left, right, limit = 8) {
  const differences = [], preview = value => value === undefined ? '<absent>'
    : typeof value === 'string' ? value.slice(0, 160)
      : value && typeof value === 'object' ? Array.isArray(value) ? `<Array length=${value.length}>`
        : `<Object keys=${Object.keys(value).slice(0, 6).join(',')}>` : value;
  const visit = (a, b, location) => {
    if (differences.length >= limit || isDeepStrictEqual(a, b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object'
      && Array.isArray(a) === Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        visit(a[key], b[key], `${location}.${key}`);
        if (differences.length >= limit) break;
      }
    } else differences.push({ path: location, replica: preview(a), authority: preview(b) });
  };
  visit(left, right, 'world');
  return differences;
}

/** Supplementary preparation time; never part of an ordinary browser gate. */
export async function waitForAuditAuthority({ readAuthority, readReplica, expectedMap = null,
  timeoutMs = 60_000, stableMs = 100, pollMs = 25, now = () => performance.now(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = now(), observed = new Map();
  let stableSince = null, stableRevision = null, polls = 0, last = null;
  const observe = snapshot => {
    if (!snapshot?.exploration?.jobs || !snapshot.exploration.contexts || !snapshot.exploration.partyEpochs
      || typeof snapshot.exploration.worldEpoch !== 'string') {
      throw fail('Durable exploration metadata is unavailable', 'audit_exploration_metadata_missing');
    }
    for (const [id, entry] of observed) {
      if (snapshot.exploration.worldEpoch !== entry.worldEpoch || epoch(snapshot, entry.job) !== entry.epoch) {
        throw fail(`Exploration job was cancelled while preparing audit: ${id}`, 'audit_exploration_cancelled', { jobId: id });
      }
      const current = snapshot.exploration.jobs[id];
      if (!current && entry.completedRevision === null) entry.completedRevision = snapshot.revision;
      if (current && current.cursor < entry.lastCursor) throw fail(`Exploration cursor regressed: ${id}`, 'audit_exploration_regressed');
      if (current) entry.lastCursor = current.cursor;
    }
    for (const [id, job] of Object.entries(snapshot.exploration.jobs)) if (!observed.has(id)) {
      observed.set(id, { job, worldEpoch: job.worldEpoch, epoch: job.epoch, firstCursor: job.cursor,
        lastCursor: job.cursor, totalSamples: job.totalSamples, completedRevision: null });
    }
    // finishExplorationChunk/invalidateExploration call collectContexts, which
    // retains exactly the contexts referenced by live jobs. Empty jobs must
    // therefore have empty contexts; an orphan is a broken contract, not idle.
    const jobs = Object.keys(snapshot.exploration.jobs).length, contexts = Object.keys(snapshot.exploration.contexts).length;
    if (!jobs && contexts) throw fail('Unreferenced durable exploration contexts remain after drain', 'audit_exploration_context_leak');
    return { revision: snapshot.revision, jobs, contexts, worldEpoch: snapshot.exploration.worldEpoch };
  };
  while (now() - started < timeoutMs) {
    polls++;
    const before = await readAuthority();
    if (!before) { stableSince = null; await pause(pollMs); continue; }
    const beforeQueue = observe(before), replica = await readReplica(), after = await readAuthority();
    if (!after) { stableSince = null; await pause(pollMs); continue; }
    const afterQueue = observe(after), world = after.state?.preferences?.worldV2;
    const scene = world?.scenes?.find(item => item.id === world.activeSceneId);
    const identityMatches = replica.world?.id === world?.id && replica.world?.activeSceneId === scene?.id
      && replica.map?.id === scene?.mapPackage?.id && String(replica.map?.version) === String(scene?.mapPackage?.version)
      && replica.ruleset?.id === world?.ruleset?.id && String(replica.ruleset?.version) === String(world?.ruleset?.version)
      && (!expectedMap || (replica.map.id === expectedMap.id && String(replica.map.version) === String(expectedMap.version)
        && replica.map.fingerprint === expectedMap.fingerprint));
    if (!identityMatches) throw fail('Audit replica World/Scene/map/rules identity differs from its authority', 'audit_authority_identity_mismatch');
    const status = replica.status || {};
    const replicaWorld = comparableAuditWorld(replica.world), authorityWorld = comparableAuditWorld(world);
    const worldMatches = isDeepStrictEqual(replicaWorld, authorityWorld);
    const ready = beforeQueue.revision === afterQueue.revision && beforeQueue.worldEpoch === afterQueue.worldEpoch
      && !beforeQueue.jobs && !afterQueue.jobs && !beforeQueue.contexts && !afterQueue.contexts
      && status.connected === true && status.resuming === false && status.applyingRemote === false
      && status.pendingOperationCount === 0 && status.session?.role === 'gm'
      && status.revision === afterQueue.revision && worldMatches;
    last = { before: beforeQueue, after: afterQueue, replicaRevision: status.revision,
      connected: status.connected, resuming: status.resuming, applyingRemote: status.applyingRemote,
      pendingOperations: status.pendingOperationCount, worldMatches,
      ...(worldMatches ? {} : { worldDifferences: auditWorldDifferences(replicaWorld, authorityWorld) }) };
    if (ready) {
      if (stableSince === null || stableRevision !== afterQueue.revision) { stableSince = now(); stableRevision = afterQueue.revision; }
      if (now() - stableSince >= stableMs) return { elapsedMs: now() - started, stableMs: now() - stableSince,
        polls, serverRevision: afterQueue.revision, hostRevision: replica.hostRevision,
        worldId: world.id, sceneId: scene.id, map: replica.map, sourceId: replica.sourceId,
        jobsRemaining: 0, contextsRemaining: 0,
        completedJobs: [...observed].map(([id, entry]) => ({ id, sceneId: entry.job.sceneId,
          partyId: entry.job.partyId, tokenId: entry.job.tokenId, firstCursor: entry.firstCursor,
          lastCursor: entry.lastCursor, totalSamples: entry.totalSamples, completedRevision: entry.completedRevision,
          worldEpoch: entry.worldEpoch, partyEpoch: entry.epoch })) };
    } else { stableSince = null; stableRevision = null; }
    await pause(pollMs);
  }
  throw fail('Environment audit authority/GM replica did not become idle and identical', 'audit_readiness_timeout', { readiness: last });
}
