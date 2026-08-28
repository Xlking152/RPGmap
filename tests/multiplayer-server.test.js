import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';

const WEBSOCKET_WAIT_TIMEOUT_MS = 15_000;

function waitForMessage(ws, predicate, timeout = WEBSOCKET_WAIT_TIMEOUT_MS, label = 'matching WebSocket message') {
  return new Promise((resolve, reject) => {
    const recentMessages = [];
    const timer = setTimeout(() => {
      cleanup();
      const recent = recentMessages.length
        ? `\nRecent messages:\n${recentMessages.map(value => JSON.stringify(value)).join('\n')}`
        : '\nNo JSON messages were received while waiting.';
      reject(new Error(`${label} timeout after ${timeout}ms${recent}`));
    }, timeout);
    const handler = event => {
      let value;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      recentMessages.push(value);
      if (recentMessages.length > 12) recentMessages.shift();
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener('message', handler);
    }
    ws.addEventListener('message', handler);
  });
}

async function waitForJsonFile(filePath, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8'));
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`JSON file did not reach expected state: ${filePath}${lastError ? ` (${lastError.message})` : ''}`);
}

async function openSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open timeout')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket error')); }, { once: true });
  });
  return ws;
}

async function openAndHello(url, hello) {
  const ws = await openSocket(url);
  const welcomePromise = waitForMessage(ws, message => message.type === 'welcome');
  ws.send(JSON.stringify({ type: 'hello', ...(hello.requestedRole === 'gm' ? { gmSecret: 'TEST-GM-SECRET' } : {}), ...hello }));
  return { ws, welcome: await welcomePromise };
}

