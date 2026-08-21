import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

function waitForMessage(ws, predicate, timeout = 4000) {
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

async function openAndHello(url, hello) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open timeout')), 4000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket error')); }, { once: true });
  });
  const welcomePromise = waitForMessage(ws, message => message.type === 'welcome');
  ws.send(JSON.stringify({ type: 'hello', ...hello }));
  return { ws, welcome: await welcomePromise };
}

test('multiplayer server synchronizes World between GM and Player', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'rpgmap-mp-'));
  const serverPath = fileURLToPath(new URL('../deployment/local-server/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: '0', RPGMAP_DATA_DIR: dataDir, RPGMAP_PUBLIC_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
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

    const url = `ws://127.0.0.1:${port}/ws`;
    const gmClient = await openAndHello(url, { name: 'GM Tester', requestedRole: 'gm' });
    assert.equal(gmClient.welcome.session.role, 'gm');
    assert.equal(gmClient.welcome.world.revision, 0);
    assert.equal(gmClient.welcome.world.state, null);

    const state1 = { version: 2, mapId: 'test', characters: [], preferences: { note: 'from-gm' } };
    const gmSnapshotPromise = waitForMessage(gmClient.ws, message => message.type === 'world.snapshot' && message.revision === 1);
    gmClient.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 0, state: state1, reason: 'gm-init' }));
    const gmSnapshot = await gmSnapshotPromise;
    assert.equal(gmSnapshot.state.preferences.note, 'from-gm');

    const playerClient = await openAndHello(url, { name: 'Player Tester', requestedRole: 'player' });
    assert.equal(playerClient.welcome.session.role, 'player');
    assert.equal(playerClient.welcome.world.revision, 1);
    assert.equal(playerClient.welcome.world.state.preferences.note, 'from-gm');

    const state2 = structuredClone(playerClient.welcome.world.state);
    state2.preferences.note = 'from-player';
    const gmUpdatePromise = waitForMessage(gmClient.ws, message => message.type === 'world.snapshot' && message.revision === 2);
    playerClient.ws.send(JSON.stringify({ type: 'world.push', baseRevision: 1, state: state2, reason: 'player-change' }));
    const gmUpdate = await gmUpdatePromise;
    assert.equal(gmUpdate.state.preferences.note, 'from-player');

    await new Promise(resolve => setTimeout(resolve, 120));
    const saved = JSON.parse(await readFile(path.join(dataDir, 'worlds', 'default', 'world.json'), 'utf8'));
    assert.equal(saved.revision, 2);
    assert.equal(saved.state.preferences.note, 'from-player');

    gmClient.ws.close();
    playerClient.ws.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 80));
    await rm(dataDir, { recursive: true, force: true });
  }
});
