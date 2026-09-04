import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, rename, copyFile, readdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { canPermission } from './permissions-model.mjs';
import {
  ACCESS_SCHEMA_VERSION,
  OWNERSHIP,
  actorCatalogFromWorld,
  claimUser,
  createAccessState,
  createBoundUser,
  createClaimableUser,
  hashCredential,
  normalizeAccessState,
  normalizeOwnership,
  publicUser,
  resetUserClaim,
  updateUserRecord,
  validatePlayerWorldPush,
  verifyUserCredential,
} from './access-control.mjs';
import { createPortableStorage, ensurePortableStorage, migrateLegacyStorage } from './portable-storage.mjs';
import { assertSafeJson, assertWorldState, isSameChat } from './world-schema.mjs';
import {
  STATUS_OPERATION_CACHE_LIMIT,
  STATUS_SCHEMA_VERSION,
  applyStatusMessage,
  assertStatusOperationId,
} from './status-operations.mjs';
import {
  applyWorldOperations,
  applyWorldOperationPatch,
  assertDocumentBatchMessage,
  assertWorldOperationMessage,
  createDocumentChanges,
  createWorldOperationPatch,
  documentWritesToWorldOperations,
  migrateLegacySceneFeatureStates,
  migrateWorldSchema3State,
  projectWorldOperationState,
  WORLD_OPERATION_SCHEMA_VERSION,
} from './world-operations.mjs';
import { resolveStatusCapabilitiesForToken } from './status-capabilities-v2.mjs';
import {
  canUserControlToken,
  describeVisionForToken,
  projectStateForAudience,
  serverRuleset,
} from './ruleset-authority.mjs';
import {
  networkUrls as listNetworkUrls,
  safePublicPath as resolvePublicPath,
  sendJson,
  servePublicFile,
} from './http-runtime.mjs';
import {
  attachFrameReader as attachWebSocketReader,
  closeSocket as closeWebSocket,
  hasSameOrigin as requestHasSameOrigin,
  sendSocket as sendWebSocket,
  websocketAccept,
} from './websocket-runtime.mjs';
import { createWorldWal } from './world-wal.mjs';
import { validateAuthoritativeTokenMovePath } from './movement-authority.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 30000);
const WORLD_ID = String(process.env.RPGMAP_WORLD_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
const STORAGE = createPortableStorage({ root: ROOT, worldId: WORLD_ID, env: process.env });
const PUBLIC_DIR = STORAGE.appDir;
const MAP_DIR = STORAGE.mapDir;
const WORLD_FILE = STORAGE.worldFile;
const WORLD_OPERATIONS_FILE = STORAGE.operationsFile;
const ACCESS_FILE = STORAGE.usersFile;
const PLAYER_JOIN_CODE = String(process.env.RPGMAP_JOIN_CODE || '').trim();
const GM_SECRET = String(process.env.RPGMAP_GM_SECRET || randomBytes(4).toString('hex').toUpperCase());
const MAX_WS_PAYLOAD = 8 * 1024 * 1024;
const BACKUP_RETENTION = 10;
const TEST_ALLOW_MISSING_ORIGIN = process.env.NODE_ENV === 'test' && process.env.RPGMAP_TEST_ALLOW_MISSING_ORIGIN === '1';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);

async function ensureRuntimeDirs() {
  await ensurePortableStorage(STORAGE);
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function safePublicPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); }
  catch { return null; }
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(PUBLIC_DIR, relative || 'index.html');
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + path.sep)) return null;
  return candidate;
}

async function serveFile(req, res, filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw Object.assign(new Error('not file'), { code: 'ENOENT' });
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME.get(ext) || 'application/octet-stream',
    'Content-Length': info.size,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

function networkUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function sanitizeName(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return text || 'Player';
}

function wsAccept(key) {
  return createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function hasSameOrigin(req) {
  const host = String(req.headers.host || '').trim();
  const origin = String(req.headers.origin || '').trim();
  if (!origin && TEST_ALLOW_MISSING_ORIGIN) return true;
  if (!host || !origin) return false;
  // The server only serves HTTP Local/LAN URLs.  A browser cannot forge Origin,
  // so matching it to the WebSocket target blocks hostile web pages on loopback.
  return origin === `http://${host}`;
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

function sendSocket(socket, message) {
  return sendWebSocket(socket, message);
}

function closeSocket(socket, code = 1000, reason = '') {
  return closeWebSocket(socket, code, reason);
}

function attachFrameReader(socket, onText, onClose) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentedOpcode = null;
  let fragmentBytes = 0;

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (first & 0x70) return closeSocket(socket, 1002, 'extensions unsupported');
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_PAYLOAD)) return closeSocket(socket, 1009, 'payload too large');
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_WS_PAYLOAD) return closeSocket(socket, 1009, 'payload too large');
      if (opcode >= 0x8 && length > 125) return closeSocket(socket, 1002, 'control frame too large');
      if (!masked) return closeSocket(socket, 1002, 'client frames must be masked');
      if (buffer.length < offset + 4 + length) return;

      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode === 0x8) return closeSocket(socket, 1000, 'bye');
      if (opcode === 0x9) {
        try { socket.write(encodeFrame(payload, 0xA)); } catch {}
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x1 && !fin) {
        if (fragmentedOpcode !== null) return closeSocket(socket, 1002, 'nested fragments');
        fragmentedOpcode = opcode;
        fragments = [payload];
        fragmentBytes = payload.length;
        continue;
      }
      if (opcode === 0x0 && fragmentedOpcode !== null) {
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_WS_PAYLOAD) return closeSocket(socket, 1009, 'payload too large');
        fragments.push(payload);
        if (!fin) continue;
        const combined = Buffer.concat(fragments);
        fragments = [];
        fragmentedOpcode = null;
        fragmentBytes = 0;
        onText(combined.toString('utf8'));
        continue;
      }
      if (opcode === 0x0) return closeSocket(socket, 1002, 'unexpected continuation');
      if (fragmentedOpcode !== null) return closeSocket(socket, 1002, 'fragment sequence incomplete');
      if (opcode !== 0x1) return closeSocket(socket, 1003, 'text only');
      onText(payload.toString('utf8'));
    }
  });
  socket.on('close', onClose);
  socket.on('end', onClose);
  socket.on('error', onClose);
}

await ensureRuntimeDirs();
const legacyMigrations = await migrateLegacyStorage(STORAGE);
async function quarantineCorruptFile(filePath, label, error) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(STORAGE.backupsDir, `${label}.corrupt.${stamp}.json`);
  try {
    await rename(filePath, target);
  } catch (moveError) {
    throw new Error(`${label} 损坏且无法隔离（${moveError.message}）。原文件未被覆盖。`);
  }
  throw new Error(`${label} 损坏，已隔离到 ${target}。请检查或恢复备份后重启。（${error.message}）`);
}

async function loadRequiredJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    return quarantineCorruptFile(filePath, label, error);
  }
}

async function pruneBackups(label) {
  const entries = await readdir(STORAGE.backupsDir, { withFileTypes: true });
  const backups = entries.filter(entry => entry.isFile() && entry.name.startsWith(`${label}.backup.`))
    .sort((left, right) => right.name.localeCompare(left.name));
  await Promise.all(backups.slice(BACKUP_RETENTION).map(entry => rm(path.join(STORAGE.backupsDir, entry.name), { force: true })));
}