async function startServer(extraEnv = {}, existingMapDir = null) {
  const mapDir = existingMapDir || await mkdtemp(path.join(tmpdir(), 'rpgmap-map-'));
  const serverPath = fileURLToPath(new URL('../deployment/local-server/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, NODE_ENV: 'test', RPGMAP_TEST_ALLOW_MISSING_ORIGIN: '1', RPGMAP_GM_SECRET: 'TEST-GM-SECRET', PORT: '0', RPGMAP_MAP_DIR: mapDir, RPGMAP_PUBLIC_DIR: mapDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('server start timeout\n' + stderr)), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/Local\s+: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr}`));
    });
  });
  return { child, mapDir, url: `ws://127.0.0.1:${port}/ws`, httpUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(runtime, { removeMap = true } = {}) {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    const exited = new Promise(resolve => runtime.child.once('exit', resolve));
    runtime.child.kill('SIGTERM');
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!stopped && runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill('SIGKILL');
      await Promise.race([
        exited,
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
  }
  if (removeMap) await rm(runtime.mapDir, { recursive: true, force: true });
}

function initialWorld() {
  return {
    version: 2,
    mapId: 'test',
    characters: [
      { id: 'token-a', name: 'Alice', location: { type: 'map', x: 10, y: 10 }, visible: true },
      { id: 'token-b', name: 'Boss', location: { type: 'map', x: 20, y: 20 }, visible: true },
    ],
    preferences: {
      entitySystem: {
        schemaVersion: 1,
        actors: [
          { id: 'actor-a', name: 'Alice', runtime: { hp: 10 } },
          { id: 'actor-b', name: 'Boss', runtime: { hp: 20 } },
        ],
        tokens: [
          { id: 'token-a', characterId: 'token-a', actorId: 'actor-a' },
          { id: 'token-b', characterId: 'token-b', actorId: 'actor-b' },
        ],
      },
      combatSystem: { schemaVersion: 1, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  };
}

function initialWorldV2() {
  const state = initialWorld();
  delete state.characters;
  state.preferences.entitySystem.schemaVersion = 3;
  const actors = structuredClone(state.preferences.entitySystem.actors);
  const tokens = state.preferences.entitySystem.tokens.map((token, index) => ({
    id: token.id,
    actorId: token.actorId,
    actorLink: true,
    actorDelta: null,
    diameterMeters: 1,
    rotation: 0,
    elevationFt: 0,
    hidden: false,
    locked: false,
    showName: true,
    effects: [],
    x: 10 + index * 10,
    y: 10 + index * 10,
  }));
  state.preferences.entitySystem.tokens = structuredClone(tokens);
  state.preferences.entitySystem.statusDefinitions = structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS);
  state.preferences.worldV2 = {
    schemaVersion: 2,
    id: 'world-test',
    name: 'Test World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    activeSceneId: 'scene-test',
    actors: structuredClone(actors),
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
    scenes: [{
      id: 'scene-test',
      name: 'Test Scene',
      mapPackage: { id: 'test', version: '1' },
      tokens: tokens.map(token => ({
        ...structuredClone(token),
        placement: 'map',
        featureId: null,
      })),
      markers: [],
      attackAreas: [],
      sceneEvents: [],
      settings: { gridVisible: true },
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return state;
}

function clone(value) { return structuredClone(value); }

test('health exposes only World bootstrap metadata for empty and initialized LAN state', async () => {
  const runtime = await startServer();
  try {
    const empty = await (await fetch(`${runtime.httpUrl}/api/health`)).json();
    assert.deepEqual(empty.world, {
      initialized: false, kind: 'empty', schemaVersion: null, ruleset: null,
    });

    const gm = await openAndHello(runtime.url, { name: 'Bootstrap GM', requestedRole: 'gm' });
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state: initialWorldV2(), reason: 'bootstrap-init' }));
    await initialized;
    const health = await (await fetch(`${runtime.httpUrl}/api/health`)).json();
    assert.deepEqual(health.world, {
      initialized: true,
      kind: 'world-v2',
      schemaVersion: 2,
      ruleset: { id: 'infinite-horror', version: '1.0.0' },
    });
    assert.equal(Object.hasOwn(health.world, 'state'), false);
    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});

test('health identifies a persisted pre-World SaveV2 as an explicit LAN legacy bootstrap', async () => {
  const mapDir = await mkdtemp(path.join(tmpdir(), 'rpgmap-legacy-bootstrap-'));
  await writeFile(path.join(mapDir, 'world.json'), JSON.stringify({
    schemaVersion: 1,
    worldId: 'default',
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    state: initialWorld(),
  }), 'utf8');
  const runtime = await startServer({}, mapDir);
  try {
    const health = await (await fetch(`${runtime.httpUrl}/api/health`)).json();
    assert.deepEqual(health.world, {
      initialized: true, kind: 'legacy', schemaVersion: null, ruleset: null,
    });
  } finally {
    await stopServer(runtime);
  }
});

async function sendStatusAndWait(ws, message) {
  const operationId = message.operationId;
  const snapshotPromise = waitForMessage(ws, value => value.type === 'world.snapshot' && value.operationId === operationId);
  const ackPromise = waitForMessage(ws, value => value.type === 'status.ack' && value.operationId === operationId);
  ws.send(JSON.stringify(message));
  const [snapshot, ack] = await Promise.all([snapshotPromise, ackPromise]);
  return { snapshot, ack };
}

async function sendWorldOperationsAndWait(ws, message) {
  const operationId = message.operationId;
  const committedPromise = waitForMessage(ws, value =>
    value.type === 'world.operation.committed' && value.operationId === operationId);
  const ackPromise = waitForMessage(ws, value =>
    value.type === 'world.operation.ack' && value.operationId === operationId);
  ws.send(JSON.stringify(message));
  const [committed, ack] = await Promise.all([committedPromise, ackPromise]);
  return { committed, ack };
}

test('generic World operations commit atomically, broadcast patches, and recover idempotently', async () => {
  const runtime = await startServer();
  try {
    const gm = await openAndHello(runtime.url, { name: 'Operation GM', requestedRole: 'gm' });
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state: initialWorldV2(), reason: 'init' }));
    await initialized;

    const actor = clone(initialWorldV2().preferences.worldV2.actors[0]);
    actor.runtime.hp = 7;
    const operation = {
      type: 'world.operation',
      operationId: 'generic-batch-1',
      baseRevision: 1,
      operations: [
        { type: 'actor.upsert', payload: { actor } },
        { type: 'token.move', payload: { sceneId: 'scene-test', tokenId: 'token-a', placement: 'map', x: 37, y: 41 } },
        { type: 'combat.replace', payload: { combatSystem: { schemaVersion: 1, combat: null } } },
      ],
    };
    const committed = await sendWorldOperationsAndWait(gm.ws, operation);
    assert.equal(committed.committed.baseRevision, 1);
    assert.equal(committed.committed.revision, 2);
    assert.equal(committed.ack.revision, 2);
    assert.equal(committed.ack.duplicate, false);
    assert.equal(Object.hasOwn(committed.committed, 'state'), false);
    assert.equal(committed.committed.patch.schemaVersion, 1);
    assert.equal(committed.committed.patch.world.actors.upsert[0].runtime.hp, 7);
    assert.equal(committed.committed.patch.world.scenes.tokens[0].upsert[0].x, 37);

    const requestedPromise = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.reason === 'request');
    gm.ws.send(JSON.stringify({ type: 'world.request' }));
    const requested = await requestedPromise;
    assert.equal(requested.revision, 2);
    assert.equal(requested.state.preferences.worldV2.actors[0].runtime.hp, 7);
    assert.equal(requested.state.preferences.worldV2.scenes[0].tokens[0].x, 37);
    assert.equal(requested.state.preferences.entitySystem.tokens[0].x, 37);

    const duplicateSnapshotPromise = waitForMessage(gm.ws, message =>
      message.type === 'world.snapshot' && message.operationId === operation.operationId);
    const duplicateAckPromise = waitForMessage(gm.ws, message =>
      message.type === 'world.operation.ack' && message.operationId === operation.operationId && message.duplicate === true);
    gm.ws.send(JSON.stringify(operation));
    const [duplicateSnapshot, duplicateAck] = await Promise.all([duplicateSnapshotPromise, duplicateAckPromise]);
    assert.equal(duplicateSnapshot.revision, 2);
    assert.equal(duplicateSnapshot.reason, 'world.operation.duplicate');
    assert.equal(duplicateAck.committedRevision, 2);

    const stalePromise = waitForMessage(gm.ws, message =>
      message.type === 'world.operation.denied' && message.operationId === 'generic-stale-1');
    gm.ws.send(JSON.stringify({
      type: 'world.operation', operationId: 'generic-stale-1', baseRevision: 1,
      operations: [{ type: 'world.rename', payload: { name: 'Stale name' } }],
    }));
    const stale = await stalePromise;
    assert.equal(stale.code, 'revision_conflict');
    assert.equal(stale.revision, 2);

    const status = await sendWorldOperationsAndWait(gm.ws, {
      type: 'world.operation', operationId: 'generic-status-1', baseRevision: 2,
      operations: [{
        type: 'status.apply',
        payload: { scope: 'actor', targetId: 'actor-a', statusId: 'status-rooted' },
      }],
    });
    assert.equal(status.committed.revision, 3);
    assert.equal(status.committed.patch.world.actors.upsert[0].effects[0].definitionId, 'status-rooted');

    const invalidPromise = waitForMessage(gm.ws, message =>
      message.type === 'world.operation.denied' && message.operationId === 'generic-invalid-1');
    gm.ws.send(JSON.stringify({
      type: 'world.operation', operationId: 'generic-invalid-1', baseRevision: 3,
      operations: [{ type: 'actor.private-write', payload: {} }],
    }));
    const invalid = await invalidPromise;
    assert.equal(invalid.code, 'unknown_world_operation');
    assert.equal(invalid.revision, 3);

    const malformedPromise = waitForMessage(gm.ws, message =>
      message.type === 'world.operation.denied' && message.operationId === 'generic-malformed-1');
    gm.ws.send(JSON.stringify({
      type: 'world.operation', operationId: 'generic-malformed-1', baseRevision: 3,
      operations: [{
        type: 'token.move', payload: { sceneId: 'scene-test', tokenId: 'token-a', placement: 'map', y: 4 },
      }],
    }));
    const malformed = await malformedPromise;
    assert.equal(malformed.code, 'invalid_world_operation');
    assert.equal(malformed.revision, 3);

    const worldData = await waitForJsonFile(path.join(runtime.mapDir, 'world.json'), value => value?.revision === 3);
    assert.equal(worldData.state.preferences.worldV2.actors[0].effects[0].definitionId, 'status-rooted');
    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});

test('generic World operations reuse Player ownership and status permission checks', async () => {
  const runtime = await startServer();
  try {
    const gm = await openAndHello(runtime.url, { name: 'Permission GM', requestedRole: 'gm' });
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state: initialWorldV2(), reason: 'init' }));
    await initialized;

    const keyPromise = waitForMessage(gm.ws, message => message.type === 'access.claim');
    gm.ws.send(JSON.stringify({
      type: 'access.user.create', name: 'Operation Player', defaultActorId: 'actor-a', ownership: { 'actor-a': 'owner' },
    }));
    const key = await keyPromise;
    const player = await openAndHello(runtime.url, {
      name: 'Operation Player', requestedRole: 'player', claimCode: key.claimCode,
    });

    const moved = await sendWorldOperationsAndWait(player.ws, {
      type: 'world.operation', operationId: 'player-owned-move-1', baseRevision: 1,
      operations: [{
        type: 'token.move',
        payload: { sceneId: 'scene-test', tokenId: 'token-a', placement: 'map', x: 16, y: 18 },
      }],
    });
    assert.equal(moved.committed.revision, 2);
    assert.equal(moved.committed.patch.world.scenes.tokens[0].upsert[0].x, 16);

    const combat = await sendWorldOperationsAndWait(gm.ws, {
      type: 'world.operation', operationId: 'generic-combat-start-1', baseRevision: 2,
      operations: [{ type: 'combat.replace', payload: { combatSystem: {
        schemaVersion: 1,
        combat: {
          id: 'combat-generic', state: 'active', round: 1, turnIndex: 0,
          combatants: [
            { id: 'cb-b', tokenId: 'token-b', actorId: 'actor-b', initiative: 20, order: 0 },
            { id: 'cb-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 10, order: 1 },
          ],
        },
      } } }],
    });
    assert.equal(combat.committed.revision, 3);

    const turnDeniedPromise = waitForMessage(player.ws, message =>
      message.type === 'world.operation.denied' && message.operationId === 'player-wrong-turn-1');
    player.ws.send(JSON.stringify({
      type: 'world.operation', operationId: 'player-wrong-turn-1', baseRevision: 3,
      operations: [{
        type: 'token.move',
        payload: { sceneId: 'scene-test', tokenId: 'token-a', placement: 'map', x: 20, y: 22 },
      }],
    }));
    const turnDenied = await turnDeniedPromise;
    assert.equal(turnDenied.code, 'combat_turn_locked');
    assert.equal(turnDenied.revision, 3);

    const actorB = clone(initialWorldV2().preferences.worldV2.actors[1]);
    actorB.runtime.hp = 1;
    const unownedPromise = waitForMessage(player.ws, message =>
      message.type === 'world.operation.denied' && message.operationId === 'player-unowned-1');
    player.ws.send(JSON.stringify({
      type: 'world.operation', operationId: 'player-unowned-1', baseRevision: 3,
      operations: [{ type: 'actor.upsert', payload: { actor: actorB } }],
    }));
    const unowned = await unownedPromise;
    assert.equal(unowned.code, 'actor_not_owned');
    assert.equal(unowned.revision, 3);

    const statusPromise = waitForMessage(player.ws, message =>
      message.type === 'world.operation.denied' && message.operationId === 'player-status-generic-1');
    player.ws.send(JSON.stringify({
      type: 'world.operation', operationId: 'player-status-generic-1', baseRevision: 3,
      operations: [{
        type: 'status.apply',
        payload: { scope: 'actor', targetId: 'actor-a', statusId: 'status-rooted' },
      }],
    }));
    const deniedStatus = await statusPromise;
    assert.equal(deniedStatus.code, 'status_gm_only');
    assert.equal(deniedStatus.revision, 3);

    player.ws.close();
    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});

