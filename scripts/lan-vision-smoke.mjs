import { createActorFromRulesetImport } from '../src/actor/index.js';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { normalizeSceneToken } from '../src/token/model.js';

const httpUrl = String(process.argv[2] || '').replace(/\/$/, '');
const gmSecret = String(process.argv[3] || '');
const joinCode = String(process.argv[4] || '');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(httpUrl) || !gmSecret || !/^\d{6}$/.test(joinCode)) {
  throw new Error('Usage: node scripts/lan-vision-smoke.mjs http://127.0.0.1:PORT GM_SECRET JOIN_CODE');
}
const socketUrl = httpUrl.replace(/^http:/, 'ws:') + '/ws';
const WAIT_MS = 12_000;

class OriginWebSocket {
  constructor(url, origin) {
    this.url = new URL(url);
    this.origin = origin;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const record = { listener, once: options?.once === true };
    const values = this.listeners.get(type) || [];
    values.push(record);
    this.listeners.set(type, values);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(record => record.listener !== listener));
  }

  dispatch(type, value = {}) {
    const values = [...(this.listeners.get(type) || [])];
    for (const record of values) {
      record.listener(value);
      if (record.once) this.removeEventListener(type, record.listener);
    }
  }

  async open() {
    const key = randomBytes(16).toString('base64');
    this.socket = net.createConnection({ host: this.url.hostname, port: Number(this.url.port) });
    this.socket.on('data', chunk => this.onData(chunk));
    this.socket.on('error', error => this.dispatch('error', { error }));
    this.socket.on('close', () => this.dispatch('close'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket handshake timed out')), WAIT_MS);
      this.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.addEventListener('error', event => {
        clearTimeout(timer);
        reject(event?.error || new Error('WebSocket handshake failed'));
      }, { once: true });
      this.socket.once('connect', () => {
        this.socket.write([
          `GET ${this.url.pathname} HTTP/1.1`,
          `Host: ${this.url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Origin: ${this.origin}`,
          '\r\n',
        ].join('\r\n'));
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101 /i.test(header)) {
        this.dispatch('error', { error: new Error(`WebSocket handshake rejected: ${header.split('\r\n')[0]}`) });
        return this.socket.destroy();
      }
      this.handshakeComplete = true;
      this.dispatch('open');
    }
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      let offset = 2;
      let length = this.buffer[1] & 0x7f;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const value = this.buffer.readBigUInt64BE(2);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame is too large');
        length = Number(value);
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) this.dispatch('message', { data: payload.toString('utf8') });
      else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (code !== 1000) this.dispatch('error', { error: new Error(`WebSocket closed ${code}: ${reason}`) });
        this.socket.end();
      }
      else if (opcode === 0x9) this.sendFrame(0xA, payload);
    }
  }

  sendFrame(opcode, raw) {
    const payload = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    const mask = randomBytes(4);
    const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
    const frame = Buffer.alloc(headerLength + 4 + payload.length);
    frame[0] = 0x80 | opcode;
    if (payload.length < 126) frame[1] = 0x80 | payload.length;
    else if (payload.length <= 0xffff) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(payload.length, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    mask.copy(frame, headerLength);
    for (let index = 0; index < payload.length; index += 1) {
      frame[headerLength + 4 + index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(frame);
  }

  send(value) { this.sendFrame(0x1, value); }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    if (this.handshakeComplete) this.sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
  }
}

function waitForMessage(socket, predicate, label = 'WebSocket message') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out`));
    }, WAIT_MS);
    const listener = event => {
      let value;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const errorListener = event => {
      cleanup();
      reject(event?.error || new Error(`${label} socket failed`));
    };
    const closeListener = () => {
      cleanup();
      reject(new Error(`${label} socket closed`));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener('message', listener);
      socket.removeEventListener('error', errorListener);
      socket.removeEventListener('close', closeListener);
    }
    socket.addEventListener('message', listener);
    socket.addEventListener('error', errorListener);
    socket.addEventListener('close', closeListener);
  });
}

async function openSocket() {
  const socket = new OriginWebSocket(socketUrl, httpUrl);
  await socket.open();
  return socket;
}

async function hello(message) {
  const socket = await openSocket();
  const welcome = waitForMessage(socket, value => value.type === 'welcome', 'welcome');
  socket.send(JSON.stringify({ type: 'hello', ...message }));
  return { socket, welcome: await welcome };
}

function actor({ id, name, type, partyId, health, perception = null }) {
  return createActorFromRulesetImport({
    formName: 'Default', identity: { name },
    resources: { hp: { max: health }, stamina: { max: 5 }, willpower: { max: 5 } },
    attributes: perception === null ? [] : [{ id: 'perception', name: 'Perception', base: perception }],
    checks: { skills: [], saves: [] }, badStatuses: [],
    combat: { attacks: [], defenses: [] },
    tokenAppearance: { color: type === 'pc' ? '#397783' : '#963f2f', scale: 1 },
    source: { type: 'manual' },
  }, {
    id, name, type, partyId, variantId: `${id}-form`, variantName: 'Default',
    ruleset: infiniteHorrorRuleset,
  });
}

function token({ id, actor: source, x, y, visibility }) {
  return normalizeSceneToken({
    id, actorId: source.id, actorLink: source.type === 'pc',
    actorDelta: source.type === 'pc' ? null : infiniteHorrorRuleset.actor.instances.createDelta(source),
    placement: 'map', x, y, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    controllerUserIds: [], visibility: { mode: visibility, userIds: [] },
    vision: { enabled: true, rangeOverrideMeters: null, overrideUserIds: [] },
    locked: false, showName: true, effects: [],
  }, { actorId: source.id, tokenId: id, actor: source, ruleset: infiniteHorrorRuleset });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sockets = [];
try {
  const gm = await hello({ name: 'Packaged Smoke GM', requestedRole: 'gm', gmSecret });
  sockets.push(gm.socket);
  const initial = gm.welcome.world;
  const state = initial?.state ? structuredClone(initial.state) : {
    version: 2,
    mapId: 'northern-song-lanzhou-1104',
    mapVersion: '1.0.5',
    markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      entitySystem: { schemaVersion: 3, actors: [], tokens: [], statusDefinitions: [] },
      combatSystem: { schemaVersion: 2, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  };
  state.preferences.worldV2 ||= {
    schemaVersion: 3,
    id: 'world-packaged-smoke',
    name: 'Packaged Smoke World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    activeSceneId: 'scene-packaged-smoke',
    actors: [], statusDefinitions: [],
    scenes: [{
      id: 'scene-packaged-smoke', name: 'Packaged Smoke Scene',
      mapPackage: { id: 'northern-song-lanzhou-1104', version: '1.0.5' },
      tokens: [], markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
      settings: { gridVisible: true },
    }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const world = state.preferences.worldV2;
  const scene = world.scenes.find(item => String(item.id) === String(world.activeSceneId));
  assert(scene, 'Smoke World has no active Scene');
  const pc = actor({ id: 'smoke-pc', name: 'Smoke Scout', type: 'pc', partyId: 'smoke-party', health: 12, perception: 1 });
  const npc = actor({ id: 'smoke-npc', name: 'Visible Hostile', type: 'npc', partyId: 'smoke-hostile', health: 20 });
  const secret = actor({ id: 'smoke-secret', name: 'Secret Hostile', type: 'npc', partyId: 'smoke-hostile', health: 20 });
  const tokens = [
    token({ id: 'smoke-pc-token', actor: pc, x: 2900, y: 2500, visibility: 'party' }),
    token({ id: 'smoke-npc-token', actor: npc, x: 2920, y: 2500, visibility: 'public' }),
    token({ id: 'smoke-secret-token', actor: secret, x: 2910, y: 2500, visibility: 'gm' }),
  ];
  world.schemaVersion = 3;
  world.actors = [pc, npc, secret];
  world.statusDefinitions = structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS);
  scene.tokens = tokens;
  scene.markers = [];
  scene.fog = { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} };
  state.preferences.entitySystem = {
    schemaVersion: 3,
    actors: structuredClone(world.actors),
    tokens: structuredClone(tokens),
    statusDefinitions: structuredClone(world.statusDefinitions),
  };
  const imported = waitForMessage(gm.socket, message =>
    (message.type === 'world.snapshot' && message.reason === 'file-import:smoke')
      || message.type === 'world.denied'
      || message.type === 'error', 'World import');
  gm.socket.send(JSON.stringify({
    type: 'world.push', baseRevision: Number(initial?.revision) || 0, state, reason: 'file-import:smoke',
  }));
  const importedSnapshot = await imported;
  assert(importedSnapshot.type === 'world.snapshot', `World import failed: ${JSON.stringify(importedSnapshot)}`);

  const claimPromise = waitForMessage(gm.socket, message => message.type === 'access.claim', 'Player claim');
  gm.socket.send(JSON.stringify({
    type: 'access.user.create', name: 'Packaged Smoke Player', defaultActorId: pc.id,
    ownership: { [pc.id]: 'owner' },
  }));
  const claim = await claimPromise;
  const playerSocket = await openSocket();
  sockets.push(playerSocket);
  const boundPromise = waitForMessage(playerSocket, message => message.type === 'identity.bound', 'Player identity');
  const playerWelcomePromise = waitForMessage(playerSocket, message => message.type === 'welcome', 'Player welcome');
  playerSocket.send(JSON.stringify({
    type: 'hello', name: 'Packaged Smoke Player', requestedRole: 'player',
    claimCode: claim.claimCode, joinCode,
  }));
  await boundPromise;
  const playerWelcome = await playerWelcomePromise;
  const beforeVision = JSON.stringify(playerWelcome.world.state);
  assert(!beforeVision.includes('smoke-npc-token'), 'Hostile Token leaked without realtime vision');
  assert(!beforeVision.includes('smoke-secret-token'), 'GM-only Token leaked in welcome');

  const sourceAck = waitForMessage(playerSocket, message => message.type === 'vision.source.ack', 'Vision source ACK');
  const sourceSnapshot = waitForMessage(playerSocket, message =>
    message.type === 'audience.snapshot' && message.reason === 'vision.source.set', 'Audience source snapshot');
  playerSocket.send(JSON.stringify({ type: 'vision.source.set', tokenId: 'smoke-pc-token' }));
  const [ack, projected] = await Promise.all([sourceAck, sourceSnapshot]);
  assert(ack.tokenId === 'smoke-pc-token', 'Vision source was not accepted');
  const projectedText = JSON.stringify(projected.state);
  assert(projectedText.includes('smoke-npc-token'), 'Visible hostile was not projected inside realtime vision');
  assert(!projectedText.includes('smoke-secret-token'), 'GM-only Token leaked after vision source selection');
  const restricted = projected.state.preferences.worldV2.actors.find(item => item.id === npc.id);
  assert(restricted?.audienceRestricted === true && Object.keys(restricted.system || {}).length === 0,
    'Visible hostile private Actor data was not cropped');

  const moveCommitted = waitForMessage(playerSocket, message =>
    message.type === 'world.operation.committed' && message.operationId === 'smoke-vision-move', 'Vision move commit');
  const moveAck = waitForMessage(playerSocket, message =>
    message.type === 'world.operation.ack' && message.operationId === 'smoke-vision-move', 'Vision move ACK');
  playerSocket.send(JSON.stringify({
    type: 'world.operation', operationId: 'smoke-vision-move', baseRevision: ack.revision,
    operations: [{ type: 'token.move', payload: {
      sceneId: scene.id, tokenId: 'smoke-pc-token', placement: 'map', x: 2940, y: 2500,
    } }],
  }));
  const [move, moved] = await Promise.all([moveCommitted, moveAck]);
  assert(move.revision === moved.revision && move.patch.world.scenes.fog.length > 0,
    'Token move did not atomically persist its fog sweep');

  const deniedPromise = waitForMessage(playerSocket, message =>
    message.type === 'world.operation.denied' && message.operationId === 'smoke-hidden-forge', 'Hidden target rejection');
  playerSocket.send(JSON.stringify({
    type: 'world.operation', operationId: 'smoke-hidden-forge', baseRevision: moved.revision,
    operations: [{ type: 'actor.runtime.perform', payload: {
      sceneId: scene.id, tokenId: 'smoke-secret-token',
      operation: { type: 'health.damage', amount: 1, damageType: 'L' },
    } }],
  }));
  const denied = await deniedPromise;
  assert(denied.code === 'token_not_controlled', 'Hidden target did not receive stable permission rejection');
  assert(!JSON.stringify(denied.state).includes('smoke-secret-token'), 'Hidden target leaked in rejection rollback');

  const canonicalPromise = waitForMessage(gm.socket, message =>
    message.type === 'world.snapshot' && message.reason === 'request', 'Canonical snapshot');
  gm.socket.send(JSON.stringify({ type: 'world.request' }));
  const canonical = await canonicalPromise;
  const canonicalScene = canonical.state.preferences.worldV2.scenes.find(item => item.id === scene.id);
  assert(Object.keys(canonicalScene.fog.exploredByParty['smoke-party']?.rows || {}).length > 0,
    'Explored fog was not persisted in canonical World');
  assert(canonicalScene.tokens.find(item => item.id === 'smoke-pc-token')?.x === 2940,
    'Authoritative Token movement was not persisted');

  console.log(JSON.stringify({
    identity: true, audienceProjection: true, visionSource: true,
    fogRevision: canonical.revision, worldSchema: world.schemaVersion,
    importedRevision: importedSnapshot.revision,
  }));
} finally {
  for (const socket of sockets) socket.close();
}
