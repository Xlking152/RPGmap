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
  assertWorldOperationMessage,
  createWorldOperationPatch,
  migrateLegacySceneFeatureStates,
  migrateWorldSchema3State,
  projectWorldOperationState,
  WORLD_OPERATION_SCHEMA_VERSION,
} from './world-operations.mjs';
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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 30000);
const WORLD_ID = String(process.env.RPGMAP_WORLD_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
const STORAGE = createPortableStorage({ root: ROOT, worldId: WORLD_ID, env: process.env });
const PUBLIC_DIR = STORAGE.appDir;
const MAP_DIR = STORAGE.mapDir;
const WORLD_FILE = STORAGE.worldFile;
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
    await rename(temp, filePath);
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
      session.audienceOpaqueIds.set(key, `audience-${String(kind)}-${randomBytes(18).toString('base64url')}`);
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
  return sendSocket(socket, {
    type: 'world.operation.denied',
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
function broadcastOperationCommit({ beforeState, afterState, operationId, baseRevision, revision, updatedAt, results, originSessionId, changeSet }) {
  for (const [socket, session] of sessions) {
    if (session.role !== 'gm' && session.identityStatus !== 'active') continue;
    const beforeProjection = session.audienceProjection || audienceStateFor(session, beforeState);
    const afterProjection = audienceStateFor(session, afterState);
    session.audienceProjection = afterProjection;
    const patch = createWorldOperationPatch(beforeProjection, afterProjection);
    sendSocket(socket, {
      type: 'world.operation.committed', operationId, baseRevision, revision, updatedAt,
      patch,
      changeSet: audienceChangeSetFromPatch(patch, afterProjection, changeSet),
      results: projectResultsForSession(results, afterProjection, session),
      originSessionId,
      audienceRevision: session.audienceRevision,
    });
  }
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
  return operations.map(operation => {
    const value = structuredClone(operation);
    const payload = value.payload || {};
    if (value.type === 'token.move') {
      const tokenId = String(payload.tokenId || '');
      if (!tokenId) operationDenied('token_target_required', 'Player Token movement requires tokenId');
      if (!sessionControlsToken(session, tokenId)) operationDenied('token_not_controlled', 'Token is not controlled by this Player');
      const combat = world.state?.preferences?.combatSystem?.combat;
      if (combat?.state === 'active' && Array.isArray(combat.combatants) && combat.combatants.length) {
        const current = combat.combatants[Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0))];
        if (String(current?.tokenId || '') !== tokenId) operationDenied('combat_turn_locked', 'Only the active Combat Token may act');
      }
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
    if (operation.type !== 'token.move' || operation.payload?.placement === 'feature') continue;
    const tokenId = String(operation.payload?.tokenId || '');
    for (const session of sessions.values()) {
      if (String(session.visionSourceTokenId || '') !== tokenId) continue;
      const vision = describeVisionForToken(world.state, tokenId);
      if (!vision?.partyId) continue;
      const key = `${vision.sceneId}:${vision.partyId}:${tokenId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({
        type: 'scene.fog.explore',
        payload: {
          sceneId: vision.sceneId,
          partyId: vision.partyId,
          from: { x: vision.x, y: vision.y },
          to: { x: Number(operation.payload.x), y: Number(operation.payload.y) },
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
  const projectedState = includeWorld ? audienceStateFor(session) : null;
  session.audienceProjection = projectedState ? structuredClone(projectedState) : null;
  sendSocket(socket, {
    type: 'welcome',
    operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
    statusSchema: STATUS_SCHEMA_VERSION,
    accessSchema: ACCESS_SCHEMA_VERSION,
    session: publicSession(session),
    identity: { status: session.identityStatus, user: session.userId ? publicUser(findUser(session.userId)) : null, pendingApproval },
    world: { revision: world.revision, updatedAt: world.updatedAt, state: projectedState },
    audienceRevision: session.audienceRevision,
    permissions: sessionPermissions(session),
    server: multiplayerInfo(),
  });
  sendAccessSnapshot(socket);
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
        try { await persistWorld(nextWorld); }
        catch (error) {
          session.visionSourceTokenId = null;
          return sendSocket(socket, { type: 'vision.source.denied', code: 'persist_failed', message: error.message });
        }
        const baseRevision = world.revision;
        world = nextWorld;
        broadcastOperationCommit({
          beforeState, afterState: world.state, operationId: `vision-${randomUUID()}`,
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
          type: 'world.operation.ack',
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
      if (envelope.baseRevision !== world.revision) {
        return sendWorldOperationDenied(socket, message, 'revision_conflict', 'World 已被其他操作更新，请先重新载入最新状态');
      }

      let applied;
      try {
        const now = new Date().toISOString();
        const authorizedOperations = authorizeOperations(session, envelope.operations);
        const operations = appendVisionExplorationOperations(authorizedOperations);
        applied = applyWorldOperations(world.state, operations, {
          now,
          ruleset: serverRuleset,
          mapMetrics: { metersPerUnit: 1 },
          userId: session.userId,
          sessionId: session.id,
          applyStatus(state, statusMessage) {
            return applyStatusMessage(state, statusMessage, {
              now,
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
      try { await persistWorld(nextWorld); }
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
      });
      const originProjection = session.audienceProjection || audienceStateFor(session);
      sendSocket(socket, {
        type: 'world.operation.ack',
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
      world = nextWorld;
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

    if (message?.type === 'ping') return sendSocket(socket, { type: 'pong', at: Date.now() });
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