test('generic World operation idempotency survives a LAN server restart', async () => {
  let runtime = await startServer();
  const mapDir = runtime.mapDir;
  const operation = {
    type: 'world.operation', operationId: 'generic-restart-idempotency-1', baseRevision: 1,
    operations: [{ type: 'world.rename', payload: { name: 'Restart-safe World' } }],
  };
  try {
    const gm = await openAndHello(runtime.url, { name: 'Restart Operation GM', requestedRole: 'gm' });
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state: initialWorldV2(), reason: 'init' }));
    await initialized;
    const committed = await sendWorldOperationsAndWait(gm.ws, operation);
    assert.equal(committed.committed.revision, 2);
    assert.equal(committed.committed.patch.world.name, 'Restart-safe World');
    gm.ws.close();

    await stopServer(runtime, { removeMap: false });
    runtime = await startServer({}, mapDir);
    const reconnected = await openAndHello(runtime.url, { name: 'Restart Operation GM', requestedRole: 'gm' });
    assert.equal(reconnected.welcome.world.revision, 2);
    assert.equal(reconnected.welcome.world.state.preferences.worldV2.name, 'Restart-safe World');

    const snapshotPromise = waitForMessage(reconnected.ws, message =>
      message.type === 'world.snapshot' && message.operationId === operation.operationId);
    const ackPromise = waitForMessage(reconnected.ws, message =>
      message.type === 'world.operation.ack' && message.operationId === operation.operationId);
    reconnected.ws.send(JSON.stringify({ ...operation, baseRevision: 2 }));
    const [snapshot, ack] = await Promise.all([snapshotPromise, ackPromise]);
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.state.preferences.worldV2.name, 'Restart-safe World');
    assert.equal(ack.duplicate, true);
    assert.equal(ack.committedRevision, 2);
    reconnected.ws.close();
  } finally {
    await stopServer(runtime, { removeMap: true });
  }
});

