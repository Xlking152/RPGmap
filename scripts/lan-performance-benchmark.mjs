import { mkdtemp, rm } from 'node:fs/promises';
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
  const [playerA, playerB] = [await createPlayer('Benchmark Player A'), await createPlayer('Benchmark Player B')];
  if (process.argv.includes('--debug')) {
    for (const [name, socket] of [['gm', gm.socket], ['playerA', playerA.socket], ['playerB', playerB.socket]]) {
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        console.error(name, message.type, message.reason || message.operationId || '', message.revision ?? '');
        if (message.type === 'error' || message.type === 'world.denied') console.error(name, JSON.stringify(message));
      });
    }
  }
  let revision = 1;
  const statusId = INFINITE_HORROR_STATUS_DEFINITIONS.find(definition => definition.id === 'status-strengthened')?.id
    || INFINITE_HORROR_STATUS_DEFINITIONS[0].id;

  async function perform(type, index) {
    const operationId = `lan-bench-${type}-${index}-${revision}`;
    const predicate = operationSchema >= 2 || type !== 'chat'
      ? message => message.type === 'world.operation.committed' && message.operationId === operationId
      : message => message.type === 'world.snapshot' && message.reason === 'chat.append';
    const received = [waitForMessage(playerA.socket, predicate, `${type} player A`), waitForMessage(playerB.socket, predicate, `${type} player B`)];
    const legacyChatResult = type === 'chat' && operationSchema < 2
      ? waitForMessage(gm.socket, message => predicate(message) || message.type === 'error', 'legacy chat result')
      : null;
    const startedAt = performance.now();
    if (type === 'chat' && operationSchema < 2) {
      gm.socket.send({ type: 'chat.append', text: `Benchmark ${index}` });
    } else {
      const payload = type === 'move'
        ? { sceneId: 'scene-benchmark', tokenId: `token-${index % TOKEN_COUNT}`, placement: 'map', x: 100 + index, y: index % 70 }
        : type === 'status'
          ? { scope: 'actor', targetId: `actor-${index % ACTOR_COUNT}`, statusId }
          : { text: `Benchmark ${index}` };
      gm.socket.send({
        type: 'world.operation', operationId, baseRevision: revision,
        operations: [{ type: type === 'move' ? 'token.move' : type === 'status' ? 'status.apply' : 'chat.append', payload }],
      });
    }
    if (legacyChatResult) {
      const result = await legacyChatResult;
      if (result.type === 'error') throw new Error(`Legacy chat failed: ${JSON.stringify(result)}`);
    }
    const messages = await Promise.all(received);
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
  console.log(JSON.stringify({
    repo: root, version: health.version, schemas, fixture: { actors: ACTOR_COUNT, tokens: TOKEN_COUNT },
    warmup: WARMUP_COUNT, measurement: { ...Object.fromEntries(Object.entries(records).map(([key, values]) => [key, summarize(values)])), aggregate: summarize(aggregate) },
    scope: 'send until both remote sessions receive the authoritative update; browser DOM timing is covered by Edge smoke',
  }, null, 2));
} finally {
  await stopServer(runtime);
}
