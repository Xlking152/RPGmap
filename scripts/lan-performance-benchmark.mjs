import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const repoArgument = process.argv.find(value => value.startsWith('--repo='));
const root = path.resolve(repoArgument ? repoArgument.slice('--repo='.length) : '.');
const WAIT_MS = 60_000;
const ACTOR_COUNT = 100;
const TOKEN_COUNT = 500;
const WARMUP_COUNT = 30;
const GM_SECRET = 'BENCHMARK-GM-SECRET';
const JOIN_CODE = '246810';

class BenchmarkWebSocket {
  constructor(url) {
    this.socket = new WebSocket(url);
  }

  addEventListener(type, listener) {
    this.socket.addEventListener(type, listener);
  }

  removeEventListener(type, listener) {
    this.socket.removeEventListener(type, listener);
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket handshake timed out')), WAIT_MS);
      const onOpen = () => { cleanup(); resolve(); };
      const onError = event => { cleanup(); reject(event?.error || new Error('WebSocket handshake failed')); };
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener('open', onOpen);
        this.removeEventListener('error', onError);
      };
      this.addEventListener('open', onOpen);
      this.addEventListener('error', onError);
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  close() { this.socket.close(); }
}

function waitForMessage(socket, predicate, label = 'message') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} timed out`)); }, WAIT_MS);
    const onMessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = event => { cleanup(); reject(event?.error || new Error(`${label} failed`)); };
    const onClose = () => { cleanup(); reject(new Error(`${label} socket closed`)); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

async function startServer() {
  const mapDir = await mkdtemp(path.join(tmpdir(), 'rpgmap-lan-benchmark-'));
  const serverPath = path.join(root, 'deployment', 'local-server', 'server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'test', RPGMAP_TEST_ALLOW_MISSING_ORIGIN: '1',
      RPGMAP_GM_SECRET: GM_SECRET, RPGMAP_JOIN_CODE: JOIN_CODE, RPGMAP_MAP_DIR: mapDir,
      RPGMAP_PUBLIC_DIR: mapDir, PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Server start timed out\n${stderr}`)), WAIT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/Local\s+: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}\n${stderr}`)); });
  });
  return { child, mapDir, httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

async function stopServer(runtime) {
  for (const socket of runtime.sockets || []) socket.close();
  if (runtime.child.exitCode === null) {
    const exited = new Promise(resolve => runtime.child.once('exit', resolve));
    runtime.child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (runtime.child.exitCode === null) runtime.child.kill('SIGKILL');
  }
  await rm(runtime.mapDir, { recursive: true, force: true });
}

function fixture(definitions) {
  const actors = Array.from({ length: ACTOR_COUNT }, (_, index) => ({
    id: `actor-${index}`, name: `Actor ${index}`, type: 'pc', partyId: 'benchmark-party',
    system: {}, effects: [], notes: '', ownership: {},
  }));
  const tokens = Array.from({ length: TOKEN_COUNT }, (_, index) => ({
    id: `token-${index}`, actorId: `actor-${index % ACTOR_COUNT}`, actorLink: true, actorDelta: null,
    placement: 'map', x: index % 100, y: Math.floor(index / 100), featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0, locked: false, showName: true,
    effects: [], controllerUserIds: [], visibility: { mode: 'party', userIds: [] },
    vision: { enabled: true, rangeOverrideMeters: null, overrideUserIds: [] },
  }));
  const world = {
    schemaVersion: 3, id: 'benchmark-world', name: 'LAN Benchmark World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' }, activeSceneId: 'scene-benchmark',
    actors, statusDefinitions: definitions,
    scenes: [{
      id: 'scene-benchmark', name: 'Benchmark Scene',
      mapPackage: { id: 'benchmark-map', version: '1.0.0' }, tokens,
      markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
      settings: { gridVisible: true },
    }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    version: 2, mapId: 'benchmark-map', mapVersion: '1.0.0', markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      worldV2: world,
      entitySystem: { schemaVersion: 3, actors: structuredClone(actors), tokens: structuredClone(tokens), statusDefinitions: structuredClone(definitions) },
      combatSystem: { schemaVersion: 2, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

const { INFINITE_HORROR_STATUS_DEFINITIONS } = await import(pathToFileURL(
  path.join(root, 'src', 'rulesets', 'infinite-horror', 'statuses.js'),
).href);
const runtime = await startServer();
runtime.sockets = [];
try {
  const health = await (await fetch(`${runtime.httpUrl}/api/health`)).json();
  if (process.argv.includes('--debug')) console.error(JSON.stringify(health));
  const operationSchema = Number(health.operationSchema) || 1;
  const schemas = {
    operationSchema: health.operationSchema,
    statusSchema: health.statusSchema,
    accessSchema: health.accessSchema,
  };
  async function connect(hello) {
    const socket = new BenchmarkWebSocket(runtime.wsUrl);
    await socket.open();
    runtime.sockets.push(socket);
    const welcome = waitForMessage(socket, message => message.type === 'welcome', 'welcome');
    socket.send({ type: 'hello', ...hello, ...schemas, joinCode: JOIN_CODE });
    return { socket, welcome: await welcome };
  }

  const gm = await connect({ name: 'Benchmark GM', requestedRole: 'gm', gmSecret: GM_SECRET });
  const initialized = waitForMessage(gm.socket, message =>
    (message.type === 'world.snapshot' && message.revision === 1)
    || message.type === 'world.denied'
    || message.type === 'world.operation.denied'
    || message.type === 'error', 'World import');
  gm.socket.send({ type: 'world.push', baseRevision: 0, state: fixture(structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS)), reason: 'file-import:benchmark' });
  const initializedMessage = await initialized;
  if (initializedMessage.type !== 'world.snapshot') {
    throw new Error(`World import failed: ${JSON.stringify(initializedMessage)}`);
  }

  async function createPlayer(name) {
    const claim = waitForMessage(gm.socket, message => message.type === 'access.claim', `${name} claim`);
    gm.socket.send({ type: 'access.user.create', name, defaultActorId: 'actor-0', ownership: { 'actor-0': 'owner' } });
    const { claimCode } = await claim;
    return connect({ name, requestedRole: 'player', claimCode });
  }
  const players = [];
  for (let index = 0; index < 6; index += 1) {
    players.push(await createPlayer(`Benchmark Player ${index + 1}`));
  }
  if (process.argv.includes('--debug')) {
    const debugSockets = [['gm', gm.socket], ...players.map((player, index) => [`player${index + 1}`, player.socket])];
    for (const [name, socket] of debugSockets) {
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        console.error(name, message.type, message.reason || message.operationId || '', message.revision ?? '');
        if (message.type === 'error' || message.type === 'world.denied') console.error(name, JSON.stringify(message));
      });
    }
  }
  let revision = 1;
  const tokenPositions = new Map(Array.from({ length: TOKEN_COUNT }, (_, index) => [
    `token-${index}`, { x: index % 100, y: Math.floor(index / 100) },
  ]));
  const statusId = INFINITE_HORROR_STATUS_DEFINITIONS.find(definition => definition.id === 'status-strengthened')?.id
    || INFINITE_HORROR_STATUS_DEFINITIONS[0].id;
  const moveBytes = { requestMax: 0, responseMax: 0 };

  async function perform(type, index) {
    const operationId = `lan-bench-${type}-${index}-${revision}`;
    const predicate = message => message.type === 'document.batch.committed' && message.operationId === operationId;
    const received = players.map((player, playerIndex) =>
      waitForMessage(player.socket, predicate, `${type} player ${playerIndex + 1}`));
    const startedAt = performance.now();
    let write;
    if (type === 'move') {
      const tokenId = `token-${index % TOKEN_COUNT}`;
      const origin = tokenPositions.get(tokenId);
      const destination = { x: 100 + index, y: index % 70 };
      write = {
        action: 'move',
        document: { type: 'Token', id: tokenId, parent: { type: 'Scene', id: 'scene-benchmark' } },
        intent: 'token.movePath',
        data: { tokenIds: [tokenId], waypoints: [destination], method: 'keyboard' },
        precondition: { expectedOrigins: { [tokenId]: origin } },
      };
      tokenPositions.set(tokenId, destination);
    } else if (type === 'status') {
      const actorId = `actor-${index % ACTOR_COUNT}`;
      write = {
        action: 'update', document: { type: 'Status', id: actorId, parent: null },
        intent: 'status.apply', data: { scope: 'actor', targetId: actorId, statusId }, precondition: {},
      };
    } else {
      write = {
        action: 'append', document: { type: 'ChatMessage', id: `${operationId}-message`, parent: null },
        intent: 'chat.append', data: { text: `Benchmark ${index}` }, precondition: {},
      };
    }
    const request = {
      type: 'document.batch', operationSchema, operationId, baseRevision: revision, writes: [write],
    };
    gm.socket.send(request);
    const messages = await Promise.all(received);
    if (type === 'move') {
      moveBytes.requestMax = Math.max(moveBytes.requestMax, Buffer.byteLength(JSON.stringify(request)));
      moveBytes.responseMax = Math.max(moveBytes.responseMax, ...messages.map(message => Buffer.byteLength(JSON.stringify(message))));
    }
    revision = Number(messages[0].revision);
    return performance.now() - startedAt;
  }

  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    const type = index % 4 < 2 ? 'move' : index % 4 === 2 ? 'status' : 'chat';
    await perform(type, index);
  }
  const records = { move: [], status: [], chat: [] };
  for (let index = 0; index < 200; index += 1) {
    const type = index % 4 < 2 ? 'move' : index % 4 === 2 ? 'status' : 'chat';
    records[type].push(await perform(type, WARMUP_COUNT + index));
  }
  const aggregate = Object.values(records).flat();
  const summarize = values => ({
    count: values.length,
    medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
  });
  const measurement = {
    ...Object.fromEntries(Object.entries(records).map(([key, values]) => [key, summarize(values)])),
    aggregate: summarize(aggregate),
  };
  console.log(JSON.stringify({
    repo: root, version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, schemas, fixture: { actors: ACTOR_COUNT, tokens: TOKEN_COUNT },
    warmup: WARMUP_COUNT, measurement, moveBytes,
    scope: 'GM + 6 Player WebSocket fanout only. This does not measure browser DOM, Canvas, input preview or FPS; those require a separate foreground browser benchmark.',
  }, null, 2));
  if (process.argv.includes('--assert')) {
    if (measurement.aggregate.p95Ms > 60) {
      throw new Error(`LAN performance gate failed: aggregate p95 ${measurement.aggregate.p95Ms}ms exceeds 60ms`);
    }
    if (moveBytes.requestMax > 4096 || moveBytes.responseMax > 4096) {
      throw new Error(`Single visible Token move packet exceeds 4 KiB: ${JSON.stringify(moveBytes)}`);
    }
  }
} finally {
  await stopServer(runtime);
}