test('clearing shared chat preserves active combat and actor health in LAN World', async () => {
  const runtime = await startServer();
  try {
    const gm = await openAndHello(runtime.url, { name: 'GM', requestedRole: 'gm' });
    const state = initialWorldV2();
    state.preferences.entitySystem.actors[0].runtime.health = { mode: 'wound-track', wounds: { bashing: 2, lethal: 1, aggravated: 0 } };
    state.preferences.combatSystem.combat = {
      id: 'combat-keep', state: 'active', round: 3, turnIndex: 1,
      combatants: [
        { id: 'cb-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 12, order: 0 },
        { id: 'cb-b', tokenId: 'token-b', actorId: 'actor-b', initiative: 7, order: 1 },
      ],
    };
    state.preferences.chatSystem.messages.push({ id: 'log-1', type: 'combat', text: '旧战斗日志', createdAt: '2026-01-01T00:00:00.000Z' });
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state, reason: 'init' }));
    await initialized;

    const clearedSnapshot = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 2 && message.reason === 'chat.clear');
    gm.ws.send(JSON.stringify({ type: 'chat.clear' }));
    const cleared = await clearedSnapshot;
    assert.deepEqual(cleared.state.preferences.chatSystem.messages, []);
    assert.deepEqual(cleared.state.preferences.combatSystem.combat, state.preferences.combatSystem.combat);
    assert.deepEqual(cleared.state.preferences.entitySystem.actors[0].runtime.health, state.preferences.entitySystem.actors[0].runtime.health);
    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});

