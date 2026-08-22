import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 30000);
const WORLD_ID = String(process.env.RPGMAP_WORLD_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
const STORAGE = createPortableStorage({ root: ROOT, worldId: WORLD_ID, env: process.env });
const PUBLIC_DIR = STORAGE.appDir;
const MAP_DIR = STORAGE.mapDir;
const WORLD_FILE = STORAGE.worldFile;
const ACCESS_FILE = STORAGE.usersFile;
const PUBLIC_MODE = process.env.RPGMAP_PUBLIC === '1';
const PLAYER_JOIN_CODE = String(process.env.RPGMAP_JOIN_CODE || '').trim();
const GM_SECRET = String(process.env.RPGMAP_GM_SECRET || randomBytes(4).toString('hex').toUpperCase());
const PUBLIC_URL = String(process.env.RPGMAP_PUBLIC_URL || '').trim();
const MAX_WS_PAYLOAD = 8 * 1024 * 1024;

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

function isLoopback(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function sanitizeName(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return text || 'Player';
}

function wsAccept(key) {
  return createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
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
  if (socket.destroyed) return false;
  try {
    socket.write(encodeFrame(JSON.stringify(message)));
    return true;
  } catch {
    return false;
  }
}

function closeSocket(socket, code = 1000, reason = '') {
  if (socket.destroyed) return;
  const reasonBytes = Buffer.from(String(reason).slice(0, 120));
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  try { socket.write(encodeFrame(payload, 0x8)); } catch {}
  socket.end();
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
let version = { app: 'RPGmap', version: 'unknown', serverMode: 'multiplayer' };
try { version = JSON.parse(await readFile(path.join(STORAGE.packageRoot, 'VERSION.json'), 'utf8')); }
catch {
  try { version = JSON.parse(await readFile(path.join(ROOT, 'VERSION.json'), 'utf8')); } catch {}
}
const packageVersion = version.version || version.packageVersion || 'unknown';

let world = { schemaVersion: 1, worldId: WORLD_ID, revision: 0, updatedAt: null, state: null };
try {
  const loaded = JSON.parse(await readFile(WORLD_FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') {
    world = {
      schemaVersion: 1,
      worldId: WORLD_ID,
      revision: Math.max(0, Number(loaded.revision) || 0),
      updatedAt: loaded.updatedAt || null,
      state: loaded.state && typeof loaded.state === 'object' ? loaded.state : null,
    };
  }
} catch {}

let access = createAccessState();
try { access = normalizeAccessState(JSON.parse(await readFile(ACCESS_FILE, 'utf8'))); } catch {}

let persistChain = Promise.resolve();
function persistWorld() {
  const snapshot = JSON.stringify(world, null, 2);
  persistChain = persistChain.then(async () => {
    const temp = WORLD_FILE + '.tmp';
    await writeFile(temp, snapshot, 'utf8');
    await rename(temp, WORLD_FILE);
  }).catch(error => console.error('[RPGmap] world persist failed:', error));
  return persistChain;
}

let accessPersistChain = Promise.resolve();
function persistAccess() {
  const snapshot = JSON.stringify(access, null, 2);
  accessPersistChain = accessPersistChain.then(async () => {
    const temp = ACCESS_FILE + '.tmp';
    await writeFile(temp, snapshot, 'utf8');
    await rename(temp, ACCESS_FILE);
  }).catch(error => console.error('[RPGmap] access persist failed:', error));
  return accessPersistChain;
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
  broadcast(message, exceptSocket, session => session.role === 'gm' || session.identityStatus === 'active');
}
function sessionPermissions(session) {
  if (session.role === 'gm') {
    return { worldWrite: true, worldReset: true, manageAccess: true, combatManage: true, actorOwnerIds: ['*'], actorObserverIds: ['*'], defaultActorId: null };
  }
  const user = session.userId ? findUser(session.userId) : null;
  const ownerIds = user ? Object.entries(user.ownership).filter(([, level]) => level === OWNERSHIP.OWNER).map(([id]) => id) : [];
  const observerIds = user ? Object.entries(user.ownership).filter(([, level]) => level === OWNERSHIP.OBSERVER || level === OWNERSHIP.OWNER).map(([id]) => id) : [];
  return {
    worldWrite: Boolean(user && !user.disabled && session.identityStatus === 'active'),
    worldReset: false,
    manageAccess: false,
    combatManage: false,
    actorOwnerIds: ownerIds,
    actorObserverIds: observerIds,
    defaultActorId: user?.defaultActorId || null,
  };
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
    actors: actorCatalogFromWorld(world.state),
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
    publicMode: PUBLIC_MODE,
    publicUrl: PUBLIC_URL || null,
    joinCodeRequired: Boolean(PLAYER_JOIN_CODE),
    playerWriteEnabled: true,
  };
}
function sendWelcome(socket, session, { includeWorld = true, pendingApproval = false } = {}) {
  sendSocket(socket, {
    type: 'welcome',
    session: publicSession(session),
    identity: { status: session.identityStatus, user: session.userId ? publicUser(findUser(session.userId)) : null, pendingApproval },
    world: { revision: world.revision, updatedAt: world.updatedAt, state: includeWorld ? world.state : null },
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
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) return json(res, 405, { error: 'method_not_allowed' });
    if (req.url === '/api/health') return json(res, 200, { status: 'ok', app: version.app || 'RPGmap', version: packageVersion, mode: version.serverMode || 'multiplayer', multiplayer: multiplayerInfo() });
    if (req.url === '/api/version') return json(res, 200, version);
    if (req.url === '/api/multiplayer') return json(res, 200, multiplayerInfo());

    const candidate = safePublicPath(req.url || '/');
    if (!candidate) return json(res, 400, { error: 'bad_path' });
    try {
      await serveFile(req, res, candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      await serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
  } catch (error) {
    console.error('[RPGmap] request failed:', error);
    if (!res.headersSent) json(res, 500, { error: 'internal_server_error' });
    else res.end();
  }
});

server.on('upgrade', (req, socket) => {
  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch {}
  if (pathname !== '/ws') return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAccept(key)}`,
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

  attachFrameReader(socket, async text => {
    let message;
    try { message = JSON.parse(text); }
    catch { return sendSocket(socket, { type: 'error', code: 'invalid_json', message: 'Invalid JSON' }); }

    if (!joined) {
      if (message?.type !== 'hello') return closeSocket(socket, 1008, 'hello required');
      const requestedRole = message.requestedRole === 'gm' ? 'gm' : 'player';
      const secretMatches = Boolean(message.gmSecret) && String(message.gmSecret) === GM_SECRET;
      const localGmAllowed = !PUBLIC_MODE && isLoopback(socket.remoteAddress);
      const gmAuthorized = requestedRole === 'gm' && (secretMatches || localGmAllowed);
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
        const created = createBoundUser({ name: uniqueUserName(message.name || pendingSession.name), ...cleaned });
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
        const created = createClaimableUser({ name: uniqueUserName(message.name || 'Player'), ...cleaned });
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
        updateUserRecord(user, { name: uniqueUserName(message.name ?? user.name, user.id), ownership: cleaned.ownership, defaultActorId: cleaned.defaultActorId, disabled: message.disabled ?? user.disabled });
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

    if (message?.type === 'world.push') {
      if (session.role !== 'gm') {
        if (session.identityStatus !== 'active') return sendSocket(socket, { type: 'error', code: 'identity_pending', message: '等待 GM 批准身份后才能操作 World' });
        const user = findUser(session.userId);
        const authorization = validatePlayerWorldPush({ before: world.state, next: message.state, user });
        if (!authorization.ok) {
          return sendSocket(socket, {
            type: 'world.denied',
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
        return sendSocket(socket, { type: 'world.conflict', revision: world.revision, updatedAt: world.updatedAt, state: world.state });
      }
      if (!message.state || typeof message.state !== 'object' || Array.isArray(message.state)) {
        return sendSocket(socket, { type: 'error', code: 'invalid_state', message: 'World state must be an object' });
      }
      const encoded = JSON.stringify(message.state);
      if (Buffer.byteLength(encoded) > MAX_WS_PAYLOAD) return sendSocket(socket, { type: 'error', code: 'state_too_large', message: 'World state is too large' });
      world = { schemaVersion: 1, worldId: WORLD_ID, revision: world.revision + 1, updatedAt: new Date().toISOString(), state: message.state };
      persistWorld();
      const snapshot = { type: 'world.snapshot', revision: world.revision, updatedAt: world.updatedAt, state: world.state, originSessionId: session.id, reason: String(message.reason || 'state-change').slice(0, 80) };
      broadcastWorld(snapshot);
      broadcastAccessSnapshots();
      return;
    }

    if (message?.type === 'world.request') {
      if (session.role !== 'gm' && session.identityStatus !== 'active') return sendSocket(socket, { type: 'error', code: 'identity_pending', message: '等待 GM 批准身份' });
      return sendSocket(socket, { type: 'world.snapshot', revision: world.revision, updatedAt: world.updatedAt, state: world.state, originSessionId: null, reason: 'request' });
    }

    if (message?.type === 'ping') return sendSocket(socket, { type: 'pong', at: Date.now() });
    sendSocket(socket, { type: 'error', code: 'unknown_message', message: 'Unknown message type' });
  }, cleanup);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log('');
  console.log('============================================================');
  console.log(` RPGmap Multiplayer Server  |  ${packageVersion}`);
  console.log('============================================================');
  console.log(` Local     : http://127.0.0.1:${actualPort}`);
  for (const url of networkUrls(actualPort)) console.log(` Network   : ${url}`);
  if (PUBLIC_URL) console.log(` Public URL: ${PUBLIC_URL}`);
  console.log(` World     : ${WORLD_ID} · revision ${world.revision}`);
  console.log(` Users     : ${access.users.length} persistent Player identities`);
  console.log(` Map Root  : ${MAP_DIR}`);
  console.log(` World File: ${WORLD_FILE}`);
  console.log(` Users File: ${ACCESS_FILE}`);
  console.log(' Players   : Actor Ownership + Combat Turn Lock');
  console.log(` Public    : ${PUBLIC_MODE ? 'ON' : 'OFF'}`);
  if (PLAYER_JOIN_CODE) console.log(` JoinCode  : ${PLAYER_JOIN_CODE}`);
  console.log(` GMSecret  : ${GM_SECRET}`);
  console.log(` Build     : ${version.commit || 'unknown'}`);
  if (legacyMigrations.length) console.log(` Migrated  : ${legacyMigrations.map(item => item.type).join(', ')} from legacy data/`);
  console.log(' Status    : READY');
  console.log('============================================================');
  console.log(' Press Ctrl+C to stop the server.');
  console.log('');
});
