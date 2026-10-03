import { createHash, randomUUID } from 'node:crypto';

const MAX_JOBS = 4096;
const MAX_BYTES = 32 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { code: 'exploration_queue_invalid' }); };
const own = (value, key) => Object.hasOwn(value || {}, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = structuredClone;
const keyFor = (sceneId, partyId) => JSON.stringify([String(sceneId), String(partyId)]);

export function emptyExploration() {
  return { schemaVersion: 1, worldEpoch: randomUUID(), partyEpochs: {}, contexts: {}, jobs: {} };
}

export function validateExploration(value) {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.worldEpoch !== 'string'
    || !object(value.partyEpochs) || !object(value.contexts) || !object(value.jobs)) fail('Invalid durable exploration state');
  if (Object.keys(value.jobs).length > MAX_JOBS || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) {
    throw Object.assign(new Error('Exploration backlog is full; retry after it has drained'), { code: 'exploration_backlog' });
  }
  for (const epoch of Object.values(value.partyEpochs)) if (!Number.isSafeInteger(epoch) || epoch < 0) fail('Invalid exploration epoch');
  for (const [id, context] of Object.entries(value.contexts)) {
    if (!/^[a-f0-9]{64}$/.test(id) || createHash('sha256').update(JSON.stringify(context)).digest('hex') !== id) fail('Exploration context checksum mismatch');
    if (!object(context?.map) || !Number.isFinite(context.map.metersPerUnit) || context.map.metersPerUnit <= 0
      || !Array.isArray(context.occluders) || !Array.isArray(context.lights)) fail('Invalid durable exploration context');
  }
  for (const [id, job] of Object.entries(value.jobs)) {
    if (!object(job) || id !== job.id || !own(value.contexts, job.contextId) || job.worldEpoch !== value.worldEpoch
      || !job.sceneId || !job.partyId || !job.tokenId || !Array.isArray(job.path) || !job.path.length
      || !Number.isSafeInteger(job.cursor) || job.cursor < 0 || !Number.isSafeInteger(job.totalSamples)
      || job.totalSamples < 1 || job.cursor >= job.totalSamples || !Number.isSafeInteger(job.createdRevision)
      || job.createdRevision < 1 || !Number.isFinite(job.vagueRangeMeters) || job.vagueRangeMeters <= 0
      || job.path.length > 65 || job.path.some(point => !object(point)
        || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.elevationMeters))
      || job.totalSamples !== explorationSampleCount(job.path, value.contexts[job.contextId].map.metersPerUnit)
      || job.epoch !== (value.partyEpochs[keyFor(job.sceneId, job.partyId)] || 0)) fail('Invalid durable exploration job');
  }
  return value;
}

export function applyExplorationDelta(previous, delta) {
  if (!delta) return previous;
  if (!object(delta) || delta.schemaVersion !== 1) fail('Unknown exploration delta');
  if (delta.replace) return validateExploration(clone(delta.replace));
  previous ||= emptyExploration();
  const next = { ...previous, partyEpochs: { ...previous.partyEpochs, ...(delta.partyEpochs || {}) },
    worldEpoch: delta.worldEpoch || previous.worldEpoch, contexts: { ...previous.contexts }, jobs: { ...previous.jobs } };
  for (const id of delta.removeJobs || []) delete next.jobs[id];
  for (const [id, job] of Object.entries(delta.jobs || {})) next.jobs[id] = clone(job);
  for (const id of delta.removeContexts || []) delete next.contexts[id];
  for (const [id, context] of Object.entries(delta.contexts || {})) next.contexts[id] = clone(context);
  return validateExploration(next);
}

export function explorationDelta(before, after) {
  if (before.worldEpoch !== after.worldEpoch) return { schemaVersion: 1, replace: after };
  const delta = { schemaVersion: 1, worldEpoch: after.worldEpoch, partyEpochs: {}, contexts: {}, jobs: {}, removeContexts: [], removeJobs: [] };
  for (const key of Object.keys(after.partyEpochs)) if (before.partyEpochs[key] !== after.partyEpochs[key]) delta.partyEpochs[key] = after.partyEpochs[key];
  for (const [id, value] of Object.entries(after.contexts)) if (!own(before.contexts, id)) delta.contexts[id] = value;
  for (const [id, value] of Object.entries(after.jobs)) if (before.jobs[id] !== value) delta.jobs[id] = value;
  delta.removeJobs = Object.keys(before.jobs).filter(id => !own(after.jobs, id));
  delta.removeContexts = Object.keys(before.contexts).filter(id => !own(after.contexts, id));
  return delta;
}