test('GM status protocol is authoritative, revisioned, durable, and idempotent', async () => {
  const runtime = await startServer();
  try {
    const gm = await openAndHello(runtime.url, { name: 'Status GM', requestedRole: 'gm' });
    const state = initialWorldV2();
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state, reason: 'init' }));
    await initialized;

    const keyPromise = waitForMessage(gm.ws, message => message.type === 'access.claim');
    gm.ws.send(JSON.stringify({ type: 'access.user.create', name: 'Status Player', defaultActorId: 'actor-a', ownership: { 'actor-a': 'owner' } }));
    const keyMessage = await keyPromise;
    const player = await openAndHello(runtime.url, { name: 'Status Player', requestedRole: 'player', claimCode: keyMessage.claimCode });

    const playerDeniedPromise = waitForMessage(player.ws, message => message.type === 'status.denied' && message.operationId === 'player-status-1');
    player.ws.send(JSON.stringify({
      type: 'status.apply', operationId: 'player-status-1', clientRevision: 1,
      scope: 'actor', targetId: 'actor-a', statusId: 'status-rooted',
    }));
    const playerDenied = await playerDeniedPromise;
    assert.equal(playerDenied.code, 'status_gm_only');
    assert.equal(playerDenied.revision, 1);
    const deniedState = structuredClone(playerDenied.state);
    deniedState.preferences.worldV2.updatedAt = state.preferences.worldV2.updatedAt;
    assert.deepEqual(deniedState, state);

    const invalidIdPromise = waitForMessage(gm.ws, message => message.type === 'status.denied' && message.code === 'invalid_operation_id');
    gm.ws.send(JSON.stringify({
      type: 'status.apply', operationId: 'bad operation id', clientRevision: 1,
      scope: 'actor', targetId: 'actor-a', statusId: 'status-rooted',
    }));
    assert.equal((await invalidIdPromise).revision, 1);

    const definition = {
      id: 'status-focus', name: 'Focus', description: 'Stackable test status', icon: 'star',
      color: '#225588', category: 'buff', scopes: ['actor'], maxStacks: 5,
      changes: [], capabilities: {},
    };
    const stalePromise = waitForMessage(gm.ws, message => message.type === 'status.denied' && message.operationId === 'definition-stale');
    gm.ws.send(JSON.stringify({
      type: 'status.definition.upsert', operationId: 'definition-stale', clientRevision: 0, definition,
    }));
    const stale = await stalePromise;
    assert.equal(stale.code, 'revision_conflict');
    assert.equal(stale.revision, 1);

    const upsertMessage = {
      type: 'status.definition.upsert', operationId: 'definition-upsert-1', clientRevision: 1, definition,
    };
    const upsert = await sendStatusAndWait(gm.ws, upsertMessage);
    assert.equal(upsert.snapshot.revision, 2);
    assert.equal(upsert.snapshot.originSessionId, gm.welcome.session.id);
    assert.equal(upsert.snapshot.reason, 'status.definition.upsert');
    assert.equal(upsert.snapshot.state.preferences.entitySystem.schemaVersion, 3);
    assert.equal(upsert.snapshot.state.preferences.entitySystem.statusDefinitions.some(item => item.id === 'status-focus'), true);
    assert.equal(upsert.ack.duplicate, false);

    const duplicate = await sendStatusAndWait(gm.ws, upsertMessage);
    assert.equal(duplicate.ack.duplicate, true);
    assert.equal(duplicate.ack.committedRevision, 2);
    assert.equal(duplicate.snapshot.revision, 2);
    assert.equal(duplicate.snapshot.reason, 'status.duplicate');

    const forged = clone(upsert.snapshot.state);
    forged.preferences.entitySystem.actors[0].effects = [{
      id: 'forged-effect', definitionId: 'status-focus', stacks: 1, enabled: true,
    }];
    const forgedDeniedPromise = waitForMessage(player.ws, message => message.type === 'world.denied' && message.code === 'status_gm_only');
    player.ws.send(JSON.stringify({
      type: 'world.push', operationId: 'forged-world-status-1', baseRevision: 2, state: forged, reason: 'forged-status',
    }));
    const forgedDenied = await forgedDeniedPromise;
    assert.equal(forgedDenied.revision, 2);
    assert.equal(forgedDenied.operationId, 'forged-world-status-1');

    const applied = await sendStatusAndWait(gm.ws, {
      type: 'status.apply', operationId: 'status-apply-1', clientRevision: 2,
      scope: 'actor', targetId: 'actor-a', statusId: 'status-focus', stacks: 2,
    });
    assert.equal(applied.snapshot.revision, 3);
    assert.equal(applied.snapshot.state.preferences.entitySystem.actors[0].effects[0].stacks, 2);

    const stacked = await sendStatusAndWait(gm.ws, {
      type: 'status.setStacks', operationId: 'status-stacks-1', clientRevision: 3,
      scope: 'actor', targetId: 'actor-a', statusId: 'status-focus', stacks: 4,
      enabled: false, note: '等待解除',
    });
    assert.equal(stacked.snapshot.revision, 4);
    assert.equal(stacked.snapshot.state.preferences.entitySystem.actors[0].effects[0].stacks, 4);
    assert.equal(stacked.snapshot.state.preferences.entitySystem.actors[0].effects[0].enabled, false);
    assert.equal(stacked.snapshot.state.preferences.entitySystem.actors[0].effects[0].note, '等待解除');

    const batched = await sendStatusAndWait(gm.ws, {
      type: 'status.batch', operationId: 'status-batch-1', clientRevision: 4,
      operations: [
        { type: 'status.remove', scope: 'actor', targetId: 'actor-a', statusId: 'status-focus' },
        { type: 'status.apply', scope: 'token', targetId: 'token-a', statusId: 'status-spirit' },
      ],
    });
    assert.equal(batched.snapshot.revision, 5);
    assert.deepEqual(batched.snapshot.state.preferences.entitySystem.actors[0].effects, []);
    assert.equal(batched.snapshot.state.preferences.entitySystem.tokens[0].effects[0].definitionId, 'status-spirit');

    const removed = await sendStatusAndWait(gm.ws, {
      type: 'status.remove', operationId: 'status-remove-1', clientRevision: 5,
      scope: 'token', targetId: 'token-a', statusId: 'status-spirit',
    });
    assert.equal(removed.snapshot.revision, 6);
    assert.deepEqual(removed.snapshot.state.preferences.entitySystem.tokens[0].effects, []);

    const deleted = await sendStatusAndWait(gm.ws, {
      type: 'status.definition.delete', operationId: 'definition-delete-1', clientRevision: 6,
      definitionId: 'status-focus',
    });
    assert.equal(deleted.snapshot.revision, 7);
    assert.deepEqual(
      deleted.snapshot.state.preferences.entitySystem.statusDefinitions.map(item => item.id),
      INFINITE_HORROR_STATUS_DEFINITIONS.map(item => item.id),
    );

    // GM Feature success may atomically combine a mechanical status side effect
    // with movement/Actor changes in one complete-schema World commit.
    const featureWorld = clone(deleted.snapshot.state);
    featureWorld.preferences.worldV2.scenes[0].tokens[0].x = 42;
    featureWorld.preferences.entitySystem.tokens[0].x = 42;
    featureWorld.preferences.entitySystem.actors[0].effects = [{
      id: 'feature-rooted', definitionId: 'status-rooted', stacks: 1, enabled: true,
    }];
    const featureSnapshotPromise = waitForMessage(gm.ws, message => message.type === 'world.snapshot'
      && message.revision === 8 && message.operationId === 'feature-world-1');
    gm.ws.send(JSON.stringify({
      type: 'world.push', operationId: 'feature-world-1', baseRevision: 7, state: featureWorld, reason: 'feature-success',
    }));
    const featureSnapshot = await featureSnapshotPromise;
    assert.equal(featureSnapshot.originSessionId, gm.welcome.session.id);
    assert.equal(featureSnapshot.state.preferences.worldV2.scenes[0].tokens[0].x, 42);
    assert.equal(featureSnapshot.state.preferences.entitySystem.actors[0].effects[0].definitionId, 'status-rooted');

    const worldData = await waitForJsonFile(path.join(runtime.mapDir, 'world.json'), value => value?.revision === 8);
    assert.equal(worldData.state.preferences.entitySystem.actors[0].effects[0].definitionId, 'status-rooted');

    player.ws.close();
    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});

