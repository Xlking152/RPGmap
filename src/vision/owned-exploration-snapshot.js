import { isImmutableVisionData } from './immutable-data.js';

const ownedJobs = new WeakSet(), snapshots = new WeakSet();

export function isOrdinaryExplorationJobs(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}

// Only the local queue's already detached data reaches this helper. Collect
// first so unusual containers retain their complete existing clone path.
function freezeOwnedExplorationData(value) {
  const visiting = new WeakSet(), complete = new WeakSet(), nodes = [];
  function inspect(current) {
    if (current === null || !['object', 'function'].includes(typeof current))
      return !['function', 'symbol', 'bigint'].includes(typeof current);
    if (typeof current !== 'object') return false;
    if ((Object.isFrozen(current) && isImmutableVisionData(current)) || complete.has(current)) return true;
    if (visiting.has(current) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(current))) return false;
    visiting.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !inspect(descriptor.value)) return false;
    }
    visiting.delete(current); complete.add(current); nodes.push(current);
    return true;
  }
  if (!inspect(value)) return false;
  for (const node of nodes) Object.freeze(node);
  return isImmutableVisionData(value);
}

export function ownedExplorationSnapshot(state) {
  // Each job is frozen once, then memoized by the immutable-data proof.
  // The mutable queue containers never escape to the persistence controller.
  if (state.schemaVersion !== 1 || Object.keys(state).length !== 2
    || !Object.hasOwn(state, 'schemaVersion') || !Object.hasOwn(state, 'jobs')
    || !isOrdinaryExplorationJobs(state.jobs)) return null;
  const jobs = [];
  for (let index = 0; index < state.jobs.length; index++) {
    const job = Object.getOwnPropertyDescriptor(state.jobs, String(index)).value;
    if (!ownedJobs.has(job)) return null;
    jobs[index] = job;
  }
  Object.freeze(jobs);
  // Build from the proven values, without running a customizable array
  // iterator or copying an unproven metadata value. Preserve JSON key order.
  const snapshot = Object.freeze(Object.keys(state)[0] === 'jobs'
    ? { jobs, schemaVersion: 1 } : { schemaVersion: 1, jobs });
  if (!isImmutableVisionData(snapshot)) return null;
  snapshots.add(snapshot);
  return snapshot;
}

export function prepareOwnedExplorationJob(job) {
  // Retain the original native clone rejection boundary. Only this owned,
  // non-Proxy clone can acquire a sharing receipt; mutable classes and cycles
  // continue through the old setter on every metadata save.
  const owned = structuredClone(job);
  if (owned && typeof owned === 'object' && freezeOwnedExplorationData(owned)) ownedJobs.add(owned);
  return owned;
}

export function isOwnedExplorationSnapshot(value) {
  return snapshots.has(value) && isImmutableVisionData(value);
}