async function renameAtomicWithRetry(source, target, attempts = 6) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function writeJsonWithBackup(filePath, label, value, { backup = true, serialized = null } = {}) {
  const snapshot = typeof serialized === 'string' ? serialized : JSON.stringify(value, null, 2);
  if (backup) {
    try {
      await stat(filePath);
      const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
      await copyFile(filePath, path.join(STORAGE.backupsDir, `${label}.backup.${stamp}.json`));
      await pruneBackups(label);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, snapshot, 'utf8');
    await renameAtomicWithRetry(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

let version = { app: 'RPGmap', version: 'unknown', serverMode: 'multiplayer' };
try { version = JSON.parse(await readFile(path.join(STORAGE.packageRoot, 'VERSION.json'), 'utf8')); }
catch {
  try { version = JSON.parse(await readFile(path.join(ROOT, 'VERSION.json'), 'utf8')); } catch {}
}
const packageVersion = version.version || version.packageVersion || 'unknown';

let world = {
  schemaVersion: 1,
  worldId: WORLD_ID,
  revision: 0,
  updatedAt: null,
  state: null,
  recentStatusOperations: [],
};
const loadedWorld = await loadRequiredJson(WORLD_FILE, 'world');
if (loadedWorld !== undefined) {
  if (!loadedWorld || typeof loadedWorld !== 'object' || Array.isArray(loadedWorld)) await quarantineCorruptFile(WORLD_FILE, 'world', new Error('root must be an object'));
  if (loadedWorld.state !== null && loadedWorld.state !== undefined) {
    try {
      const featureMigration = migrateLegacySceneFeatureStates(loadedWorld.state);
      const schemaMigration = migrateWorldSchema3State(featureMigration.state, {
        statusDefinitions: serverRuleset.statuses?.definitions,
      });
      assertWorldState(schemaMigration.state);
      loadedWorld.state = schemaMigration.state;
      if (featureMigration.migrated || schemaMigration.migrated) {
        await writeJsonWithBackup(WORLD_FILE, 'world', loadedWorld);
      }
    } catch (error) {
      if (error?.code === 'feature_state_migration_conflict') throw error;
      await quarantineCorruptFile(WORLD_FILE, 'world', error);
    }
  }
  world = {
    schemaVersion: 1,
    worldId: WORLD_ID,
    revision: Math.max(0, Number(loadedWorld.revision) || 0),
    updatedAt: loadedWorld.updatedAt || null,
    state: loadedWorld.state || null,
    recentStatusOperations: Array.isArray(loadedWorld.recentStatusOperations)
      ? loadedWorld.recentStatusOperations.slice(-STATUS_OPERATION_CACHE_LIMIT).flatMap(record => {
        try {
          const operationId = assertStatusOperationId(record?.operationId);
          const revision = Math.max(0, Number(record?.revision) || 0);
          const results = Array.isArray(record?.results) ? structuredClone(record.results) : [];
          return [{ operationId, revision, results }];
        } catch { return []; }
      })
      : [],
  };
}

const worldWal = createWorldWal({
  filePath: WORLD_OPERATIONS_FILE,
  applyPatch: applyWorldOperationPatch,
});
world = await worldWal.replay(world);
if (world.state) assertWorldState(world.state);

// Idempotency is intentionally bounded. A reconnect can safely retry a recent
// GM status mutation without applying it twice, while unbounded client keys can
// never grow server memory for the lifetime of the process.
const completedStatusOperations = new Map();
for (const record of world.recentStatusOperations || []) {
  completedStatusOperations.set(record.operationId, {
    revision: record.revision,
    results: structuredClone(record.results),
  });
}
function rememberStatusOperation(operationId, revision, results) {
  completedStatusOperations.set(operationId, { revision, results: structuredClone(results) });
  while (completedStatusOperations.size > STATUS_OPERATION_CACHE_LIMIT) {
    completedStatusOperations.delete(completedStatusOperations.keys().next().value);
  }
}

function recentStatusOperationsWith(operationId, revision, results) {
  const records = (world.recentStatusOperations || [])
    .filter(record => record.operationId !== operationId);
  records.push({ operationId, revision, results: structuredClone(results) });
  return records.slice(-STATUS_OPERATION_CACHE_LIMIT);
}

function statusOperationIdForReply(value) {
  if (typeof value !== 'string') return null;
  const result = value.trim().slice(0, 160);
  return result || null;
}

let access = createAccessState();
const loadedAccess = await loadRequiredJson(ACCESS_FILE, 'users');
if (loadedAccess !== undefined) {
  if (!loadedAccess || typeof loadedAccess !== 'object' || Array.isArray(loadedAccess) || !Array.isArray(loadedAccess.users)) {
    await quarantineCorruptFile(ACCESS_FILE, 'users', new Error('users must be an array'));
  }
  access = normalizeAccessState(loadedAccess);
}

let persistChain = Promise.resolve();
let lastWorldBackupRevision = Number(world.revision) || 0;
let lastWorldBackupAt = Date.now();
function persistWorld(snapshot, { forceBackup = false } = {}) {
  const state = snapshot.state ? {
    ...snapshot.state,
    preferences: { ...(snapshot.state.preferences || {}) },
  } : snapshot.state;
  if (state?.preferences) {
    delete state.preferences.featureStates;
    delete state.preferences.featureInteractions;
  }
  const durable = {
    ...snapshot,
    state,
  };
  const serialized = JSON.stringify(durable);
  if (Buffer.byteLength(serialized) > MAX_WS_PAYLOAD) {
    const error = new Error('World state is too large');
    error.code = 'state_too_large';
    return Promise.reject(error);
  }
  const revision = Number(snapshot.revision) || 0;
  const backup = forceBackup
    || revision - lastWorldBackupRevision >= 25
    || Date.now() - lastWorldBackupAt >= 60_000;
  const task = persistChain.catch(() => {}).then(() => writeJsonWithBackup(
    WORLD_FILE,
    'world',
    durable,
    { backup, serialized },
  ));
  persistChain = task;
  return task.then(value => {
    if (backup) {
      lastWorldBackupRevision = revision;
      lastWorldBackupAt = Date.now();
    }
    return value;
  });
}

let accessPersistChain = Promise.resolve();
let lastPersistedAccess = structuredClone(access);
function persistAccess(snapshot = access) {
  // Access handlers mutate small in-memory records before awaiting this write.
  // If the atomic disk write fails, restore the last durable record before the
  // serialized message queue accepts another request.
  const rollback = structuredClone(lastPersistedAccess);
  if (snapshot === access) snapshot.revision = Math.max(0, Number(snapshot.revision) || 0) + 1;
  const task = accessPersistChain.then(() => writeJsonWithBackup(ACCESS_FILE, 'users', snapshot));
  accessPersistChain = task.catch(() => {});
  return task.then(() => {
    lastPersistedAccess = structuredClone(snapshot);
  }, error => {
    if (snapshot === access) access = rollback;
    throw error;
  });
}

const sessions = new Map();
const resumeHistory = [];
const RESUME_HISTORY_LIMIT = 256;
const RESUME_HISTORY_MAX_AGE_MS = 5 * 60_000;
let resumeBaseRevision = Number(world.revision) || 0;
let resumeBaseState = world.state ? structuredClone(world.state) : null;
function audienceFingerprint(session) {
  return createHash('sha256').update(JSON.stringify({
    role: session.role,
    userId: session.userId || null,
    identityStatus: session.identityStatus,
    visionSourceTokenId: session.visionSourceTokenId || null,
    accessRevision: Math.max(0, Number(access.revision) || 0),
  })).digest('hex').slice(0, 24);
}
function advanceResumeBase(entry) {
  if (!resumeBaseState || Number(entry.baseRevision) !== resumeBaseRevision) {
    resumeBaseState = null;
    resumeBaseRevision = Number(entry.revision);
    return;
  }
  resumeBaseState = applyWorldOperationPatch(resumeBaseState, entry.patch);
  resumeBaseRevision = Number(entry.revision);
}
function resetResumeHistory() {
  resumeHistory.length = 0;
  resumeBaseRevision = Number(world.revision) || 0;
  resumeBaseState = world.state ? structuredClone(world.state) : null;
}
function rememberResumeCommit({
  beforeState, afterState, operationId, baseRevision, revision, updatedAt,
  results, originSessionId, changeSet, documentBatch,
}) {
  const now = Date.now();
  if (!resumeHistory.length) {
    resumeBaseRevision = Number(baseRevision);
    resumeBaseState = structuredClone(beforeState);
  }
  resumeHistory.push({
    baseRevision: Number(baseRevision),
    revision: Number(revision),
    at: now,
    patch: createWorldOperationPatch(beforeState, afterState),
    operationId: String(operationId),
    updatedAt: String(updatedAt),
    results: structuredClone(results || []),
    originSessionId: originSessionId || null,
    changeSet: structuredClone(changeSet || {}),
    documentBatch: documentBatch === true,
  });
  while (resumeHistory.length > RESUME_HISTORY_LIMIT
    || (resumeHistory[0] && now - resumeHistory[0].at > RESUME_HISTORY_MAX_AGE_MS)) {
    advanceResumeBase(resumeHistory.shift());
  }
}
function resumableCommits(session, revision, fingerprint) {
  const requested = Number(revision);
  const currentFingerprint = audienceFingerprint(session);
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > world.revision
    || String(fingerprint || '') !== currentFingerprint) return null;
  if (requested === world.revision) return [];
  if (!resumeBaseState || requested < resumeBaseRevision) return null;
  let canonical = structuredClone(resumeBaseState);
  let expected = resumeBaseRevision;
  let beforeProjection = null;
  const result = [];
  for (const entry of resumeHistory) {
    if (entry.baseRevision !== expected || entry.revision !== expected + 1) return null;
    const nextCanonical = applyWorldOperationPatch(canonical, entry.patch);
    if (entry.revision <= requested) {
      canonical = nextCanonical;
      expected = entry.revision;
      continue;
    }
    if (expected !== requested && !beforeProjection) return null;
    beforeProjection ||= audienceStateFor(session, canonical);
    const afterProjection = audienceStateFor(session, nextCanonical);
    const patch = createWorldOperationPatch(beforeProjection, afterProjection);
    const motion = projectMotionForSession(entry.results, beforeProjection, afterProjection);
    result.push({
      type: entry.documentBatch ? 'document.batch.committed' : 'world.operation.committed',
      operationId: entry.operationId,
      baseRevision: entry.baseRevision,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
      patch,
      changeSet: audienceChangeSetFromPatch(patch, afterProjection, entry.changeSet),
      ...(entry.documentBatch ? {
        changes: createDocumentChanges(beforeProjection, afterProjection, patch, { motion }),
        motion,
      } : {}),
      results: projectResultsForSession(entry.results, afterProjection, session),
      originSessionId: entry.originSessionId,
      audienceRevision: session.audienceRevision,
    });
    beforeProjection = afterProjection;
    canonical = nextCanonical;
    expected = entry.revision;
    if (expected === world.revision) return result;
  }
  return null;
}
function findUser(userId) { return access.users.find(user => user.id === String(userId || '')) || null; }
function socketForSessionId(sessionId) {
  for (const [socket, session] of sessions) if (session.id === sessionId) return socket;
  return null;
}
function onlineForUser(userId) {
  for (const session of sessions.values()) if (session.userId === userId && session.identityStatus === 'active') return true;
  return false;
}
function uniqueUserName(value, excludeId = null) {
  const base = sanitizeName(value);
  const existing = new Set(access.users.filter(user => user.id !== excludeId).map(user => user.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  let index = 2;
  while (existing.has(`${base} ${index}`.toLowerCase())) index += 1;
  return `${base} ${index}`.slice(0, 40);
}
function cleanOwnershipForWorld(raw, defaultActorId = null) {
  const known = new Set(actorCatalogFromWorld(world.state).map(actor => actor.id));
  const ownership = normalizeOwnership(raw);
  for (const actorId of Object.keys(ownership)) if (!known.has(actorId)) delete ownership[actorId];
  const defaultId = defaultActorId && known.has(String(defaultActorId)) ? String(defaultActorId) : null;
  if (defaultId) ownership[defaultId] = OWNERSHIP.OWNER;
  return { ownership, defaultActorId: defaultId };
}
function publicSession(session) {
  const user = session.userId ? findUser(session.userId) : null;
  return {
    id: session.id,
    userId: session.userId || null,
    name: user?.name || session.name,
    role: session.role,
    identityStatus: session.identityStatus,
    defaultActorId: user?.defaultActorId || null,
    connectedAt: session.connectedAt,
  };
}
function presencePayload() {
  return { type: 'presence', clients: [...sessions.values()].map(publicSession) };
}
function broadcast(message, exceptSocket = null, predicate = null) {
  for (const [socket, session] of sessions) {
    if (socket === exceptSocket) continue;
    if (predicate && !predicate(session)) continue;
    sendSocket(socket, message);
  }
}
function broadcastPresence() { broadcast(presencePayload()); }
function broadcastWorld(message, exceptSocket = null) {
  for (const [socket, session] of sessions) {
    if (socket === exceptSocket || (session.role !== 'gm' && session.identityStatus !== 'active')) continue;
    const projected = message.state === undefined ? message : {
      ...message,
      state: audienceStateFor(session, message.state),
      audienceRevision: session.audienceRevision,
    };
    sendSocket(socket, projected);
  }
}
function audienceStateFor(session, state = world.state) {
  if (!state) return null;
  if (session.role === 'gm' && !session.visionSourceTokenId) {
    assertWorldState(state);
    return state;
  }
  if (!session.audienceOpaqueIds) session.audienceOpaqueIds = new Map();
  const opaqueIdFor = (kind, rawId) => {
    const key = `${String(kind)}:${String(rawId)}`;
    if (!session.audienceOpaqueIds.has(key)) {
      const opaque = createHash('sha256').update([
        GM_SECRET, WORLD_ID, session.role, session.userId || '', session.visionSourceTokenId || '', key,
      ].join('|')).digest('base64url').slice(0, 24);
      session.audienceOpaqueIds.set(key, `audience-${String(kind)}-${opaque}`);
    }
    return session.audienceOpaqueIds.get(key);
  };
  const projected = projectStateForAudience(state, {
    role: session.role,
    userId: session.userId,
    user: session.userId ? findUser(session.userId) : null,
    visionSourceTokenId: session.visionSourceTokenId,
    ruleset: serverRuleset,
    mapMetrics: { metersPerUnit: 1 },
    opaqueIdFor,
  });
  assertWorldState(projected);
  return projected;
}
function sendWorldOperationDenied(socket, message, code, description, extra = {}) {
  const documentBatch = message?.type === 'document.batch' || message?._documentBatch === true;
  return sendSocket(socket, {
    type: documentBatch ? 'document.batch.denied' : 'world.operation.denied',
    operationId: statusOperationIdForReply(message?.operationId),
    code: String(code || 'world_operation_denied'),
    message: String(description || '服务器拒绝了 World 操作'),
    revision: world.revision,
    updatedAt: world.updatedAt,
    ...extra,
  });
}
function visibleResultIds(state) {
  const worldValue = state?.preferences?.worldV2;
  return {
    actors: new Set((worldValue?.actors || []).map(item => String(item?.id ?? ''))),
    tokens: new Set((worldValue?.scenes || []).flatMap(scene => (scene.tokens || []).map(item => String(item?.id ?? '')))),
    markers: new Set((worldValue?.scenes || []).flatMap(scene => (scene.markers || []).map(item => String(item?.id ?? '')))),
  };
}
function projectResultsForSession(results, projectedState, session) {
  if (session.role === 'gm') return structuredClone(results || []);
  const visible = visibleResultIds(projectedState);
  return (results || []).filter(result => {
    if (result?.tokenId && !visible.tokens.has(String(result.tokenId))) return false;
    if (result?.actorId && !visible.actors.has(String(result.actorId))) return false;
    if (result?.markerId && !visible.markers.has(String(result.markerId))) return false;
    return true;
  }).map(result => structuredClone(result));
}
function audienceChangeSetFromPatch(patch, afterProjection, canonical = {}) {
  const worldPatch = patch?.world || {};
  const scenes = worldPatch.scenes || {};
  const ids = values => (values || []).map(value => String(value?.id ?? value));
  const dirtyFog = new Map((canonical.fog || []).map(entry => [String(entry.sceneId), entry.dirtyBounds ?? null]));
  const visibleChatIds = new Set((afterProjection?.preferences?.chatSystem?.messages || []).map(message => String(message?.id || '')));
  return {
    actors: {
      upsertIds: ids(worldPatch.actors?.upsert),
      removeIds: ids(worldPatch.actors?.remove),
    },
    tokens: (scenes.tokens || []).map(entry => ({
      sceneId: String(entry.sceneId),
      upsertIds: ids(entry.upsert),
      removeIds: ids(entry.remove),
    })),
    scenes: {
      upsertIds: ids(scenes.upsert),
      removeIds: ids(scenes.remove),
      activeSceneChanged: worldPatch.activeSceneId !== undefined,
    },
    featureStates: (scenes.featureStates || []).map(entry => ({
      sceneId: String(entry.sceneId),
      featureIds: [...ids(entry.upsert), ...ids(entry.remove)],
    })),
    fog: (scenes.fog || []).map(entry => ({
      sceneId: String(entry.sceneId),
      dirtyBounds: dirtyFog.get(String(entry.sceneId)) ?? null,
    })),
    combatChanged: patch?.combatSystem !== undefined,
    chat: {
      appendedIds: (canonical.chat?.appendedIds || []).map(String).filter(id => visibleChatIds.has(id)),
      cleared: Boolean(canonical.chat?.cleared && patch?.chatSystem !== undefined),
    },
    statusDefinitionsChanged: worldPatch.statusDefinitions !== undefined,
  };
}
function visiblePreciseToken(state, tokenId) {
  const worldValue = state?.preferences?.worldV2;
  for (const scene of worldValue?.scenes || []) {
    const token = (scene.tokens || []).find(item => String(item?.id ?? '') === String(tokenId));
    if (token) return token.audienceVisibility !== 'vague';
  }
  return false;
}

async function persistWorldCommit(snapshot, beforeState, operationId) {
  const patch = createWorldOperationPatch(beforeState, snapshot.state);
  await worldWal.append({
    baseRevision: Number(snapshot.revision) - 1,
    revision: Number(snapshot.revision),
    operationId,
    patch,
    results: snapshot.recentStatusOperations || [],
    timestamp: snapshot.updatedAt,
  });
  if (worldWal.shouldCompact(snapshot.revision)) {
    await persistWorld(snapshot);
    await worldWal.reset();
  }
}
function projectMotionForSession(results, beforeProjection, afterProjection) {
  return (results || []).flatMap(result => result?.motion || []).filter(motion =>
    visiblePreciseToken(beforeProjection, motion.tokenId) && visiblePreciseToken(afterProjection, motion.tokenId))
    .map(motion => structuredClone(motion));
}

function lightweightProjectionShell(state) {
  const preferences = { ...(state?.preferences || {}) };
  const worldState = preferences.worldV2 || {};
  preferences.worldV2 = {
    ...worldState,
    actors: [...(worldState.actors || [])],
    scenes: [...(worldState.scenes || [])],
  };
  preferences.entitySystem = { ...(preferences.entitySystem || {}) };
  return { ...state, preferences };
}

function canonicalWorldScene(state, sceneId) {
  return (state?.preferences?.worldV2?.scenes || [])
    .find(scene => String(scene?.id || '') === String(sceneId || '')) || null;
}

function tryIncrementalAudienceProjection(session, beforeProjection, afterState, operations, results) {
  if (!beforeProjection || session.role === 'gm' || !Array.isArray(operations) || !operations.length) return null;
  const types = new Set(operations.map(operation => String(operation?.type || '')));
  const next = lightweightProjectionShell(beforeProjection);
  const projectedWorld = next.preferences.worldV2;
  projectedWorld.updatedAt = String(afterState?.preferences?.worldV2?.updatedAt || projectedWorld.updatedAt || '');

  if ([...types].every(type => type === 'chat.append')) {
    const chatIds = new Set((results || []).map(result => String(result?.chatId || '')).filter(Boolean));
    const appended = (afterState?.preferences?.chatSystem?.messages || [])
      .filter(message => chatIds.has(String(message?.id || '')));
    // Player chat has no entity-bearing data. Protected GM event data still
    // uses the full projection so hidden Actor/Token references are filtered.
    if (appended.length !== chatIds.size || appended.some(message => message?.data != null)) return null;
    next.preferences.chatSystem = {
      ...(beforeProjection.preferences?.chatSystem || {}),
      messages: [
        ...(beforeProjection.preferences?.chatSystem?.messages || []),
        ...appended.map(message => structuredClone(message)),
      ],
    };
    return next;
  }

  if ([...types].every(type => type === 'token.movePath') && !session.visionSourceTokenId) {
    const motion = (results || []).flatMap(result => result?.motion || []);
    const motionById = new Map(motion.map(item => [String(item?.tokenId || ''), item]));
    for (const [sceneIndex, scene] of projectedWorld.scenes.entries()) {
      const canonical = canonicalWorldScene(afterState, scene.id);
      if (!canonical) return null;
      let changed = false;
      const tokens = (scene.tokens || []).map(token => {
        if (!motionById.has(String(token?.id || ''))) return token;
        const authoritative = (canonical.tokens || []).find(item => String(item?.id || '') === String(token.id));
        if (!authoritative) return token;
        changed = true;
        return {
          ...token,
          placement: authoritative.placement,
          x: authoritative.x,
          y: authoritative.y,
          featureId: authoritative.featureId,
        };
      });
      if (!changed) continue;
      const attackAreas = (scene.attackAreas || []).map(area => {
        const item = motionById.get(String(area?.anchor?.tokenId || ''));
        return item ? { ...area, origin: structuredClone(item.to) } : area;
      });
      projectedWorld.scenes[sceneIndex] = { ...scene, tokens, attackAreas };
      if (String(projectedWorld.activeSceneId || '') === String(scene.id)) {
        next.preferences.entitySystem = { ...next.preferences.entitySystem, tokens: [...tokens] };
        next.attackAreas = [...attackAreas];
      }
    }
    return next;
  }

  if ([...types].every(type => type.startsWith('status.')) && !types.has('status.definition.upsert')
    && !types.has('status.definition.delete') && !types.has('status.definition.import')) {
    const actorIds = new Set();
    const tokenIds = new Set();
    for (const operation of operations) {
      const payload = operation.payload || {};
      const scope = String(payload.scope || payload.target?.scope || '');
      const targetId = String(payload.targetId || payload.target?.targetId || '');
      if (scope === 'actor' && targetId) actorIds.add(targetId);
      else if (['token', 'syntheticActor'].includes(scope) && targetId) tokenIds.add(targetId);
      else return null;
    }
    const canonicalWorld = afterState?.preferences?.worldV2;
    for (const actorId of actorIds) {
      if (session.visionSourceTokenId) {
        const source = canonicalWorldScene(afterState, canonicalWorld?.activeSceneId)?.tokens
          ?.find(token => String(token?.id || '') === String(session.visionSourceTokenId));
        if (String(source?.actorId || '') === actorId) return null;
      }
      const index = projectedWorld.actors.findIndex(actor => String(actor?.id || '') === actorId);
      const current = projectedWorld.actors[index];
      const authoritative = (canonicalWorld?.actors || []).find(actor => String(actor?.id || '') === actorId);
      if (index < 0 || current?.audienceRestricted === true || !authoritative) return null;
      projectedWorld.actors[index] = structuredClone(authoritative);
    }
    for (const tokenId of tokenIds) {
      if (String(session.visionSourceTokenId || '') === tokenId) return null;
      let found = false;
      for (const [sceneIndex, scene] of projectedWorld.scenes.entries()) {
        const index = (scene.tokens || []).findIndex(token => String(token?.id || '') === tokenId);
        if (index < 0) continue;
        const current = scene.tokens[index];
        const authoritative = canonicalWorldScene(afterState, scene.id)?.tokens
          ?.find(token => String(token?.id || '') === tokenId);
        if (current?.audienceRestricted === true || !authoritative) return null;
        const tokens = [...scene.tokens];
        tokens[index] = structuredClone(authoritative);
        projectedWorld.scenes[sceneIndex] = { ...scene, tokens };
        if (String(projectedWorld.activeSceneId || '') === String(scene.id)) {
          next.preferences.entitySystem = { ...next.preferences.entitySystem, tokens: [...tokens] };
        }
        found = true;
        break;
      }
      if (!found) return null;
    }
    if (actorIds.size) {
      next.preferences.entitySystem = {
        ...next.preferences.entitySystem,
        actors: [...projectedWorld.actors],
      };
    }
    return next;
  }
  return null;
}

function targetedAudiencePatch(beforeProjection, afterProjection, operations, results) {
  const types = new Set((operations || []).map(operation => String(operation?.type || '')));
  const worldPatch = {
    updatedAt: String(afterProjection?.preferences?.worldV2?.updatedAt || new Date().toISOString()),
  };
  const patch = { schemaVersion: WORLD_OPERATION_SCHEMA_VERSION, world: worldPatch };
  if ([...types].every(type => type === 'chat.append')) {
    const ids = new Set((results || []).map(result => String(result?.chatId || '')).filter(Boolean));
    patch.chatAppend = (afterProjection?.preferences?.chatSystem?.messages || [])
      .filter(message => ids.has(String(message?.id || '')))
      .map(message => structuredClone(message));
    return patch;
  }
  if ([...types].every(type => type === 'token.movePath')) {
    const tokenIds = new Set((results || []).flatMap(result => result?.motion || [])
      .map(motion => String(motion?.tokenId || '')).filter(Boolean));
    const beforeScenes = new Map((beforeProjection?.preferences?.worldV2?.scenes || [])
      .map(scene => [String(scene?.id || ''), scene]));
    const tokens = [];
    for (const scene of afterProjection?.preferences?.worldV2?.scenes || []) {
      const previousIds = new Set((beforeScenes.get(String(scene.id))?.tokens || [])
        .map(token => String(token?.id || '')));
      const upsert = (scene.tokens || []).filter(token => tokenIds.has(String(token?.id || '')))
        .map(token => structuredClone(token));
      const afterIds = new Set((scene.tokens || []).map(token => String(token?.id || '')));
      const remove = [...tokenIds].filter(id => previousIds.has(id) && !afterIds.has(id));
      if (upsert.length || remove.length) tokens.push({ sceneId: String(scene.id), upsert, remove });
    }
    if (tokens.length) worldPatch.scenes = { upsert: [], remove: [], tokens, content: [], featureStates: [], fog: [] };
    return patch;
  }
  if ([...types].every(type => type.startsWith('status.'))) {
    const actorIds = new Set();
    const tokenIds = new Set();
    for (const operation of operations || []) {
      const payload = operation.payload || {};
      const scope = String(payload.scope || payload.target?.scope || '');
      const targetId = String(payload.targetId || payload.target?.targetId || '');
      if (scope === 'actor' && targetId) actorIds.add(targetId);
      else if (targetId) tokenIds.add(targetId);
    }
    const actors = (afterProjection?.preferences?.worldV2?.actors || [])
      .filter(actor => actorIds.has(String(actor?.id || ''))).map(actor => structuredClone(actor));
    if (actors.length) worldPatch.actors = { upsert: actors, remove: [] };
    const tokens = [];
    for (const scene of afterProjection?.preferences?.worldV2?.scenes || []) {
      const upsert = (scene.tokens || []).filter(token => tokenIds.has(String(token?.id || '')))
        .map(token => structuredClone(token));
      if (upsert.length) tokens.push({ sceneId: String(scene.id), upsert, remove: [] });
    }
    if (tokens.length) worldPatch.scenes = { upsert: [], remove: [], tokens, content: [], featureStates: [], fog: [] };
    return patch;
  }
  return null;
}

function broadcastOperationCommit({ beforeState, afterState, operationId, baseRevision, revision, updatedAt, results, originSessionId, changeSet, operations = [], documentBatch = false }) {
  for (const [socket, session] of sessions) {
    if (session.role !== 'gm' && session.identityStatus !== 'active') continue;
    const beforeProjection = session.audienceProjection || audienceStateFor(session, beforeState);
    const incrementalProjection = tryIncrementalAudienceProjection(
      session, beforeProjection, afterState, operations, results,
    );
    const afterProjection = incrementalProjection || audienceStateFor(session, afterState);
    session.audienceProjection = afterProjection;
    const patch = (incrementalProjection
      ? targetedAudiencePatch(beforeProjection, afterProjection, operations, results)
      : null) || createWorldOperationPatch(beforeProjection, afterProjection);
    const motion = documentBatch
      ? projectMotionForSession(results, beforeProjection, afterProjection)
      : [];
    const response = {
      type: documentBatch ? 'document.batch.committed' : 'world.operation.committed', operationId, baseRevision, revision, updatedAt,
      patch,
      changeSet: audienceChangeSetFromPatch(patch, afterProjection, changeSet),
      ...(documentBatch ? {
        changes: createDocumentChanges(beforeProjection, afterProjection, patch, { motion }),
        motion,
      } : {}),
      results: projectResultsForSession(results, afterProjection, session),
      originSessionId,
      audienceRevision: session.audienceRevision,
    };
    sendSocket(socket, response);
  }
  rememberResumeCommit({
    beforeState, afterState, operationId, baseRevision, revision, updatedAt,
    results, originSessionId, changeSet, documentBatch,
  });
}
function sendAudienceSnapshot(socket, session, reason = 'audience.changed') {
  session.audienceRevision += 1;
  const state = audienceStateFor(session);
  session.audienceProjection = state;
  return sendSocket(socket, {
    type: 'audience.snapshot',
    audienceRevision: session.audienceRevision,
    revision: world.revision,
    updatedAt: world.updatedAt,
    state,
    reason,
    audienceFingerprint: audienceFingerprint(session),
  });
}
function sessionPermissions(session) {
  if (session.role === 'gm') {
    return { worldWrite: true, worldReset: true, manageAccess: true, combatManage: true, actorOwnerIds: ['*'], actorObserverIds: ['*'], actorLimitedIds: ['*'], defaultActorId: null, placementGrants: { actorTypes: ['*'], actorIds: ['*'], markerKinds: ['*'] } };
  }
  const user = session.userId ? findUser(session.userId) : null;
  const ownerIds = user ? Object.entries(user.ownership).filter(([, level]) => level === OWNERSHIP.OWNER).map(([id]) => id) : [];
  const observerIds = user ? Object.entries(user.ownership).filter(([, level]) => level === OWNERSHIP.OBSERVER || level === OWNERSHIP.OWNER).map(([id]) => id) : [];
  const limitedIds = user ? Object.entries(user.ownership).filter(([, level]) => [OWNERSHIP.LIMITED, OWNERSHIP.OBSERVER, OWNERSHIP.OWNER].includes(level)).map(([id]) => id) : [];
  return {
    worldWrite: Boolean(user && !user.disabled && session.identityStatus === 'active'),
    worldReset: false,
    manageAccess: false,
    combatManage: false,
    actorOwnerIds: ownerIds,
    actorObserverIds: observerIds,
    actorLimitedIds: limitedIds,
    defaultActorId: user?.defaultActorId || null,
    placementGrants: user?.placementGrants || { actorTypes: [], actorIds: [], markerKinds: [] },
  };
}
function canonicalRecord(tokenId) {
  const worldValue = world.state?.preferences?.worldV2;
  const scene = worldValue?.scenes?.find(item => String(item?.id ?? '') === String(worldValue?.activeSceneId ?? ''));
  const token = scene?.tokens?.find(item => String(item?.id ?? '') === String(tokenId));
  const actor = token && worldValue?.actors?.find(item => String(item?.id ?? '') === String(token.actorId));
  return { world: worldValue, scene, token, actor };
}
function canonicalScene(sceneId) {
  const worldValue = world.state?.preferences?.worldV2;
  return worldValue?.scenes?.find(item => String(item?.id ?? '') === String(sceneId ?? '')) || null;
}
function sessionControlsToken(session, tokenId) {
  const user = session.userId ? findUser(session.userId) : null;
  const { token, actor } = canonicalRecord(tokenId);
  return canPermission('token.control', {
    role: session.role,
    userId: session.userId,
    token,
    actor,
    actorAccess: user?.ownership?.[String(actor?.id || '')] || 'none',
  });
}
function operationDenied(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function authorizeOperations(session, operations) {
  if (operations.some(operation => operation.type === 'scene.fog.explore')) {
    operationDenied('fog_explore_server_only', 'Fog exploration is derived from the authoritative vision source');
  }
  if (session.role === 'gm') return operations;
  const user = findUser(session.userId);
  const grants = user?.placementGrants || { actorTypes: [], actorIds: [], markerKinds: [] };
  const userPartyId = (() => {
    const actors = world.state?.preferences?.worldV2?.actors || [];
    const preferred = actors.find(actor => String(actor.id) === String(user?.defaultActorId || ''));
    if (['pc', 'summon'].includes(String(preferred?.type || '')) && preferred?.partyId) return String(preferred.partyId);
    return String(actors.find(actor => ['pc', 'summon'].includes(String(actor?.type || ''))
      && user?.ownership?.[String(actor.id)] === OWNERSHIP.OWNER && actor.partyId)?.partyId || '') || null;
  })();
  const playerRuntimeTypes = new Set([
    'health.set-mode', 'health.runtime', 'health.damage', 'health.healing',
    'variant.set', 'variant.cycle', 'resource.set-current', 'resource.step',
    'resource.set-max', 'resource.add-custom', 'resource.remove-custom',
    'attribute.set-adjustment', 'bad-status.set-current',
  ]);
  const authorizeStatusTarget = target => {
    const scope = String(target?.scope || '');
    const targetId = String(target?.targetId || target?.id || '');
    if ((scope === 'token' || scope === 'syntheticActor') && sessionControlsToken(session, targetId)) return;
    if (scope === 'actor') {
      const actor = world.state?.preferences?.worldV2?.actors?.find(item => String(item?.id ?? '') === targetId);
      if (actor?.type === 'pc' && user?.ownership?.[targetId] === OWNERSHIP.OWNER) return;
    }
    operationDenied('status_target_not_controlled', 'Status target is not controlled by this Player');
  };
  const authorizeMovedToken = tokenId => {
    if (!tokenId) operationDenied('token_target_required', 'Player Token movement requires tokenId');
    if (!sessionControlsToken(session, tokenId)) operationDenied('token_not_controlled', 'Token is not controlled by this Player');
    const capability = resolveStatusCapabilitiesForToken(world.state, tokenId);
    if (capability.canMove === false) operationDenied('status_movement_forbidden', capability.reasons?.[0] || 'Current status prevents movement');
    const combat = world.state?.preferences?.combatSystem?.combat;
    if (combat?.state === 'active' && Array.isArray(combat.combatants) && combat.combatants.length) {
      const current = combat.combatants[Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0))];
      if (String(current?.tokenId || '') !== String(tokenId)) operationDenied('combat_turn_locked', 'Only the active Combat Token may act');
    }
  };
  return operations.map(operation => {
    const value = structuredClone(operation);
    const payload = value.payload || {};
    if (value.type === 'token.move') {
      const tokenId = String(payload.tokenId || '');
      authorizeMovedToken(tokenId);
      return value;
    }
    if (value.type === 'token.movePath') {
      const tokenIds = [...new Set((Array.isArray(payload.tokenIds) ? payload.tokenIds : []).map(String).filter(Boolean))];
      if (!tokenIds.length || tokenIds.length > 64 || !tokenIds.includes(String(payload.tokenId || ''))) {
        operationDenied('token_target_required', 'Token path movement requires 1-64 controlled Tokens including the leader');
      }
      tokenIds.forEach(authorizeMovedToken);
      return value;
    }
    if (value.type === 'actor.runtime.perform') {
      const runtimeType = String(payload.operation?.type || '');
      if (!playerRuntimeTypes.has(runtimeType)) operationDenied('actor_runtime_operation_forbidden', 'This Actor runtime operation is restricted to the GM');
      const tokenId = String(payload.tokenId || '');
      const actorId = String(payload.actorId || '');
      if (tokenId) {
        if (!sessionControlsToken(session, tokenId)) operationDenied('token_not_controlled', 'Token is not controlled by this Player');
        const combat = world.state?.preferences?.combatSystem?.combat;
        if (combat?.state === 'active' && Array.isArray(combat.combatants) && combat.combatants.length) {
          const current = combat.combatants[Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0))];
          if (String(current?.tokenId || '') !== tokenId) operationDenied('combat_turn_locked', 'Only the active Combat Token may act');
        }
        return value;
      }
      const actor = world.state?.preferences?.worldV2?.actors?.find(item => String(item?.id ?? '') === actorId);
      if (!actorId || actor?.type !== 'pc' || user?.ownership?.[actorId] !== OWNERSHIP.OWNER) {
        operationDenied(['monster', 'npc', 'summon'].includes(String(actor?.type)) ? 'instance_target_required' : 'actor_not_owned', 'Player runtime operations require an owned PC or controlled Token instance');
      }
      return value;
    }
    if (value.type === 'token.create') {
      if (String(payload.sceneId || '') !== String(world.state?.preferences?.worldV2?.activeSceneId || '')) {
        operationDenied('scene_not_active', 'Players may place Tokens only in the active Scene');
      }
      if (!payload.token || typeof payload.token !== 'object' || Array.isArray(payload.token)) {
        operationDenied('invalid_token_payload', 'token.create requires a Token object');
      }
      const actorId = String(payload.token.actorId || '');
      const actor = world.state?.preferences?.worldV2?.actors?.find(item => String(item?.id ?? '') === actorId);
      if (!actor || (!grants.actorIds?.includes(actorId) && !grants.actorTypes?.includes(String(actor.type)))) {
        operationDenied('token_placement_forbidden', 'Actor template placement is not granted');
      }
      if (['monster', 'npc', 'summon'].includes(String(actor.type))) {
        payload.token.actorLink = false;
        delete payload.token.actorDelta;
      }
      payload.token.controllerUserIds = [session.userId];
      payload.token.visibility = {
        mode: actor.type === 'pc' ? (actor.partyId ? 'party' : 'public')
          : actor.type === 'summon' && actor.partyId ? 'party' : 'users',
        userIds: actor.type === 'pc' || (actor.type === 'summon' && actor.partyId) ? [] : [session.userId],
      };
      payload.token.vision = {
        enabled: true,
        preciseRangeOverrideMeters: null,
        vagueRangeOverrideMeters: null,
        overrideUserIds: [],
      };
      return value;
    }
    if (value.type === 'marker.upsert') {
      if (String(payload.sceneId || '') !== String(world.state?.preferences?.worldV2?.activeSceneId || '')) {
        operationDenied('scene_not_active', 'Players may place Markers only in the active Scene');
      }
      const kind = String(payload.marker?.kind || 'note');
      if (!grants.markerKinds?.includes(kind)) operationDenied('marker_placement_forbidden', 'Marker placement is not granted');
      const scene = canonicalScene(payload.sceneId);
      if (scene?.markers?.some(item => String(item?.id ?? '') === String(payload.marker?.id || ''))) {
        operationDenied('marker_exists', 'Players cannot replace an existing Marker');
      }
      payload.marker.controllerUserIds = [session.userId];
      const requestedVisibility = String(payload.marker.visibility?.mode || 'public');
      const mode = kind === 'trap' ? 'users' : requestedVisibility === 'party' && userPartyId ? 'party' : 'public';
      payload.marker.visibility = { mode, userIds: mode === 'users' ? [session.userId] : [] };
      payload.marker.partyId = mode === 'party' ? userPartyId : null;
      return value;
    }
    if (value.type === 'marker.move' || value.type === 'marker.delete') {
      if (String(payload.sceneId || '') !== String(world.state?.preferences?.worldV2?.activeSceneId || '')) {
        operationDenied('scene_not_active', 'Players may modify Markers only in the active Scene');
      }
      const scene = canonicalScene(payload.sceneId);
      const marker = scene?.markers?.find(item => String(item?.id ?? '') === String(payload.markerId || ''));
      if (!marker?.controllerUserIds?.includes(session.userId)) operationDenied('marker_not_controlled', 'Marker is not controlled by this Player');
      return value;
    }
    if (value.type === 'token.access.patch') {
      const record = canonicalRecord(payload.tokenId);
      const keys = Object.keys(payload.patch || {});
      const visionOnly = keys.length === 1 && keys[0] === 'vision';
      if (!visionOnly || !record.token?.vision?.overrideUserIds?.includes(session.userId)) {
        operationDenied('token_access_gm_only', 'Only the GM can modify Token control or visibility');
      }
      const visionKeys = Object.keys(payload.patch.vision || {});
      if (visionKeys.some(key => !['preciseRangeOverrideMeters', 'vagueRangeOverrideMeters'].includes(key))) {
        operationDenied('vision_override_forbidden', 'Player may only modify the granted vision range override');
      }
      return value;
    }
    if (value.type === 'actor.upsert') {
      const actorId = String(payload.actor?.id || '');
      const current = world.state?.preferences?.worldV2?.actors?.find(item => String(item?.id ?? '') === actorId);
      if (!current || current.type !== 'pc' || user?.ownership?.[actorId] !== OWNERSHIP.OWNER) {
        operationDenied('actor_not_owned', 'Only an owned PC template may be edited');
      }
      if (payload.actor.type !== current.type || payload.actor.partyId !== current.partyId) {
        operationDenied('actor_classification_gm_only', 'Only the GM can change Actor classification or party');
      }
      if (JSON.stringify(payload.actor.publicProfile ?? null) !== JSON.stringify(current.publicProfile ?? null)) {
        operationDenied('actor_public_profile_gm_only', 'Only the GM can edit the public Actor profile');
      }
      return value;
    }
    if (value.type === 'chat.append') {
      const text = String(payload.text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 4_000);
      if (!text) operationDenied('invalid_chat', 'Chat text cannot be empty');
      if (payload.event !== undefined && String(payload.event) !== 'chat') {
        operationDenied('chat_type_forbidden', 'Players may submit ordinary chat text only');
      }
      if (payload.sender !== undefined || payload.id !== undefined || payload.createdAt !== undefined || payload.data !== undefined) {
        operationDenied('chat_payload_forbidden', 'Chat identity, timestamp, and protected data are server-owned');
      }
      value.payload = { text };
      return value;
    }
    if (value.type.startsWith('status.') && !value.type.startsWith('status.definition.')) {
      if (value.type === 'status.batch') {
        for (const item of Array.isArray(payload.operations) ? payload.operations : []) {
          authorizeStatusTarget(item?.target || item);
        }
      } else authorizeStatusTarget(payload.target || payload);
      return value;
    }
    operationDenied(`${value.type.replaceAll('.', '_')}_gm_only`, `Only the GM can perform ${value.type}`);
  });
}
function appendVisionExplorationOperations(operations) {
  const next = operations.map(operation => structuredClone(operation));
  const seen = new Set();
  for (const operation of operations) {
    if (!['token.move', 'token.movePath'].includes(operation.type) || operation.payload?.placement === 'feature') continue;
    const movedIds = operation.type === 'token.movePath'
      ? (operation.payload.tokenIds || []).map(String)
      : [String(operation.payload?.tokenId || '')];
    for (const tokenId of movedIds) for (const session of sessions.values()) {
        if (String(session.visionSourceTokenId || '') !== tokenId) continue;
        const vision = describeVisionForToken(world.state, tokenId);
        if (!vision?.partyId) continue;
        const key = `${vision.sceneId}:${vision.partyId}:${tokenId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const canonical = canonicalRecord(tokenId).token;
        const leader = canonicalRecord(operation.payload?.tokenId).token;
        const offset = operation.type === 'token.movePath' && canonical && leader
          ? { x: Number(canonical.x) - Number(leader.x), y: Number(canonical.y) - Number(leader.y) }
          : { x: 0, y: 0 };
        const route = operation.type === 'token.movePath'
          ? (operation.payload.waypoints || []).map(point => ({ x: Number(point.x) + offset.x, y: Number(point.y) + offset.y }))
          : [{ x: Number(operation.payload.x), y: Number(operation.payload.y) }];
        const to = route.at(-1);
        if (to) next.push({
          type: 'scene.fog.explore',
          payload: {
            sceneId: vision.sceneId,
            partyId: vision.partyId,
            from: { x: vision.x, y: vision.y },
            to,
            radiusMeters: vision.vagueRangeMeters,
          },
        });
      }
  }
  return next;
}
function accessSnapshotFor(session) {
  const gm = session.role === 'gm';
  const users = access.users.map(user => {
    const base = publicUser(user);
    base.online = onlineForUser(user.id);
    if (!gm && user.id !== session.userId) delete base.ownership;
    return base;
  });
  return {
    type: 'access.snapshot',
    revision: Math.max(0, Number(access.revision) || 0),
    canManage: gm,
    selfUserId: session.userId || null,
    users,
    pending: gm ? [...sessions.values()].filter(item => item.role === 'player' && item.identityStatus === 'pending').map(publicSession) : [],
    actors: actorCatalogFromWorld(audienceStateFor(session)),
  };
}
function sendAccessSnapshot(socket) {
  const session = sessions.get(socket);
  if (session) sendSocket(socket, accessSnapshotFor(session));
}
function broadcastAccessSnapshots() {
  for (const socket of sessions.keys()) sendAccessSnapshot(socket);
}
function multiplayerInfo() {
  return {
    enabled: true,
    identityMode: 'user-ownership',
    storageMode: 'portable-map-root',
    worldId: WORLD_ID,
    revision: world.revision,
    clients: sessions.size,
    users: access.users.length,
    publicMode: false,
    publicUrl: null,
    joinCodeRequired: Boolean(PLAYER_JOIN_CODE),
    playerWriteEnabled: true,
    operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
    statusSchema: STATUS_SCHEMA_VERSION,
    accessSchema: ACCESS_SCHEMA_VERSION,
  };
}

function worldBootstrapInfo() {
  const rawWorld = world.state?.preferences?.worldV2;
  if (!world.state) return { initialized: false, kind: 'empty', schemaVersion: null, worldId: WORLD_ID, name: null, activeSceneId: null, mapPackage: null, ruleset: null };
  if (!rawWorld || typeof rawWorld !== 'object' || Array.isArray(rawWorld)) {
    return { initialized: true, kind: 'legacy', schemaVersion: null, worldId: WORLD_ID, name: null, activeSceneId: null, mapPackage: null, ruleset: null };
  }
  const scenes = Array.isArray(rawWorld.scenes) ? rawWorld.scenes : [];
  const activeScene = scenes.find(scene => String(scene?.id || '') === String(rawWorld.activeSceneId || '')) || scenes[0] || null;
  return {
    initialized: true,
    kind: 'world-v2',
    schemaVersion: Number(rawWorld.schemaVersion) || null,
    worldId: String(rawWorld.id || WORLD_ID),
    name: String(rawWorld.name || ''),
    activeSceneId: activeScene?.id ? String(activeScene.id) : null,
    mapPackage: activeScene?.mapPackage?.id ? {
      id: String(activeScene.mapPackage.id),
      version: String(activeScene.mapPackage.version || ''),
    } : null,
    ruleset: {
      id: String(rawWorld.ruleset?.id || ''),
      version: String(rawWorld.ruleset?.version || ''),
    },
  };
}
function sendWelcome(socket, session, { includeWorld = true, pendingApproval = false } = {}) {
  const fingerprint = audienceFingerprint(session);
  const resumed = includeWorld
    ? resumableCommits(session, session.resumeRevision, session.resumeAudienceFingerprint)
    : null;
  const resumeAccepted = Array.isArray(resumed);
  const projectedState = includeWorld && !resumeAccepted ? audienceStateFor(session) : null;
  session.audienceProjection = projectedState ? structuredClone(projectedState) : null;
  sendSocket(socket, {
    type: 'welcome',
    operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
    statusSchema: STATUS_SCHEMA_VERSION,
    accessSchema: ACCESS_SCHEMA_VERSION,
    session: publicSession(session),
    identity: { status: session.identityStatus, user: session.userId ? publicUser(findUser(session.userId)) : null, pendingApproval },
    world: { revision: world.revision, updatedAt: world.updatedAt, state: projectedState },
    resumeAccepted,
    audienceFingerprint: fingerprint,
    audienceRevision: session.audienceRevision,
    permissions: sessionPermissions(session),
    server: multiplayerInfo(),
  });
  sendAccessSnapshot(socket);
  if (resumeAccepted) {
    for (const response of resumed) sendSocket(socket, response);
    sendSocket(socket, {
      type: 'resume.complete',
      revision: world.revision,
      audienceRevision: session.audienceRevision,
      audienceFingerprint: fingerprint,
    });
  }
}
function refreshOnlineUser(userId) {
  const user = findUser(userId);
  for (const [socket, session] of sessions) {
    if (session.userId !== userId) continue;
    if (!user || user.disabled) {
      sendSocket(socket, { type: 'error', code: 'identity_disabled', message: '该 Player 身份已被 GM 禁用或删除' });
      closeSocket(socket, 1008, 'identity disabled');
      continue;
    }
    session.name = user.name;
    sendSocket(socket, { type: 'permissions.update', user: publicUser(user), permissions: sessionPermissions(session) });
    sendAudienceSnapshot(socket, session, 'access.permissions.updated');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) return sendJson(res, 405, { error: 'method_not_allowed' });
    if (req.url === '/api/health') return sendJson(res, 200, {
      status: 'ok', app: version.app || 'RPGmap', version: packageVersion,
      operationSchema: WORLD_OPERATION_SCHEMA_VERSION, statusSchema: STATUS_SCHEMA_VERSION,
      accessSchema: ACCESS_SCHEMA_VERSION,
      mode: version.serverMode || 'multiplayer', multiplayer: multiplayerInfo(), world: worldBootstrapInfo(),
    });
    if (req.url === '/api/version') return sendJson(res, 200, version);
    if (req.url === '/api/multiplayer') return sendJson(res, 200, multiplayerInfo());

    const candidate = resolvePublicPath(PUBLIC_DIR, req.url || '/');
    if (!candidate) return sendJson(res, 400, { error: 'bad_path' });
    try {
      await servePublicFile(req, res, candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      await servePublicFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
  } catch (error) {
    console.error('[RPGmap] request failed:', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_server_error' });
    else res.end();
  }
});

// Serialize messages across sockets, not only per connection. This guarantees
// every World mutation clones the latest durable revision before it writes.
let messageChain = Promise.resolve();
server.on('upgrade', (req, socket) => {
  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch {}
  if (pathname !== '/ws') return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();
  if (!requestHasSameOrigin(req, { allowMissingOrigin: TEST_ALLOW_MISSING_ORIGIN })) return socket.destroy();

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    '\r\n',
  ].join('\r\n'));

  let joined = false;
  let closed = false;
  const helloTimer = setTimeout(() => { if (!joined) closeSocket(socket, 1008, 'hello timeout'); }, 10000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(helloTimer);
    if (sessions.delete(socket)) {
      broadcastPresence();
      broadcastAccessSnapshots();
    }
  };

  attachWebSocketReader(socket, text => {
    messageChain = messageChain.then(async () => {
    let message;
    try { message = JSON.parse(text); }
    catch { return sendSocket(socket, { type: 'error', code: 'invalid_json', message: 'Invalid JSON' }); }
    try { assertSafeJson(message, 'message'); }
    catch (error) { return sendSocket(socket, { type: 'error', code: error.code || 'invalid_message', message: error.message }); }

    if (!joined) {
      if (message?.type !== 'hello') return closeSocket(socket, 1008, 'hello required');
      if (Number(message.operationSchema) !== WORLD_OPERATION_SCHEMA_VERSION) {
        sendSocket(socket, {
          type: 'error', code: 'operation_schema_incompatible',
          message: `Operation schema ${WORLD_OPERATION_SCHEMA_VERSION} is required`,
          operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
        });
        return closeSocket(socket, 1008, 'operation schema incompatible');
      }
      if (Number(message.statusSchema) !== STATUS_SCHEMA_VERSION) {
        sendSocket(socket, {
          type: 'error', code: 'status_schema_incompatible',
          message: `Status schema ${STATUS_SCHEMA_VERSION} is required`,
          statusSchema: STATUS_SCHEMA_VERSION,
        });
        return closeSocket(socket, 1008, 'status schema incompatible');
      }
      if (Number(message.accessSchema) !== ACCESS_SCHEMA_VERSION) {
        sendSocket(socket, {
          type: 'error', code: 'access_schema_incompatible',
          message: `Access schema ${ACCESS_SCHEMA_VERSION} is required`,
          accessSchema: ACCESS_SCHEMA_VERSION,
        });
        return closeSocket(socket, 1008, 'access schema incompatible');
      }
      const requestedRole = message.requestedRole === 'gm' ? 'gm' : 'player';
      const secretMatches = Boolean(message.gmSecret) && String(message.gmSecret) === GM_SECRET;
      const gmAuthorized = requestedRole === 'gm' && secretMatches;
      if (requestedRole === 'gm' && !gmAuthorized) {
        sendSocket(socket, { type: 'error', code: 'gm_secret_required', message: 'GM 必须提供正确的 GM Secret' });
        return closeSocket(socket, 1008, 'GM secret required');
      }
      if (PLAYER_JOIN_CODE && !gmAuthorized && String(message.joinCode || '') !== PLAYER_JOIN_CODE) {
        sendSocket(socket, { type: 'error', code: 'invalid_join_code', message: '房间码错误' });
        return closeSocket(socket, 1008, 'invalid join code');
      }

      let session;
      let boundToken = null;
      if (gmAuthorized) {
        session = { id: randomUUID(), userId: null, name: sanitizeName(message.name || 'GM'), role: 'gm', identityStatus: 'active', connectedAt: new Date().toISOString() };
      } else {
        const userId = String(message.userId || '').trim();
        const authToken = String(message.authToken || '');
        const claimCode = String(message.claimCode || '').trim().toUpperCase();
        if (userId || authToken) {
          const user = findUser(userId);
          if (!verifyUserCredential(user, authToken)) {
            sendSocket(socket, { type: 'error', code: 'identity_invalid', message: '保存的 Player 身份已失效，请清除身份后重新申请或使用认领码' });
            return closeSocket(socket, 1008, 'invalid identity');
          }
          session = { id: randomUUID(), userId: user.id, name: user.name, role: 'player', identityStatus: 'active', connectedAt: new Date().toISOString() };
        } else if (claimCode) {
          const claimHash = hashCredential(claimCode);
          const user = access.users.find(item => item.claimHash === claimHash && !item.disabled) || null;
          if (!user) {
            sendSocket(socket, { type: 'error', code: 'invalid_claim_code', message: '身份认领码无效或已被使用' });
            return closeSocket(socket, 1008, 'invalid claim code');
          }
          boundToken = claimUser(user, claimCode);
          await persistAccess();
          session = { id: randomUUID(), userId: user.id, name: user.name, role: 'player', identityStatus: 'active', connectedAt: new Date().toISOString() };
        } else {
          session = { id: randomUUID(), userId: null, name: sanitizeName(message.name), role: 'player', identityStatus: 'pending', connectedAt: new Date().toISOString() };
        }
      }

      session.visionSourceTokenId = null;
      session.audienceRevision = 0;
      session.resumeRevision = Number.isSafeInteger(Number(message.resumeRevision))
        ? Math.max(0, Number(message.resumeRevision))
        : null;
      session.resumeAudienceFingerprint = String(message.audienceFingerprint || '').slice(0, 80);
      const requestedVisionSource = String(message.visionSourceTokenId || '').trim();
      if (requestedVisionSource && world.state) {
        const user = session.userId ? findUser(session.userId) : null;
        if (session.role === 'gm' || canUserControlToken(world.state, requestedVisionSource, {
          user, userId: session.userId,
        })) session.visionSourceTokenId = requestedVisionSource;
      }
      sessions.set(socket, session);
      joined = true;
      clearTimeout(helloTimer);
      if (boundToken) sendSocket(socket, { type: 'identity.bound', userId: session.userId, authToken: boundToken });
      sendWelcome(socket, session, { includeWorld: session.role === 'gm' || session.identityStatus === 'active', pendingApproval: session.identityStatus === 'pending' });
      broadcastPresence();
      broadcastAccessSnapshots();
      return;
    }

    const session = sessions.get(socket);
    if (!session) return closeSocket(socket, 1008, 'session missing');

    if (message?.type === 'document.batch') {
      try {
        const documentEnvelope = assertDocumentBatchMessage(message);
        message = {
          type: 'world.operation',
          operationId: documentEnvelope.operationId,
          baseRevision: documentEnvelope.baseRevision,
          operations: documentWritesToWorldOperations(documentEnvelope.writes),
          _documentBatch: true,
        };
      } catch (error) {
        return sendWorldOperationDenied(socket, message, error?.code || 'invalid_document_operation', error?.message);
      }
    }

    if (message?.type === 'access.request') return sendAccessSnapshot(socket);

    if (message?.type === 'access.self.default') {
      if (session.role !== 'player' || session.identityStatus !== 'active') return sendSocket(socket, { type: 'error', code: 'identity_required', message: '需要正式 Player 身份' });
      const user = findUser(session.userId);
      const actorId = String(message.actorId || '').trim();
      if (actorId && user?.ownership?.[actorId] !== OWNERSHIP.OWNER) return sendSocket(socket, { type: 'error', code: 'actor_not_owned', message: '默认角色必须是你拥有 OWNER 权限的 Actor' });
      updateUserRecord(user, { defaultActorId: actorId || null });
      await persistAccess();
      refreshOnlineUser(user.id);
      broadcastPresence();
      broadcastAccessSnapshots();
      return;
    }

    if (message?.type === 'access.actor-ownership.update') {
      const operationId = String(message.operationId || '').trim().slice(0, 160);
      const deny = (code, detail) => sendSocket(socket, {
        type: 'access.actor-ownership.denied', operationId, code, message: detail,
        revision: Math.max(0, Number(access.revision) || 0),
      });
      if (session.role !== 'gm') return deny('gm_only', '只有 GM 可以管理 Actor 权限');
      if (!operationId) return deny('operation_id_required', '权限更新缺少 operationId');
      if (Number(message.baseRevision) !== Math.max(0, Number(access.revision) || 0)) {
        return deny('access_revision_conflict', '权限目录已变化，请刷新后重试');
      }
      const actorId = String(message.actorId || '').trim().slice(0, 160);
      const knownActors = new Set(actorCatalogFromWorld(world.state).map(actor => String(actor.id)));
      if (!actorId || !knownActors.has(actorId)) return deny('actor_not_found', 'Actor 不存在或权限目录尚未同步');
      const changes = Array.isArray(message.changes) ? message.changes : [];
      if (!changes.length || changes.length > 128) return deny('invalid_changes', '权限更新必须包含 1-128 项变化');
      const next = structuredClone(access);
      const changedUserIds = new Set();
      for (const change of changes) {
        const userId = String(change?.userId || '').trim();
        const level = String(change?.level || 'none').toLowerCase();
        const user = next.users.find(item => String(item.id) === userId);
        if (!user) return deny('user_not_found', `Player User ${userId || '(missing)'} 不存在`);
        if (!Object.values(OWNERSHIP).includes(level)) return deny('invalid_ownership', `无效 Actor 权限：${level}`);
        if (String(user.defaultActorId || '') === actorId && level !== OWNERSHIP.OWNER) {
          return deny('default_actor_owner_required', `${user.name} 的默认角色必须保持 OWNER`);
        }
        if (level === OWNERSHIP.NONE) delete user.ownership[actorId];
        else user.ownership[actorId] = level;
        user.updatedAt = new Date().toISOString();
        changedUserIds.add(userId);
      }
      next.revision = Math.max(0, Number(access.revision) || 0) + 1;
      await persistAccess(next);
      access = next;
      for (const userId of changedUserIds) refreshOnlineUser(userId);
      broadcastAccessSnapshots();
      sendSocket(socket, {
        type: 'access.actor-ownership.ack', operationId, actorId,
        revision: access.revision,
        results: changes.map(change => ({ userId: String(change.userId), level: String(change.level).toLowerCase() })),
      });
      return;
    }

    if (message?.type?.startsWith('access.user.')) {
      if (session.role !== 'gm') return sendSocket(socket, { type: 'error', code: 'gm_only', message: '只有 GM 可以管理 Player 身份与角色权限' });

      if (message.type === 'access.user.approve') {
        const pendingSocket = socketForSessionId(String(message.sessionId || ''));
        const pendingSession = pendingSocket ? sessions.get(pendingSocket) : null;
        if (!pendingSession || pendingSession.identityStatus !== 'pending') return sendSocket(socket, { type: 'error', code: 'pending_not_found', message: '待批准玩家已离线或不存在' });
        const cleaned = cleanOwnershipForWorld(message.ownership, message.defaultActorId);
        const created = createBoundUser({
          name: uniqueUserName(message.name || pendingSession.name),
          ...cleaned,
          placementGrants: message.placementGrants,
        });
        access.users.push(created.user);
        await persistAccess();
        pendingSession.userId = created.user.id;
        pendingSession.name = created.user.name;
        pendingSession.identityStatus = 'active';
        sendSocket(pendingSocket, { type: 'identity.bound', userId: created.user.id, authToken: created.authToken });
        sendWelcome(pendingSocket, pendingSession, { includeWorld: true });
        sendSocket(socket, { type: 'access.notice', message: `已批准 Player：${created.user.name}` });
        broadcastPresence();
        broadcastAccessSnapshots();
        return;
      }

      if (message.type === 'access.user.create') {
        const cleaned = cleanOwnershipForWorld(message.ownership, message.defaultActorId);
        const created = createClaimableUser({
          name: uniqueUserName(message.name || 'Player'),
          ...cleaned,
          placementGrants: message.placementGrants,
        });
        access.users.push(created.user);
        await persistAccess();
        sendSocket(socket, { type: 'access.claim', user: publicUser(created.user), claimCode: created.claimCode, message: '认领码只显示这一次，请发给对应玩家。' });
        broadcastAccessSnapshots();
        return;
      }

      if (message.type === 'access.user.update') {
        const user = findUser(message.userId);
        if (!user) return sendSocket(socket, { type: 'error', code: 'user_not_found', message: 'Player User 不存在' });
        const cleaned = cleanOwnershipForWorld(message.ownership ?? user.ownership, message.defaultActorId ?? user.defaultActorId);
        updateUserRecord(user, {
          name: uniqueUserName(message.name ?? user.name, user.id),
          ownership: cleaned.ownership,
          defaultActorId: cleaned.defaultActorId,
          placementGrants: message.placementGrants ?? user.placementGrants,
          disabled: message.disabled ?? user.disabled,
        });
        await persistAccess();
        refreshOnlineUser(user.id);
        broadcastPresence();
        broadcastAccessSnapshots();
        return;
      }

      if (message.type === 'access.user.reset-claim') {
        const user = findUser(message.userId);
        if (!user) return sendSocket(socket, { type: 'error', code: 'user_not_found', message: 'Player User 不存在' });
        const claimCode = resetUserClaim(user);
        await persistAccess();
        for (const [clientSocket, clientSession] of sessions) {
          if (clientSession.userId === user.id) {
            sendSocket(clientSocket, { type: 'error', code: 'identity_reissued', message: 'GM 已重新签发你的身份，请使用新的认领码重新登录' });
            closeSocket(clientSocket, 1008, 'identity reissued');
          }
        }
        sendSocket(socket, { type: 'access.claim', user: publicUser(user), claimCode, message: '新的认领码只显示这一次，旧浏览器身份已失效。' });
        broadcastAccessSnapshots();
        return;
      }

      if (message.type === 'access.user.delete') {
        const userId = String(message.userId || '');
        const index = access.users.findIndex(user => user.id === userId);
        if (index < 0) return sendSocket(socket, { type: 'error', code: 'user_not_found', message: 'Player User 不存在' });
        access.users.splice(index, 1);
        await persistAccess();
        refreshOnlineUser(userId);
        broadcastPresence();
        broadcastAccessSnapshots();
        return;
      }
    }

    if (message?.type === 'vision.source.set') {
      if (session.role !== 'gm' && session.identityStatus !== 'active') {
        return sendSocket(socket, { type: 'vision.source.denied', code: 'identity_required', message: 'Active identity required' });
      }
      const tokenId = message.tokenId == null ? '' : String(message.tokenId).trim();
      if (tokenId && !sessionControlsToken(session, tokenId)) {
        return sendSocket(socket, { type: 'vision.source.denied', code: 'vision_source_not_controlled', message: 'Vision source is not controlled by this user' });
      }
      const beforeState = world.state;
      session.visionSourceTokenId = tokenId || null;
      const vision = tokenId ? describeVisionForToken(world.state, tokenId) : null;
      if (vision?.partyId) {
        let applied;
        try {
          applied = applyWorldOperations(world.state, [{
            type: 'scene.fog.explore',
            payload: {
              sceneId: vision.sceneId, partyId: vision.partyId,
              x: vision.x, y: vision.y, radiusMeters: vision.vagueRangeMeters,
            },
          }], { ruleset: serverRuleset, now: new Date().toISOString(), mapMetrics: { metersPerUnit: 1 } });
          assertWorldState(applied.state);
        } catch (error) {
          session.visionSourceTokenId = null;
          return sendSocket(socket, { type: 'vision.source.denied', code: error.code || 'vision_source_invalid', message: error.message });
        }
        const nextWorld = {
          schemaVersion: 1, worldId: WORLD_ID, revision: world.revision + 1,
          updatedAt: new Date().toISOString(), state: applied.state,
          recentStatusOperations: world.recentStatusOperations || [],
        };
        const visionOperationId = `vision-${randomUUID()}`;
        try { await persistWorldCommit(nextWorld, beforeState, visionOperationId); }
        catch (error) {
          session.visionSourceTokenId = null;
          return sendSocket(socket, { type: 'vision.source.denied', code: 'persist_failed', message: error.message });
        }
        const baseRevision = world.revision;
        world = nextWorld;
        broadcastOperationCommit({
          beforeState, afterState: world.state, operationId: visionOperationId,
          baseRevision, revision: world.revision, updatedAt: world.updatedAt,
          results: applied.results, originSessionId: session.id,
        });
      }
      sendSocket(socket, {
        type: 'vision.source.ack', tokenId: session.visionSourceTokenId,
        revision: world.revision, audienceRevision: session.audienceRevision,
      });
      sendAudienceSnapshot(socket, session, 'vision.source.set');
      return;
    }

    if (message?.type === 'world.operation') {
      let envelope;
      try { envelope = assertWorldOperationMessage(message); }
      catch (error) {
        return sendWorldOperationDenied(socket, message, error?.code || 'invalid_world_operation', error?.message);
      }

      if (session.role !== 'gm' && session.identityStatus !== 'active') {
        return sendWorldOperationDenied(socket, message, 'identity_pending', '等待 GM 批准身份后才能操作 World');
      }

      if (session.role !== 'gm' && envelope.operations.some(operation => operation.type === 'scene.featureState.patch')) {
        return sendWorldOperationDenied(
          socket,
          message,
          'scene_feature_state_gm_only',
          'Only the GM can modify Scene Feature State',
        );
      }

      const completed = completedStatusOperations.get(envelope.operationId);
      if (completed) {
        return sendSocket(socket, {
          type: message._documentBatch === true ? 'document.batch.ack' : 'world.operation.ack',
          operationId: envelope.operationId,
          revision: world.revision,
          committedRevision: completed.revision,
          results: projectResultsForSession(completed.results, audienceStateFor(session), session),
          duplicate: true,
        });
      }

      if (!world.state) {
        return sendWorldOperationDenied(socket, message, 'world_uninitialized', 'World 尚未初始化，必须先由 GM 创建完整 World');
      }
      const safeMoveRebase = message._documentBatch === true
        && envelope.operations.every(operation => operation.type === 'token.movePath');
      if (envelope.baseRevision !== world.revision && !safeMoveRebase) {
        return sendWorldOperationDenied(socket, message, 'revision_conflict', 'World 已被其他操作更新，请先重新载入最新状态');
      }

      let applied;
      let committedOperations = [];
      try {
        const now = new Date().toISOString();
        const authorizedOperations = authorizeOperations(session, envelope.operations);
        const operations = appendVisionExplorationOperations(authorizedOperations);
        committedOperations = operations;
        applied = applyWorldOperations(world.state, operations, {
          now,
          ruleset: serverRuleset,
          mapMetrics: { metersPerUnit: 1 },
          userId: session.userId,
          sessionId: session.id,
          validateTokenMovePath({ state, scene, token, origin, waypoints }) {
            const capabilities = resolveStatusCapabilitiesForToken(state, token.id);
            return validateAuthoritativeTokenMovePath({
              state, scene, token, origin, waypoints, capabilities,
            });
          },
          applyStatus(state, statusMessage) {
            return applyStatusMessage(state, statusMessage, {
              now, mutate: true, assumeNormalized: true,
              userId: session.userId,
              sessionId: session.id,
            });
          },
          createChatMessage(input) {
            const typeByEvent = {
              chat: 'chat', system: 'system', combat: 'combat', damage: 'damage', healing: 'healing', roll: 'roll',
            };
            const event = String(input.event || 'chat');
            if (!typeByEvent[event] || (event !== 'chat' && session.role !== 'gm')) {
              operationDenied('chat_type_forbidden', 'Only the GM can submit protected chat events');
            }
            return {
              id: randomUUID(),
              type: typeByEvent[event],
              text: input.text,
              createdAt: now,
              sender: {
                id: session.userId || session.id,
                name: publicSession(session).name,
                role: session.role,
              },
              data: session.role === 'gm' && input.data && typeof input.data === 'object'
                ? structuredClone(input.data)
                : null,
            };
          },
        });
        assertWorldState(applied.state);
      } catch (error) {
        return sendWorldOperationDenied(socket, message, error?.code || 'invalid_world_operation', error?.message, {
          ...(Array.isArray(error?.conflictIds) ? { conflictIds: error.conflictIds.map(String) } : {}),
        });
      }

      const nextRevision = world.revision + 1;
      const nextWorld = {
        schemaVersion: 1,
        worldId: WORLD_ID,
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
        state: applied.state,
        recentStatusOperations: recentStatusOperationsWith(
          envelope.operationId,
          nextRevision,
          applied.results,
        ),
      };
      try { await persistWorldCommit(nextWorld, world.state, envelope.operationId); }
      catch (error) {
        const code = error?.code === 'state_too_large' ? error.code : 'persist_failed';
        const description = code === 'state_too_large' ? error.message : `World 操作未保存：${error.message}`;
        return sendWorldOperationDenied(socket, message, code, description);
      }

      const baseRevision = world.revision;
      const beforeState = world.state;
      world = nextWorld;
      rememberStatusOperation(envelope.operationId, world.revision, applied.results);
      broadcastOperationCommit({
        beforeState,
        afterState: world.state,
        operationId: envelope.operationId,
        baseRevision,
        revision: world.revision,
        updatedAt: world.updatedAt,
        results: applied.results,
        originSessionId: session.id,
        changeSet: applied.changeSet,
        operations: committedOperations,
        documentBatch: message._documentBatch === true,
      });
      const originProjection = session.audienceProjection || audienceStateFor(session);
      sendSocket(socket, {
        type: message._documentBatch === true ? 'document.batch.ack' : 'world.operation.ack',
        operationId: envelope.operationId,
        revision: world.revision,
        results: projectResultsForSession(applied.results, originProjection, session),
        duplicate: false,
      });
      if (envelope.operations.some(operation => operation.type === 'actor.upsert' || operation.type === 'actor.delete')) {
        broadcastAccessSnapshots();
      }
      return;
    }

    if (message?.type === 'world.push') {
      const worldOperationId = statusOperationIdForReply(message.operationId);
      if (session.role !== 'gm') {
        return sendSocket(socket, {
          type: 'world.denied', operationId: worldOperationId, code: 'world_push_gm_only',
          message: 'Full World replacement is restricted to the GM', revision: world.revision,
          updatedAt: world.updatedAt, state: audienceStateFor(session), audienceRevision: session.audienceRevision,
        });
      }
      const replacementReason = String(message.reason || '').trim();
      if (world.state && !/^(?:file-import:|backup-restore:|recovery:)/.test(replacementReason)) {
        return sendSocket(socket, {
          type: 'world.denied', operationId: worldOperationId, code: 'world_replace_explicit_only',
          message: 'Full World replacement requires an explicit import or recovery action', revision: world.revision,
          updatedAt: world.updatedAt, state: audienceStateFor(session), audienceRevision: session.audienceRevision,
        });
      }
      if (!message.state || typeof message.state !== 'object' || Array.isArray(message.state)) {
        return sendSocket(socket, { type: 'error', operationId: worldOperationId, code: 'invalid_state', message: 'World state must be an object' });
      }
      let incomingState;
      try {
        incomingState = migrateWorldSchema3State(migrateLegacySceneFeatureStates(message.state).state, {
          statusDefinitions: serverRuleset.statuses?.definitions,
        }).state;
        assertWorldState(incomingState);
      } catch (error) {
        return sendSocket(socket, { type: 'error', operationId: worldOperationId, code: error?.code || 'invalid_state', message: error?.message || 'World state 无效' });
      }
      if (world.state && !isSameChat(world.state, incomingState)) {
        return sendSocket(socket, { type: 'world.denied', operationId: worldOperationId, code: 'chat_server_only', message: '聊天记录只能通过服务器提交', revision: world.revision, updatedAt: world.updatedAt, state: world.state });
      }
      if (session.role !== 'gm') {
        if (session.identityStatus !== 'active') return sendSocket(socket, { type: 'error', operationId: worldOperationId, code: 'identity_pending', message: '等待 GM 批准身份后才能操作 World' });
        const user = findUser(session.userId);
        const authorization = validatePlayerWorldPush({ before: world.state, next: incomingState, user });
        if (!authorization.ok) {
          return sendSocket(socket, {
            type: 'world.denied',
            operationId: worldOperationId,
            code: authorization.code,
            message: authorization.message,
            revision: world.revision,
            updatedAt: world.updatedAt,
            state: world.state,
            activeActorId: authorization.activeActorId || null,
          });
        }
      }
      const baseRevision = Math.max(0, Number(message.baseRevision) || 0);
      if (baseRevision !== world.revision) {
        return sendSocket(socket, {
          type: 'world.conflict',
          operationId: worldOperationId,
          revision: world.revision,
          updatedAt: world.updatedAt,
          state: world.state,
        });
      }
      const encoded = JSON.stringify(incomingState);
      if (Buffer.byteLength(encoded) > MAX_WS_PAYLOAD) return sendSocket(socket, { type: 'error', operationId: worldOperationId, code: 'state_too_large', message: 'World state is too large' });
      const nextWorld = {
        schemaVersion: 1,
        worldId: WORLD_ID,
        revision: world.revision + 1,
        updatedAt: new Date().toISOString(),
        state: incomingState,
        recentStatusOperations: world.recentStatusOperations || [],
      };
      try { await persistWorld(nextWorld, { forceBackup: true }); }
      catch (error) { return sendSocket(socket, { type: 'error', operationId: worldOperationId, code: 'persist_failed', message: `World 未保存：${error.message}` }); }
      await worldWal.reset();
      world = nextWorld;
      resetResumeHistory();
      const snapshot = {
        type: 'world.snapshot',
        operationId: worldOperationId,
        revision: world.revision,
        updatedAt: world.updatedAt,
        state: world.state,
        originSessionId: session.id,
        reason: String(message.reason || 'state-change').slice(0, 80),
      };
      broadcastWorld(snapshot);
      broadcastAccessSnapshots();
      return;
    }

    if (message?.type === 'world.snapshot.request') {
      if (session.role !== 'gm' && session.identityStatus !== 'active') return sendSocket(socket, { type: 'error', code: 'identity_pending', message: '等待 GM 批准身份' });
      return sendSocket(socket, { type: 'world.snapshot', revision: world.revision, updatedAt: world.updatedAt, state: audienceStateFor(session), audienceRevision: session.audienceRevision, originSessionId: null, reason: 'request' });
    }

    if (message?.type === 'ping') return sendSocket(socket, {
      type: 'pong',
      sentAt: Number(message.sentAt) || null,
      at: Date.now(),
    });
    sendSocket(socket, { type: 'error', code: 'unknown_message', message: 'Unknown message type' });
    }).catch(error => {
      console.error('[RPGmap] websocket message rejected:', error);
      if (!socket.destroyed) sendSocket(socket, { type: 'error', code: 'request_failed', message: '请求未完成，服务器保持运行。' });
    });
  }, cleanup, { maxPayload: MAX_WS_PAYLOAD });
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log('');
  console.log('============================================================');
  console.log(` RPGmap Multiplayer Server  |  ${packageVersion}`);
  console.log('============================================================');
  console.log(` Local     : http://127.0.0.1:${actualPort}`);
  for (const url of listNetworkUrls(actualPort)) console.log(` Network   : ${url}`);
  console.log(` World     : ${WORLD_ID} · revision ${world.revision}`);
  console.log(` Users     : ${access.users.length} persistent Player identities`);
  console.log(` Map Root  : ${MAP_DIR}`);
  console.log(` World File: ${WORLD_FILE}`);
  console.log(` Users File: ${ACCESS_FILE}`);
  console.log(' Players   : Actor Ownership + Combat Turn Lock');
  console.log(' Mode      : Local / LAN only');
  if (PLAYER_JOIN_CODE) console.log(` JoinCode  : ${PLAYER_JOIN_CODE}`);
  console.log(` GMSecret  : ${GM_SECRET}`);
  console.log(` Build     : ${version.commit || 'unknown'}`);
  if (legacyMigrations.length) console.log(` Migrated  : ${legacyMigrations.map(item => item.type).join(', ')} from legacy data/`);
  console.log(' Status    : READY');
  console.log('============================================================');
  console.log(' Press Ctrl+C to stop the server.');
  console.log('');
});