test('failed status persistence does not advance revision, broadcast, or consume idempotency key', async () => {
  const runtime = await startServer();
  try {
    const gm = await openAndHello(runtime.url, { name: 'Status GM', requestedRole: 'gm' });
    const state = initialWorldV2();
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state, reason: 'init' }));
    await initialized;

    const worldFile = path.join(runtime.mapDir, 'world.json');
    await rm(worldFile, { force: true });
    await mkdir(worldFile);

    const message = {
      type: 'status.apply', operationId: 'status-persist-retry', clientRevision: 1,
      scope: 'actor', targetId: 'actor-a', statusId: 'status-rooted',
    };
    const deniedPromise = waitForMessage(gm.ws, value => value.type === 'status.denied' && value.operationId === message.operationId);
    const forbiddenSnapshot = waitForMessage(gm.ws, value => value.type === 'world.snapshot' && value.operationId === message.operationId, 200);
    gm.ws.send(JSON.stringify(message));
    const denied = await deniedPromise;
    assert.equal(denied.code, 'persist_failed');
    assert.equal(denied.revision, 1);
    assert.equal(denied.state.preferences.entitySystem.actors[0].effects, undefined);
    await assert.rejects(forbiddenSnapshot, /message timeout/);

    const canonicalPromise = waitForMessage(gm.ws, value => value.type === 'world.snapshot' && value.reason === 'request');
    gm.ws.send(JSON.stringify({ type: 'world.request' }));
    assert.equal((await canonicalPromise).revision, 1);

    await rm(worldFile, { recursive: true, force: true });
    const retried = await sendStatusAndWait(gm.ws, message);
    assert.equal(retried.ack.duplicate, false);
    assert.equal(retried.snapshot.revision, 2);
    assert.equal(retried.snapshot.state.preferences.entitySystem.actors[0].effects[0].definitionId, 'status-rooted');

    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});

test('status operation idempotency survives a LAN server restart', async () => {
  let runtime = await startServer();
  const mapDir = runtime.mapDir;
  try {
    const gm = await openAndHello(runtime.url, { name: 'Restart GM', requestedRole: 'gm' });
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state: initialWorldV2(), reason: 'init' }));
    await initialized;

    const operation = {
      type: 'status.apply', operationId: 'restart-idempotency-1', clientRevision: 1,
      scope: 'actor', targetId: 'actor-a', statusId: 'status-rooted',
    };
    const committed = await sendStatusAndWait(gm.ws, operation);
    assert.equal(committed.snapshot.revision, 2);
    assert.equal(committed.snapshot.state.preferences.entitySystem.actors[0].effects[0].stacks, 1);
    gm.ws.close();

    await stopServer(runtime, { removeMap: false });
    runtime = await startServer({}, mapDir);
    const reconnected = await openAndHello(runtime.url, { name: 'Restart GM', requestedRole: 'gm' });
    assert.equal(reconnected.welcome.world.revision, 2);
    assert.equal(reconnected.welcome.world.state.preferences.entitySystem.actors[0].effects[0].stacks, 1);

    const duplicate = await sendStatusAndWait(reconnected.ws, { ...operation, clientRevision: 2 });
    assert.equal(duplicate.ack.duplicate, true);
    assert.equal(duplicate.ack.committedRevision, 2);
    assert.equal(duplicate.snapshot.revision, 2);
    assert.equal(duplicate.snapshot.state.preferences.entitySystem.actors[0].effects[0].stacks, 1);
    reconnected.ws.close();
  } finally {
    await stopServer(runtime, { removeMap: true });
  }
});

