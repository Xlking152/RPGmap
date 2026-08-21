import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

function waitForMessage(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('message timeout')); }, timeout);
    const handler = event => {
      let value;
      try { value = JSON.parse(String(event.data)); } catch { return; }
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
  ws.send(JSON.stringify({ type: 'hello', ...hello }));
  return { ws, welcome: await welcomePromise };
}

async function startServer(extraEnv = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'rpgmap-mp-'));
  const serverPath = fileURLToPath(new URL('../deployment/local-server/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: '0', RPGMAP_DATA_DIR: dataDir, RPGMAP_PUBLIC_DIR: dataDir, ...extraEnv },
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
  return { child, dataDir, url: `ws://127.0.0.1:${port}/ws` };
}

async function stopServer(runtime) {
  runtime.child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 120));
  await rm(runtime.dataDir, { recursive: true, force: true });
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

function clone(value) { return structuredClone(value); }

test('GM approves Player identity; OWNER writes succeed while unowned and combat-locked writes fail', async () => {
  const runtime = await startServer();
  try {
    const gm = await openAndHello(runtime.url, { name: 'GM Tester', requestedRole: 'gm' });
    assert.equal(gm.welcome.session.role, 'gm');

    const state1 = initialWorld();
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

    await new Promise(resolve => setTimeout(resolve, 150));
    const accessData = JSON.parse(await readFile(path.join(runtime.dataDir, 'worlds', 'default', 'access.json'), 'utf8'));
    assert.equal(accessData.users.length, 1);
    assert.equal(accessData.users[0].defaultActorId, 'actor-a');
    assert.equal(accessData.users[0].ownership['actor-a'], 'owner');
    assert.match(accessData.users[0].tokenHash, /^[0-9a-f]{64}$/);
    assert.match(accessData.users[0].playerKeyHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(accessData).includes(bound.authToken), false);

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

test('public GM secret bypasses Join Code; new Players require Join Code and enter pending approval', async () => {
  const runtime = await startServer({
    RPGMAP_PUBLIC: '1',
    RPGMAP_JOIN_CODE: '654321',
    RPGMAP_GM_SECRET: 'GM-TEST-SECRET',
  });
  try {
    const gm = await openAndHello(runtime.url, { name: 'Internet GM', requestedRole: 'gm', gmSecret: 'GM-TEST-SECRET', joinCode: '' });
    assert.equal(gm.welcome.session.role, 'gm');

    const badPlayer = await openSocket(runtime.url);
    const errorPromise = waitForMessage(badPlayer, message => message.type === 'error');
    badPlayer.send(JSON.stringify({ type: 'hello', name: 'Bad Player', requestedRole: 'player', joinCode: '000000' }));
    assert.equal((await errorPromise).code, 'invalid_join_code');
    badPlayer.close();

    const player = await openAndHello(runtime.url, { name: 'Internet Player', requestedRole: 'player', joinCode: '654321' });
    assert.equal(player.welcome.session.role, 'player');
    assert.equal(player.welcome.identity.status, 'pending');
    assert.equal(player.welcome.permissions.worldWrite, false);
    player.ws.close();
    gm.ws.close();
  } finally {
    await stopServer(runtime);
  }
});
