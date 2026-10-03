import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { applyExplorationDelta } from './exploration-queue.mjs';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function stableRecord(record) {
  const value = {
    baseRevision: Number(record.baseRevision),
    revision: Number(record.revision),
    operationId: String(record.operationId || ''),
    patch: record.patch,
    results: Array.isArray(record.results) ? record.results : [],
    timestamp: String(record.timestamp || ''),
  };
  if (record.walVersion === 2) return JSON.stringify({ walVersion: 2, ...value, explorationDelta: record.explorationDelta });
  if (record.walVersion !== undefined) fail('Unknown World WAL version');
  return JSON.stringify(value);
}

function checksum(record) {
  return createHash('sha256').update(stableRecord(record)).digest('hex');
}

function fail(message, code = 'world_wal_corrupt') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function createWorldWal({ filePath, applyPatch, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!filePath || typeof applyPatch !== 'function') throw new Error('World WAL requires filePath and applyPatch');
  let bytes = 0;
  let lastCompactedAt = Date.now();

  async function replay(snapshot, { repairTail = true } = {}) {
    let source;
    try { source = await readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return snapshot;
      throw error;
    }
    bytes = Buffer.byteLength(source);
    let complete = source;
    if (source && !source.endsWith('\n')) {
      const boundary = source.lastIndexOf('\n');
      complete = boundary >= 0 ? source.slice(0, boundary + 1) : '';
    }
    let current = structuredClone(snapshot);
    const lines = complete.split(/\r?\n/).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      let record;
      try { record = JSON.parse(lines[index]); }
      catch { fail(`World WAL line ${index + 1} is invalid JSON`); }
      if (record.checksum !== checksum(record)) fail(`World WAL line ${index + 1} checksum mismatch`);
      const recordRevision = Number(record.revision);
      const baseRevision = Number(record.baseRevision);
      if (!Number.isSafeInteger(recordRevision) || !Number.isSafeInteger(baseRevision) || recordRevision !== baseRevision + 1) {
        fail(`World WAL line ${index + 1} has an invalid revision`);
      }
      if (recordRevision <= Number(current.revision || 0)) continue;
      if (baseRevision !== Number(current.revision || 0)) fail(`World WAL line ${index + 1} is not contiguous`);
      const state = applyPatch(current.state, record.patch);
      current = {
        ...current,
        revision: recordRevision,
        updatedAt: record.timestamp || current.updatedAt,
        state,
        ...(record.walVersion === 2 ? { exploration: applyExplorationDelta(current.exploration, record.explorationDelta) } : {}),
        recentStatusOperations: Array.isArray(record.results) ? record.results : current.recentStatusOperations,
      };
    }
    // Validate all complete records before touching a torn tail. Upgrade reads
    // stay read-only so the checkpoint can preserve the original WAL bytes.
    if (repairTail && source !== complete) {
      const handle = await open(filePath, 'r+');
      try { await handle.truncate(Buffer.byteLength(complete)); await handle.sync(); }
      finally { await handle.close(); }
      bytes = Buffer.byteLength(complete);
    }
    return current;
  }

  async function append({ baseRevision, revision, operationId, patch, results = [], timestamp = new Date().toISOString(), explorationDelta } = {}, { returnRecord = true } = {}) {
    const record = { baseRevision, revision, operationId, patch, results, timestamp };
    if (explorationDelta) Object.assign(record, { walVersion: 2, explorationDelta });
    record.checksum = checksum(record);
    const line = `${JSON.stringify(record)}\n`;
    const handle = await open(filePath, 'a');
    try {
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    bytes += Buffer.byteLength(line);
    return returnRecord ? structuredClone(record) : undefined;
  }

  function shouldCompact(revision, { revisionInterval = 100, timeIntervalMs = 60_000 } = {}) {
    return Number(revision) > 0 && (
      Number(revision) % revisionInterval === 0
      || Date.now() - lastCompactedAt >= timeIntervalMs
      || bytes >= maxBytes
    );
  }

  async function reset() {
    const handle = await open(filePath, 'r+').catch(error => {
      if (error?.code !== 'ENOENT') throw error;
      return open(filePath, 'w+');
    });
    try { await handle.truncate(0); await handle.sync(); }
    finally { await handle.close(); }
    adoptCheckpoint();
  }

  function adoptCheckpoint() {
    bytes = 0;
    lastCompactedAt = Date.now();
  }

  async function size() {
    try { return (await stat(filePath)).size; }
    catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  }

  return Object.freeze({ append, replay, reset, adoptCheckpoint, shouldCompact, size });
}

export { checksum as worldWalChecksum };