test('GM approves Player identity; OWNER writes succeed while unowned and combat-locked writes fail', async () => {
  const runtime = await startServer();
  try {
    const gm = await openAndHello(runtime.url, { name: 'GM Tester', requestedRole: 'gm' });
    assert.equal(gm.welcome.session.role, 'gm');

    const state1 = initialWorldV2();
    const initSnapshot = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state: state1, reason: 'gm-init' }));
    await initSnapshot;

    const pendingNotice = waitForMessage(gm.ws, message => message.type === 'access.snapshot' && message.pending?.some(item => item.name === 'Alice Player'));
    const player = await openAndHello(runtime.url, { name: 'Alice Player', requestedRole: 'player' });
    assert.equal(player.welcome.identity.status, 'pending');
    assert.equal(player.welcome.world.state, null);
    const accessWithPending = await pendingNotice;
    const pending = accessWithPending.pending.find(item => item.name === 'Alice Player');
    assert.ok(pending?.id);

    const boundPromise = waitForMessage(player.ws, message => message.type === 'identity.bound');
    const activeWelcomePromise = waitForMessage(player.ws, message => message.type === 'welcome' && message.identity?.status === 'active');
    gm.ws.send(JSON.stringify({
      type: 'access.user.approve',
      sessionId: pending.id,
      name: 'Alice Player',
      defaultActorId: 'actor-a',
      ownership: { 'actor-a': 'owner' },
    }));
    const bound = await boundPromise;
    const activeWelcome = await activeWelcomePromise;
    assert.match(bound.userId, /^[0-9a-f-]{36}$/i);
    assert.match(bound.authToken, /^[0-9A-F]{16}$/);
    assert.equal(activeWelcome.permissions.defaultActorId, 'actor-a');
    assert.deepEqual(activeWelcome.permissions.actorOwnerIds, ['actor-a']);
    assert.equal(activeWelcome.world.revision, 1);

    const ownedState = clone(activeWelcome.world.state);
    ownedState.preferences.entitySystem.actors[0].runtime.hp = 9;
    const ownedSnapshot = waitForMessage(player.ws, message => message.type === 'world.snapshot' && message.revision === 2);
    player.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 1, state: ownedState, reason: 'owned-change' }));
    const owned = await ownedSnapshot;
    assert.equal(owned.state.preferences.entitySystem.actors[0].runtime.hp, 9);

    const unownedState = clone(owned.state);
    unownedState.preferences.entitySystem.actors[1].runtime.hp = 19;
    const unownedDenied = waitForMessage(player.ws, message => message.type === 'world.denied');
    player.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 2, state: unownedState, reason: 'unowned-change' }));
    const denied = await unownedDenied;
    assert.equal(denied.code, 'actor_not_owned');
    assert.equal(denied.revision, 2);

    const combatWorld = clone(owned.state);
    combatWorld.preferences.combatSystem = {
      schemaVersion: 1,
      combat: {
        id: 'combat-1', state: 'active', round: 1, turnIndex: 0,
        combatants: [
          { id: 'cb-b', tokenId: 'token-b', actorId: 'actor-b', initiative: 20, order: 0 },
          { id: 'cb-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 10, order: 1 },
        ],
      },
    };
    const combatSnapshot = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 3);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 2, state: combatWorld, reason: 'combat-start' }));
    const combat = await combatSnapshot;

    const lockedState = clone(combat.state);
    lockedState.preferences.entitySystem.actors[0].runtime.hp = 8;
    const turnDenied = waitForMessage(player.ws, message => message.type === 'world.denied');
    player.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 3, state: lockedState, reason: 'wrong-turn' }));
    assert.equal((await turnDenied).code, 'combat_turn_locked');

    const aliceTurn = clone(combat.state);
    aliceTurn.preferences.combatSystem.combat.turnIndex = 1;
    const turnSnapshot = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 4);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 3, state: aliceTurn, reason: 'gm-next-turn' }));
    const turn = await turnSnapshot;

    const allowedTurnState = clone(turn.state);
    allowedTurnState.preferences.entitySystem.actors[0].runtime.hp = 8;
    const allowedTurnSnapshot = waitForMessage(player.ws, message => message.type === 'world.snapshot' && message.revision === 5);
    player.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 4, state: allowedTurnState, reason: 'own-turn' }));
    await allowedTurnSnapshot;

    const accessData = await waitForJsonFile(
      path.join(runtime.mapDir, 'users.json'),
      value => value?.users?.length === 1 && Boolean(value.users[0]?.playerKeyHash),
    );
    assert.equal(accessData.users[0].defaultActorId, 'actor-a');
    assert.equal(accessData.users[0].ownership['actor-a'], 'owner');
    assert.match(accessData.users[0].tokenHash, /^[0-9a-f]{64}$/);
    assert.match(accessData.users[0].playerKeyHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(accessData).includes(bound.authToken), false);

    const worldData = await waitForJsonFile(
      path.join(runtime.mapDir, 'world.json'),
      value => value?.revision === 5,
    );
    assert.equal(worldData.revision, 5);

    player.ws.close();
    await new Promise(resolve => setTimeout(resolve, 80));
    const reconnected = await openAndHello(runtime.url, {
      name: 'Ignored Name', requestedRole: 'player', userId: bound.userId, authToken: bound.authToken,
    });
    assert.equal(reconnected.welcome.identity.status, 'active');
    assert.equal(reconnected.welcome.session.name, 'Alice Player');
    assert.equal(reconnected.welcome.permissions.defaultActorId, 'actor-a');
    reconnected.ws.close();
    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});

