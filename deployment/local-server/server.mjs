import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(process.env.RPGMAP_PUBLIC_DIR || path.join(ROOT, 'public'));
const DATA_DIR = path.resolve(process.env.RPGMAP_DATA_DIR || path.join(ROOT, 'data'));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 30000);
const WORLD_ID = String(process.env.RPGMAP_WORLD_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
const WORLD_DIR = path.join(DATA_DIR, 'worlds', WORLD_ID);
const WORLD_FILE = path.join(WORLD_DIR, 'world.json');
const PUBLIC_MODE = process.env.RPGMAP_PUBLIC === '1';
const PLAYER_WRITE_ENABLED = process.env.RPGMAP_PLAYER_WRITE !== '0';
const PLAYER_JOIN_CODE = String(process.env.RPGMAP_JOIN_CODE || '').trim();
const GM_SECRET = String(process.env.RPGMAP_GM_SECRET || randomBytes(4).toString('hex').toUpperCase());
const MAX_WS_PAYLOAD = 8 * 1024 * 1024;

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);

async function ensureRuntimeDirs() {
  await Promise.all([
    mkdir(WORLD_DIR, { recursive: true }),
    mkdir(path.join(DATA_DIR, 'uploads'), { recursive: true }),
    mkdir(path.join(DATA_DIR, 'backups'), { recursive: true }),
  ]);
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
        fragmentedOpcode = opcode;
        fragments = [payload];
        continue;
      }
      if (opcode === 0x0 && fragmentedOpcode !== null) {
        fragments.push(payload);
        if (!fin) continue;
        const combined = Buffer.concat(fragments);
        fragments = [];
        fragmentedOpcode = null;
        onText(combined.toString('utf8'));
        continue;
      }
      if (opcode !== 0x1) return closeSocket(socket, 1003, 'text only');
      onText(payload.toString('utf8'));
    }
  });
  socket.on('close', onClose);
  socket.on('end', onClose);
  socket.on('error', onClose);
}

await ensureRuntimeDirs();
let version = { app: 'RPGmap', version: 'unknown', serverMode: 'local-static' };
try { version = JSON.parse(await readFile(path.join(ROOT, 'VERSION.json'), 'utf8')); } catch {}
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

const sessions = new Map();
function publicSession(session) {
  return { id: session.id, name: session.name, role: session.role, connectedAt: session.connectedAt };
}
function presencePayload() {
  return { type: 'presence', clients: [...sessions.values()].map(publicSession) };
}
function broadcast(message, exceptSocket = null) {
  for (const [socket] of sessions) {
    if (socket === exceptSocket) continue;
    sendSocket(socket, message);
  }
}

