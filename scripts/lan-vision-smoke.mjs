import { createActorFromRulesetImport } from '../src/actor/index.js';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { normalizeSceneToken } from '../src/token/model.js';
import { WORLD_OPERATION_SCHEMA_VERSION, applyWorldOperationPatch } from '../src/world/operations.js';
import { isFogCellExplored } from '../src/vision/fog.js';
import { applyExplorationDelta } from '../deployment/local-server/exploration-queue.mjs';
import { worldWalChecksum } from '../deployment/local-server/world-wal.mjs';
import { STATUS_SCHEMA_VERSION } from '../src/status/model.js';
import { ACCESS_SCHEMA_VERSION } from '../deployment/local-server/access-control.mjs';
import { isDeepStrictEqual } from 'node:util';
import { deriveSceneState } from '../src/engine/state.js';
import { runPackagedRuinsLanSmoke, sceneEventsHash } from './ruins-lan-smoke.mjs';
import { benchmarkBuildInfo } from './lan-benchmark-support.mjs';

const httpUrl = String(process.argv[2] || '').replace(/\/$/, '');
const gmSecret = String(process.argv[3] || '');
const joinCode = String(process.argv[4] || '');
const mapDir = process.argv[5] ? path.resolve(process.argv[5]) : null;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(httpUrl) || !gmSecret || !/^\d{6}$/.test(joinCode)) {
  throw new Error('Usage: node scripts/lan-vision-smoke.mjs http://127.0.0.1:PORT GM_SECRET JOIN_CODE [PACKAGED_MAP_DIR]');
}
const WAIT_MS = 12_000;
const build = mapDir ? await benchmarkBuildInfo(process.cwd(), path.dirname(mapDir)) : null;
if (build) {
  const response = await fetch(`${httpUrl}/api/version`);
  assert(response.ok && isDeepStrictEqual(await response.json(), build.metadata),
    'LAN vision server version differs from its actual package');
}

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

async function openSocket(baseUrl = httpUrl) {
  const socket = new OriginWebSocket(baseUrl.replace(/^http:/, 'ws:') + '/ws', baseUrl);
  await socket.open();
  return socket;
}

async function hello(message, baseUrl = httpUrl) {
  const socket = await openSocket(baseUrl);
  const welcome = waitForMessage(socket, value => value.type === 'welcome', 'welcome');
  socket.send(JSON.stringify({
    type: 'hello', capabilities: { occlusion: 1 },
    operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
    statusSchema: STATUS_SCHEMA_VERSION,
    accessSchema: ACCESS_SCHEMA_VERSION,
    ...message,
  }));
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
    diameterMeters: 1, rotation: 0, elevationMeters: 0,
    controllerUserIds: [], visibility: { mode: visibility, userIds: [] },
    vision: { enabled: true, rangeOverrideMeters: null, overrideUserIds: [] },
    locked: false, showName: true, effects: [],
  }, { actorId: source.id, tokenId: id, actor: source, ruleset: infiniteHorrorRuleset });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function canonicalSnapshot(socket) {
  const response = waitForMessage(socket, message => message.type === 'world.snapshot'
    && message.reason === 'request', 'Canonical snapshot');
  socket.send(JSON.stringify({ type: 'world.snapshot.request' }));
  return response;
}