test('GM can pre-create a User and Player can bind it with a reusable Player Key', async () => {
  const runtime = await startServer();
  try {
    const gm = await openAndHello(runtime.url, { name: 'GM', requestedRole: 'gm' });
    const state = initialWorld();
    const init = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state, reason: 'init' }));
    await init;

    const keyPromise = waitForMessage(gm.ws, message => message.type === 'access.claim');
    gm.ws.send(JSON.stringify({ type: 'access.user.create', name: 'Prepared Player', defaultActorId: 'actor-a', ownership: { 'actor-a': 'owner' } }));
    const keyMessage = await keyPromise;
    assert.match(keyMessage.claimCode, /^[0-9A-F]{16}$/);

    const player = await openAndHello(runtime.url, { name: 'Anything', requestedRole: 'player', claimCode: keyMessage.claimCode });
    assert.equal(player.welcome.identity.status, 'active');
    assert.equal(player.welcome.session.name, 'Prepared Player');
    assert.equal(player.welcome.permissions.defaultActorId, 'actor-a');
    player.ws.close();
    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});

test('GM Secret is mandatory; duplicate World IDs and client-forged system chat are rejected', async () => {
  const runtime = await startServer({
    RPGMAP_JOIN_CODE: '654321',
    RPGMAP_GM_SECRET: 'GM-TEST-SECRET',
  });
  try {
    const missingSecret = await openSocket(runtime.url);
    const missingSecretError = waitForMessage(missingSecret, message => message.type === 'error');
    missingSecret.send(JSON.stringify({ type: 'hello', name: 'No Secret', requestedRole: 'gm' }));
    assert.equal((await missingSecretError).code, 'gm_secret_required');
    missingSecret.close();

    const gm = await openAndHello(runtime.url, { name: 'LAN GM', requestedRole: 'gm', gmSecret: 'GM-TEST-SECRET', joinCode: '' });
    assert.equal(gm.welcome.session.role, 'gm');

    const world = initialWorld();
    world.preferences.chatSystem.messages = Array.from({ length: 500 }, (_, index) => ({
      id: `old-${index}`, type: 'chat', text: `old ${index}`, createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const initialized = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state: world, reason: 'init' }));
    await initialized;

    const duplicate = clone(world);
    duplicate.characters.push({ id: 'token-a', name: 'Duplicate', location: { type: 'map', x: 0, y: 0 }, visible: true });
    const duplicateDenied = waitForMessage(gm.ws, message => message.type === 'error');
    gm.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 1, state: duplicate, reason: 'duplicate-id' }));
    assert.equal((await duplicateDenied).code, 'duplicate_id');

    const appendSnapshot = waitForMessage(gm.ws, message => message.type === 'world.snapshot' && message.revision === 2);
    gm.ws.send(JSON.stringify({ type: 'chat.append', event: 'system', text: 'server-owned event' }));
    const appended = await appendSnapshot;
    assert.equal(appended.state.preferences.chatSystem.messages.length, 500);
    assert.equal(appended.state.preferences.chatSystem.messages.some(message => message.id === 'old-0'), false);
    assert.equal(appended.state.preferences.chatSystem.messages.at(-1).sender.name, 'LAN GM');

    const claim = waitForMessage(gm.ws, message => message.type === 'access.claim');
    gm.ws.send(JSON.stringify({ type: 'access.user.create', name: 'LAN Player', defaultActorId: 'actor-a', ownership: { 'actor-a': 'owner' } }));
    const playerKey = await claim;
    const player = await openAndHello(runtime.url, { name: 'LAN Player', requestedRole: 'player', joinCode: '654321', claimCode: playerKey.claimCode });
    const forgedSystem = waitForMessage(player.ws, message => message.type === 'error');
    player.ws.send(JSON.stringify({ type: 'chat.append', event: 'system', text: 'forged system entry', sender: { name: 'fake' } }));
    assert.equal((await forgedSystem).code, 'chat_type_forbidden');
    player.ws.close();

    const badPlayer = await openSocket(runtime.url);
    const errorPromise = waitForMessage(badPlayer, message => message.type === 'error');
    badPlayer.send(JSON.stringify({ type: 'hello', name: 'Bad Player', requestedRole: 'player', joinCode: '000000' }));
    assert.equal((await errorPromise).code, 'invalid_join_code');
    badPlayer.close();

    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});
