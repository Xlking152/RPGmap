import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GM_SECRET, benchmarkTmpRoot, startBenchmarkServer, stopBenchmarkServer,
  connectBenchmarkClient, waitForMessage, summarizeLatency, measureDocumentBatch, benchmarkBuildInfo } from './lan-benchmark-support.mjs';

const repoArgument = process.argv.find(value => value.startsWith('--repo='));
const root = path.resolve(repoArgument ? repoArgument.slice('--repo='.length) : '.');
const packageArgument = process.argv.find(value => value.startsWith('--package='));
const packageRoot = packageArgument ? path.resolve(packageArgument.slice('--package='.length)) : null;
const outputArgument = process.argv.find(value => value.startsWith('--output='));
const buildInfo = await benchmarkBuildInfo(root, packageRoot);
const ACTOR_COUNT = 100;
const TOKEN_COUNT = 500;
const WARMUP_COUNT = 30;

function fixture(definitions) {
  const actors = Array.from({ length: ACTOR_COUNT }, (_, index) => ({
    id: `actor-${index}`, name: `Actor ${index}`, type: 'pc', partyId: 'benchmark-party',
    system: {}, effects: [], notes: '', ownership: {},
  }));
  const tokens = Array.from({ length: TOKEN_COUNT }, (_, index) => ({
    id: `token-${index}`, actorId: `actor-${index % ACTOR_COUNT}`, actorLink: true, actorDelta: null,
    placement: 'map', x: index % 100, y: Math.floor(index / 100), featureId: null,
    diameterMeters: 1, rotation: 0, elevationMeters: 0, locked: false, showName: true,
    effects: [], controllerUserIds: [], visibility: { mode: 'party', userIds: [] },
    vision: { enabled: true, rangeOverrideMeters: null, overrideUserIds: [] },
  }));
  const world = {
    schemaVersion: 3, id: 'benchmark-world', name: 'LAN Benchmark World',
    ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: 'scene-benchmark',
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

const { INFINITE_HORROR_STATUS_DEFINITIONS } = await import(pathToFileURL(
  path.join(root, 'src', 'rulesets', 'infinite-horror', 'statuses.js'),
).href);
const runtime = await startBenchmarkServer(root, { packageRoot });
try {
  const health = await (await fetch(`${runtime.httpUrl}/api/health`)).json();
  if (process.argv.includes('--debug')) console.error(JSON.stringify(health));
  const operationSchema = Number(health.operationSchema) || 1;
  const schemas = {
    operationSchema: health.operationSchema,
    statusSchema: health.statusSchema,
    accessSchema: health.accessSchema,
  };
  const connect = hello => connectBenchmarkClient(runtime, schemas, hello);

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
    const result = await measureDocumentBatch(gm.socket, players.map(player => player.socket), request);
    const { messages } = result;
    if (type === 'move') {
      moveBytes.requestMax = Math.max(moveBytes.requestMax, Buffer.byteLength(JSON.stringify(request)));
      moveBytes.responseMax = Math.max(moveBytes.responseMax, ...messages.map(message => Buffer.byteLength(JSON.stringify(message))));
    }
    revision = Number(messages[0].revision);
    return result;
  }

  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    const type = index % 4 < 2 ? 'move' : index % 4 === 2 ? 'status' : 'chat';
    await perform(type, index);
  }
  const records = { move: [], status: [], chat: [] };
  const ackRecords = { move: [], status: [], chat: [] };
  for (let index = 0; index < 200; index += 1) {
    const type = index % 4 < 2 ? 'move' : index % 4 === 2 ? 'status' : 'chat';
    const result = await perform(type, WARMUP_COUNT + index);
    records[type].push(result.fanoutMs);
    ackRecords[type].push(result.ackMs);
  }
  const aggregate = Object.values(records).flat();
  const measurement = {
    ...Object.fromEntries(Object.entries(records).map(([key, values]) => [key, summarizeLatency(values)])),
    aggregate: summarizeLatency(aggregate),
  };
  const ackMeasurement = {
    ...Object.fromEntries(Object.entries(ackRecords).map(([key, values]) => [key, summarizeLatency(values)])),
    aggregate: summarizeLatency(Object.values(ackRecords).flat()),
  };
  const report = {
    repo: root, packageRoot, serverPath: runtime.serverPath,
    build: buildInfo,
    version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, schemas, fixture: { actors: ACTOR_COUNT, tokens: TOKEN_COUNT, players: 6 },
    warmup: WARMUP_COUNT, measurement, ackMeasurement, moveBytes, benchmarkTmpRoot,
    scope: 'GM + 6 Player WebSocket fanout only. This does not measure browser DOM, Canvas, input preview or FPS; those require a separate foreground browser benchmark.',
  };
  if (JSON.stringify(await benchmarkBuildInfo(root, packageRoot)) !== JSON.stringify(buildInfo)) {
    throw new Error('Benchmark candidate changed during the measurement; rerun against a stable package');
  }
  console.log(JSON.stringify(report, null, 2));
  if (outputArgument) {
    const output = path.resolve(outputArgument.slice('--output='.length));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (process.argv.includes('--assert')) {
    for (const type of ['move', 'status', 'chat', 'aggregate']) {
      if (ackMeasurement[type].p95Ms > 60) {
        throw new Error(`LAN performance gate failed: ${type} ACK p95 ${ackMeasurement[type].p95Ms}ms exceeds 60ms`);
      }
      if (measurement[type].p95Ms > 60) {
        throw new Error(`LAN performance gate failed: ${type} fanout p95 ${measurement[type].p95Ms}ms exceeds 60ms`);
      }
    }
    if (moveBytes.requestMax > 4096 || moveBytes.responseMax > 4096) {
      throw new Error(`Single visible Token move packet exceeds 4 KiB: ${JSON.stringify(moveBytes)}`);
    }
  }
} finally {
  await stopBenchmarkServer(runtime);
}