// Read the exact durable prefix confirmed by an ACK, even if later Fog batches
// have already reached the log. This is also the real on-disk restart fixture.
async function durablePrefix(directory, revision = Infinity) {
  const snapshotText = await readFile(path.join(directory, 'world.json'), 'utf8');
  const snapshot = JSON.parse(snapshotText);
  assert(snapshot.revision <= revision, 'Requested ACK was compacted before its restart fixture was captured');
  let source = '';
  try { source = await readFile(path.join(directory, 'world.operations.ndjson'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const complete = source.endsWith('\n') ? source : source.slice(0, source.lastIndexOf('\n') + 1);
  const records = complete.split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .filter(record => record.revision <= revision);
  let world = snapshot;
  for (const record of records) {
    assert(record.checksum === worldWalChecksum(record), 'Durable World WAL checksum mismatch');
    if (record.revision <= world.revision) continue;
    assert(record.baseRevision === world.revision, 'Durable World WAL is not contiguous');
    world = { ...world, revision: record.revision, updatedAt: record.timestamp,
      state: applyWorldOperationPatch(world.state, record.patch, { project: false }),
      ...(record.walVersion === 2 ? { exploration: applyExplorationDelta(world.exploration, record.explorationDelta) } : {}),
      recentStatusOperations: record.results };
  }
  return { world, records, snapshotText, walText: records.map(record => JSON.stringify(record) + '\n').join('') };
}

async function waitForFog(socket, directory, sceneId, partyId, point) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const durable = directory ? (await durablePrefix(directory)).world : null;
    const canonical = await canonicalSnapshot(socket);
    const scene = canonical.state.preferences.worldV2.scenes.find(item => item.id === sceneId);
    const drained = !durable || (!Object.keys(durable.exploration?.jobs || {}).length && canonical.revision >= durable.revision);
    if (drained && isFogCellExplored(scene?.fog, partyId, point)) return canonical;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Confirmed path did not finish its ordered background Fog exploration');
}

async function verifyPackagedRestart(prefix, sceneId, partyId, point, destruction = null) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-package-fog-recovery-'));
  let child, gm;
  try {
    await mkdir(path.join(directory, 'map'));
    const restoredMap = path.join(directory, 'map');
    // A durable World can reference immutable content created by earlier UI
    // checks. Restore those dependencies alongside its snapshot/WAL prefix.
    await cp(path.join(mapDir, 'uploads'), path.join(restoredMap, 'uploads'), { recursive: true });
    await writeFile(path.join(restoredMap, 'world.json'), prefix.snapshotText);
    await writeFile(path.join(restoredMap, 'world.operations.ndjson'), prefix.walText);
    const serverPath = path.join(path.dirname(mapDir), 'server.mjs');
    child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, NODE_ENV: 'production', PORT: '0', RPGMAP_MAP_DIR: restoredMap,
        RPGMAP_PUBLIC_DIR: directory, RPGMAP_GM_SECRET: gmSecret, RPGMAP_JOIN_CODE: joinCode,
        RPGMAP_TEST_PAUSE_EXPLORATION: '0' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', value => { stderr += String(value); });
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Packaged recovery server did not start: ' + stderr)), WAIT_MS);
      child.stdout.on('data', value => {
        output += String(value);
        const match = output.match(/Local\s+: http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Packaged recovery server exited ${code}: ${stderr}`)); });
    });
    gm = await hello({ name: 'Packaged Recovery GM', requestedRole: 'gm', gmSecret }, `http://127.0.0.1:${port}`);
    assert(!Object.hasOwn(gm.welcome.world, 'exploration'), 'Private exploration jobs leaked through restart welcome');
    const recovered = await waitForFog(gm.socket, restoredMap, sceneId, partyId, point);
    assert(recovered.state.preferences.worldV2.scenes.find(item => item.id === sceneId)
      ?.tokens.find(item => item.id === 'smoke-pc-token')?.x === point.x, 'Restart lost its confirmed movement');
    assert(!Object.keys((await durablePrefix(restoredMap)).world.exploration.contexts).length,
      'Packaged recovery kept unused exploration contexts after draining');
    if (destruction) {
      const scene = recovered.state.preferences.worldV2.scenes.find(item => item.id === sceneId);
      assert(isDeepStrictEqual(scene?.sceneEvents, destruction.sceneEvents), 'Packaged restart lost confirmed destruction/restore history');
      const expected = deriveSceneState(destruction.sceneEvents), actual = deriveSceneState(scene.sceneEvents);
      assert(isDeepStrictEqual(actual, expected), 'Packaged restart changed effective destruction');
      const destroyed = actual.destroyedObjectIds.includes(destruction.featureId);
      return { featureId: destruction.featureId, revision: recovered.revision,
        sceneEvents: structuredClone(scene.sceneEvents), effectiveDamage: actual,
        sceneEventsHash: sceneEventsHash(scene.sceneEvents), expectedSceneEventsHash: sceneEventsHash(destruction.sceneEvents),
        sceneEventsRetained: true, wholeDestructionRetained: destroyed,
        restorationRetained: !actual.damagedFeatureIds.includes(destruction.featureId),
        privateQueueAbsent: !Object.hasOwn(gm.welcome.world, 'exploration'), queueDrained: true };
    }
    return true;
  } finally {
    gm?.socket.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      if (child.connected) child.send('rpgmap.shutdown'); else child.kill();
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
      await stopped; clearTimeout(timer);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const sockets = [];
try {
  const gm = await hello({ name: 'Packaged Smoke GM', requestedRole: 'gm', gmSecret });
  sockets.push(gm.socket);
  const initial = gm.welcome.world;
  const state = initial?.state ? structuredClone(initial.state) : {
    version: 2,
    mapId: 'northern-song-lanzhou-1104',
    mapVersion: '1.1.0',
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
    ruleset: { id: 'infinite-horror', version: '1.1.0' },
    activeSceneId: 'scene-packaged-smoke',
    actors: [], statusDefinitions: [],
    scenes: [{
      id: 'scene-packaged-smoke', name: 'Packaged Smoke Scene',
      mapPackage: { id: 'northern-song-lanzhou-1104', version: '1.1.0' },
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
    type: 'hello', capabilities: { occlusion: 1 }, name: 'Packaged Smoke Player', requestedRole: 'player',
    operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
    statusSchema: STATUS_SCHEMA_VERSION,
    accessSchema: ACCESS_SCHEMA_VERSION,
    claimCode: claim.claimCode, joinCode,
  }));
  const playerIdentity = await boundPromise;
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

  // Source selection is durable immediately; its first circle may finish in a
  // separate revision. Use the drained revision for this following edit.
  const sourceReady = await waitForFog(gm.socket, mapDir, scene.id, 'smoke-party', { x: 2900, y: 2500 });

  const moveCommitted = waitForMessage(playerSocket, message =>
    message.type === 'document.batch.committed' && message.operationId === 'smoke-vision-move', 'Vision document move commit');
  const moveAck = waitForMessage(playerSocket, message =>
    message.type === 'document.batch.ack' && message.operationId === 'smoke-vision-move', 'Vision document move ACK');
  playerSocket.send(JSON.stringify({
    type: 'document.batch', operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
    operationId: 'smoke-vision-move', baseRevision: sourceReady.revision,
    writes: [{
      action: 'move',
      document: { type: 'Token', id: 'smoke-pc-token', parent: { type: 'Scene', id: scene.id } },
      intent: 'token.movePath',
      data: {
        tokenIds: ['smoke-pc-token'],
        waypoints: [{ x: 2940, y: 2500, elevationMeters: 0 }],
        method: 'drag',
      },
      precondition: {
        expectedOrigins: { 'smoke-pc-token': { x: 2900, y: 2500, elevationMeters: 0 } },
      },
    }],
  }));
  const [move, moved] = await Promise.all([moveCommitted, moveAck]);
  const confirmedPrefix = mapDir ? await durablePrefix(mapDir, moved.revision) : null;
  const movedTokenChange = move.changes.find(change => change.document.type === 'Token'
    && change.document.id === 'smoke-pc-token');
  assert(move.revision === moved.revision && !move.changes.some(change => change.document.type === 'Fog'),
    'Movement ACK must confirm its durable path before background Fog completion');
  if (confirmedPrefix) {
    assert(confirmedPrefix.world.revision === moved.revision, 'Movement ACK preceded its durable WAL revision');
    const job = confirmedPrefix.world.exploration.jobs['smoke-vision-move:0'];
    assert(job?.path.length === 2 && job.path[0].x === 2900 && job.path[1].x === 2940
      && job.totalSamples === 17 && job.cursor === 0, 'Movement and its complete 2.5-meter exploration path were not atomic');
    assert(confirmedPrefix.records.some(record => record.operationId === 'smoke-vision-move'
      && record.walVersion === 2 && record.explorationDelta?.jobs?.['smoke-vision-move:0']),
    'Movement WAL record did not atomically include its private exploration job');
  }
  assert(movedTokenChange?.changed?.x === 2940,
    `Player document move did not project the authoritative Token coordinate: ${JSON.stringify(move)}`);
  assert(Array.isArray(move.motion) && move.motion.some(motion => motion.tokenId === 'smoke-pc-token'
    && motion.to?.x === 2940), 'Player document move did not publish an authoritative visual route');

  const canonical = await waitForFog(gm.socket, mapDir, scene.id, 'smoke-party', { x: 2940, y: 2500 });

  const deniedPromise = waitForMessage(playerSocket, message =>
    message.type === 'world.operation.denied' && message.operationId === 'smoke-hidden-forge', 'Hidden target rejection');
  playerSocket.send(JSON.stringify({
    type: 'world.operation', operationId: 'smoke-hidden-forge', baseRevision: canonical.revision,
    operations: [{ type: 'actor.runtime.perform', payload: {
      sceneId: scene.id, tokenId: 'smoke-secret-token',
      operation: { type: 'health.damage', amount: 1, damageType: 'L' },
    } }],
  }));
  const denied = await deniedPromise;
  assert(denied.code === 'token_not_controlled', `Hidden target did not receive stable permission rejection: ${JSON.stringify(denied)}`);
  assert(!Object.hasOwn(denied, 'state'), 'Protocol V2 rejection must not include a World rollback');

  const canonicalScene = canonical.state.preferences.worldV2.scenes.find(item => item.id === scene.id);
  assert(Object.keys(canonicalScene.fog.exploredByParty['smoke-party']?.rows || {}).length > 0,
    'Explored fog was not persisted in canonical World');
  assert(canonicalScene.tokens.find(item => item.id === 'smoke-pc-token')?.x === 2940,
    'Authoritative Token movement was not persisted');
  assert(!JSON.stringify(canonical).includes('contextId') && !JSON.stringify(projected).includes('worldEpoch'),
    'Private exploration queue leaked into a network snapshot');
  const restartRecovery = confirmedPrefix ? await verifyPackagedRestart(confirmedPrefix,
    scene.id, 'smoke-party', { x: 2940, y: 2500 }) : null;
  const ruinsLan = mapDir ? await runPackagedRuinsLanSmoke({ gm, playerSocket, playerIdentity,
    mapDir, sceneId: scene.id, sourcePoint: { x: 2940, y: 2500 }, joinCode, hello, waitForMessage,
    waitForFog, canonicalSnapshot, durablePrefix, verifyPackagedRestart }) : null;
  if (build) assert(isDeepStrictEqual(await benchmarkBuildInfo(process.cwd(), path.dirname(mapDir)), build),
    'LAN vision package changed during verification');

  console.log(JSON.stringify({
    identity: true, audienceProjection: true, visionSource: true, documentMovePath: true,
    version: build?.metadata.version, build,
    diagnosticProfiling: /--(?:cpu-prof|prof)\b/.test([...process.execArgv, process.env.NODE_OPTIONS || ''].join(' ')),
    durableMovementAndPath: Boolean(confirmedPrefix), backgroundFogDrained: true, restartRecovery, ruinsLan,
    fogRevision: canonical.revision, worldSchema: world.schemaVersion,
    importedRevision: importedSnapshot.revision,
  }));
} finally {
  for (const socket of sockets) socket.close();
}