function multiplayerInfo() {
  return {
    enabled: true,
    worldId: WORLD_ID,
    revision: world.revision,
    clients: sessions.size,
    publicMode: PUBLIC_MODE,
    joinCodeRequired: Boolean(PLAYER_JOIN_CODE),
    playerWriteEnabled: PLAYER_WRITE_ENABLED,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) return json(res, 405, { error: 'method_not_allowed' });
    if (req.url === '/api/health') return json(res, 200, { status: 'ok', app: version.app || 'RPGmap', version: packageVersion, mode: version.serverMode || 'local-static', multiplayer: multiplayerInfo() });
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
  const helloTimer = setTimeout(() => {
    if (!joined) closeSocket(socket, 1008, 'hello timeout');
  }, 10000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(helloTimer);
    if (sessions.delete(socket)) broadcast(presencePayload());
  };

  attachFrameReader(socket, async text => {
    let message;
    try { message = JSON.parse(text); }
    catch { return sendSocket(socket, { type: 'error', code: 'invalid_json', message: 'Invalid JSON' }); }

    if (!joined) {
      if (message?.type !== 'hello') return closeSocket(socket, 1008, 'hello required');
      if (PLAYER_JOIN_CODE && String(message.joinCode || '') !== PLAYER_JOIN_CODE) {
        sendSocket(socket, { type: 'error', code: 'invalid_join_code', message: '房间码错误' });
        return closeSocket(socket, 1008, 'invalid join code');
      }
      const requestedRole = message.requestedRole === 'gm' ? 'gm' : 'player';
      const secretMatches = Boolean(message.gmSecret) && String(message.gmSecret) === GM_SECRET;
      const localGmAllowed = !PUBLIC_MODE && isLoopback(socket.remoteAddress);
      const role = requestedRole === 'gm' && (secretMatches || localGmAllowed) ? 'gm' : 'player';
      const session = {
        id: randomUUID(),
        name: sanitizeName(message.name),
        role,
        connectedAt: new Date().toISOString(),
      };
      sessions.set(socket, session);
      joined = true;
      clearTimeout(helloTimer);
      sendSocket(socket, {
        type: 'welcome',
        session: publicSession(session),
        world: { revision: world.revision, updatedAt: world.updatedAt, state: world.state },
        permissions: { worldWrite: role === 'gm' || PLAYER_WRITE_ENABLED, worldReset: role === 'gm' },
        server: multiplayerInfo(),
      });
      broadcast(presencePayload());
      return;
    }

    const session = sessions.get(socket);
    if (!session) return closeSocket(socket, 1008, 'session missing');

    if (message?.type === 'world.push') {
      if (session.role !== 'gm' && !PLAYER_WRITE_ENABLED) {
        return sendSocket(socket, { type: 'error', code: 'forbidden', message: 'Player 当前为只读模式' });
      }
      const baseRevision = Math.max(0, Number(message.baseRevision) || 0);
      if (baseRevision !== world.revision) {
        return sendSocket(socket, {
          type: 'world.conflict',
          revision: world.revision,
          updatedAt: world.updatedAt,
          state: world.state,
        });
      }
      if (!message.state || typeof message.state !== 'object' || Array.isArray(message.state)) {
        return sendSocket(socket, { type: 'error', code: 'invalid_state', message: 'World state must be an object' });
      }
      const encoded = JSON.stringify(message.state);
      if (Buffer.byteLength(encoded) > MAX_WS_PAYLOAD) {
        return sendSocket(socket, { type: 'error', code: 'state_too_large', message: 'World state is too large' });
      }
      world = {
        schemaVersion: 1,
        worldId: WORLD_ID,
        revision: world.revision + 1,
        updatedAt: new Date().toISOString(),
        state: message.state,
      };
      persistWorld();
      broadcast({
        type: 'world.snapshot',
        revision: world.revision,
        updatedAt: world.updatedAt,
        state: world.state,
        originSessionId: session.id,
        reason: String(message.reason || 'state-change').slice(0, 80),
      });
      return;
    }

    if (message?.type === 'world.request') {
      return sendSocket(socket, {
        type: 'world.snapshot', revision: world.revision, updatedAt: world.updatedAt,
        state: world.state, originSessionId: null, reason: 'request',
      });
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
  console.log(` Local   : http://127.0.0.1:${actualPort}`);
  for (const url of networkUrls(actualPort)) console.log(` Network : ${url}`);
  console.log(` World   : ${WORLD_ID} · revision ${world.revision}`);
  console.log(` Data    : ${DATA_DIR}`);
  console.log(` Players : ${PLAYER_WRITE_ENABLED ? 'write-enabled (test mode)' : 'read-only'}`);
  console.log(` Public  : ${PUBLIC_MODE ? 'ON' : 'OFF'}`);
  if (PLAYER_JOIN_CODE) console.log(` JoinCode: ${PLAYER_JOIN_CODE}`);
  console.log(` GMSecret: ${GM_SECRET}`);
  console.log(` Build   : ${version.commit || 'unknown'}`);
  console.log(' Status  : READY');
  console.log('============================================================');
  console.log(' Press Ctrl+C to stop the server.');
  console.log('');
});
