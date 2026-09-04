import { createHash } from 'node:crypto';
import { open, readFile, stat, truncate } from 'node:fs/promises';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function stableRecord(record) {
  return JSON.stringify({
    baseRevision: Number(record.baseRevision),
    revision: Number(record.revision),
    operationId: String(record.operationId || ''),
    patch: record.patch,
    results: Array.isArray(record.results) ? record.results : [],
    timestamp: String(record.timestamp || ''),
  });
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

  async function replay(snapshot) {
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
      await truncate(filePath, Buffer.byteLength(complete));
      bytes = Buffer.byteLength(complete);
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
        recentStatusOperations: Array.isArray(record.results) ? record.results : current.recentStatusOperations,
      };
    }
    return current;
  }

  async function append({ baseRevision, revision, operationId, patch, results = [], timestamp = new Date().toISOString() } = {}) {
    const record = { baseRevision, revision, operationId, patch, results, timestamp };
    record.checksum = checksum(record);
    const line = `${JSON.stringify(record)}\n`;
    const handle = await open(filePath, 'a');
    try {
      await handle.write(line, null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    bytes += Buffer.byteLength(line);
    return structuredClone(record);
  }

  function shouldCompact(revision, { revisionInterval = 100, timeIntervalMs = 60_000 } = {}) {
    return Number(revision) > 0 && (
      Number(revision) % revisionInterval === 0
      || Date.now() - lastCompactedAt >= timeIntervalMs
      || bytes >= maxBytes
    );
  }

  async function reset() {
    await truncate(filePath, 0).catch(async error => {
      if (error?.code !== 'ENOENT') throw error;
      const handle = await open(filePath, 'a');
      await handle.close();
    });
    bytes = 0;
    lastCompactedAt = Date.now();
  }

  async function size() {
    try { return (await stat(filePath)).size; }
    catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  }

  return Object.freeze({ append, replay, reset, shouldCompact, size });
}

export { checksum as worldWalChecksum };