export function explorationSampleCount(path, metersPerUnit = 1) {
  if (path.length === 1) return 1;
  return path.slice(1).reduce((total, point, index) => total + Math.max(1, Math.ceil(
    Math.hypot(point.x - path[index].x, point.y - path[index].y) * metersPerUnit / 2.5)) + 1, 0);
}

export function enqueueExploration(previous, context, input) {
  const contextId = createHash('sha256').update(JSON.stringify(context)).digest('hex');
  const next = { ...previous, contexts: { ...previous.contexts, [contextId]: context }, jobs: { ...previous.jobs } };
  if (own(next.jobs, input.id)) return previous;
  const path = input.path.map(point => ({ x: Number(point.x), y: Number(point.y), elevationMeters: Number(point.elevationMeters) || 0 }));
  if (path.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.elevationMeters))) fail('Exploration path must be finite');
  next.jobs[input.id] = { ...input, path, contextId, worldEpoch: previous.worldEpoch,
    ordinal: Number.isSafeInteger(input.ordinal) ? input.ordinal : Number(String(input.id).split(':').at(-1)) || 0,
    epoch: previous.partyEpochs[keyFor(input.sceneId, input.partyId)] || 0, cursor: 0,
    totalSamples: explorationSampleCount(path, context.map.metersPerUnit || 1) };
  return validateExploration(next);
}

function collectContexts(value) {
  const used = new Set(Object.values(value.jobs).map(job => job.contextId));
  return { ...value, contexts: Object.fromEntries(Object.entries(value.contexts).filter(([id]) => used.has(id))) };
}

export function invalidateExploration(previous, sceneId, partyId = null) {
  const next = { ...previous, partyEpochs: { ...previous.partyEpochs }, jobs: { ...previous.jobs } };
  const parties = new Set(partyId == null ? Object.values(previous.jobs)
    .filter(job => job.sceneId === String(sceneId)).map(job => job.partyId) : [String(partyId)]);
  for (const party of parties) {
    const key = keyFor(sceneId, party);
    next.partyEpochs[key] = (previous.partyEpochs[key] || 0) + 1;
  }
  for (const [id, job] of Object.entries(next.jobs)) if (job.sceneId === String(sceneId)
    && (partyId == null || job.partyId === String(partyId))) delete next.jobs[id];
  return collectContexts(next);
}

export function finishExplorationChunk(previous, result) {
  const job = previous.jobs[result.id];
  if (!job || result.worldEpoch !== job.worldEpoch || result.epoch !== job.epoch || result.fromCursor !== job.cursor) return null;
  if (!Number.isSafeInteger(result.cursor) || result.cursor <= job.cursor || result.cursor > job.totalSamples) fail('Invalid exploration progress');
  const next = { ...previous, jobs: { ...previous.jobs } };
  if (result.cursor === job.totalSamples) delete next.jobs[job.id];
  else next.jobs[job.id] = { ...job, cursor: result.cursor };
  return collectContexts(next);
}

export function selectExplorationJob(value, previousLane = null) {
  const firstByLane = new Map();
  for (const job of Object.values(value.jobs).sort((a, b) => a.createdRevision - b.createdRevision
    || (a.ordinal || 0) - (b.ordinal || 0) || a.id.localeCompare(b.id))) {
    const lane = JSON.stringify([job.sceneId, job.partyId, job.tokenId]);
    if (!firstByLane.has(lane)) firstByLane.set(lane, job);
  }
  const lanes = [...firstByLane.keys()].sort();
  if (!lanes.length) return null;
  const index = lanes.indexOf(previousLane);
  const lane = lanes[(index + 1) % lanes.length];
  return { lane, job: firstByLane.get(lane) };
}
