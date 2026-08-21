import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { LauncherAdminClient } from '../deployment/launcher/admin-client.mjs';

async function startServer() {
  const root = await mkdtemp(path.join(tmpdir(), 'rpgmap-launcher-admin-'));
  const serverPath = fileURLToPath(new URL('../deployment/local-server/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: '0',
      RPGMAP_PACKAGE_ROOT: root,
      RPGMAP_PUBLIC_DIR: root,
      RPGMAP_WORLD_DIR: path.join(root, 'world'),
      RPGMAP_MAPS_DIR: path.join(root, 'maps'),
      RPGMAP_GM_SECRET: 'LAUNCHER-GM-SECRET',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`server start timeout\n${stderr}`)), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/Local\s+: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr}`));
    });
  });
  return { root, child, port, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

async function stopServer(runtime) {
  runtime.child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 100));
  await rm(runtime.root, { recursive: true, force: true });
}

function worldState() {
  return {
    version: 2,
    mapId: 'launcher-test',
    characters: [{ id: 'token-a', name: 'Hero', location: { type: 'map', x: 1, y: 1 }, visible: true }],
    preferences: {
      entitySystem: {
        schemaVersion: 1,
        actors: [{ id: 'actor-a', name: 'Hero', runtime: { hp: 10 } }],
        tokens: [{ id: 'token-a', characterId: 'token-a', actorId: 'actor-a' }],
      },
      combatSystem: { schemaVersion: 1, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  };
}

test('Launcher GM admin client manages persistent Users through server protocol', async () => {
  const runtime = await startServer();
  const admin = new LauncherAdminClient({ url: runtime.wsUrl, gmSecret: 'LAUNCHER-GM-SECRET' });
  try {
    const connected = await admin.connect();
    assert.equal(connected.connected, true);
    assert.equal(connected.session.role, 'gm');

    const worldSnapshot = admin.waitFor(message => message.type === 'world.snapshot' && message.revision === 1);
    admin.send({ type: 'world.push', baseRevision: 0, state: worldState(), reason: 'launcher-test-init' });
    await worldSnapshot;
    await admin.refresh();
    assert.deepEqual(admin.access.actors.map(actor => actor.id), ['actor-a']);

    const created = await admin.createUser({
      name: 'Alice',
      defaultActorId: 'actor-a',
      ownership: { 'actor-a': 'owner' },
    });
    assert.match(created.playerKey, /^[0-9A-F]{16}$/);
    assert.equal(admin.access.users.length, 1);
    assert.equal(admin.access.users[0].name, 'Alice');
    assert.equal(admin.access.users[0].defaultActorId, 'actor-a');
    assert.equal(admin.access.users[0].ownership['actor-a'], 'owner');

    const userId = admin.access.users[0].id;
    await admin.updateUser({
      userId,
      name: 'Alice Renamed',
      defaultActorId: 'actor-a',
      ownership: { 'actor-a': 'owner' },
    });
    assert.equal(admin.access.users[0].name, 'Alice Renamed');

    const rotated = await admin.resetPlayerKey(userId);
    assert.match(rotated.playerKey, /^[0-9A-F]{16}$/);
    assert.notEqual(rotated.playerKey, created.playerKey);

    await admin.deleteUser(userId);
    assert.equal(admin.access.users.length, 0);
  } finally {
    admin.close();
    await stopServer(runtime);
  }
});

test('Launcher GM admin can approve a pending Player identity', async () => {
  const runtime = await startServer();
  const admin = new LauncherAdminClient({ url: runtime.wsUrl, gmSecret: 'LAUNCHER-GM-SECRET' });
  let player = null;
  try {
    await admin.connect();
    player = new WebSocket(runtime.wsUrl);
    await new Promise((resolve, reject) => {
      player.addEventListener('open', resolve, { once: true });
      player.addEventListener('error', reject, { once: true });
    });
    player.send(JSON.stringify({ type: 'hello', name: 'Pending Player', requestedRole: 'player' }));

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await admin.refresh();
      if (admin.access.pending.some(item => item.name === 'Pending Player')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const pending = admin.access.pending.find(item => item.name === 'Pending Player');
    assert.ok(pending?.id);

    await admin.approvePending({ sessionId: pending.id, name: 'Approved Player' });
    assert.equal(admin.access.users.some(item => item.name === 'Approved Player'), true);
    assert.equal(admin.access.pending.some(item => item.id === pending.id), false);
  } finally {
    try { player?.close(); } catch {}
    admin.close();
    await stopServer(runtime);
  }
});
