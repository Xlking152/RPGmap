import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  buildConnectionInfo,
  createInternetCredentials,
  describePortConflict,
  inspectServerPort,
  normalizeLaunchMode,
  parseQuickTunnelUrl,
} from '../deployment/local-server/launcher.mjs';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('launcher normalizes the two startup modes', () => {
  assert.equal(normalizeLaunchMode('1'), 'local');
  assert.equal(normalizeLaunchMode('LAN'), 'local');
  assert.equal(normalizeLaunchMode('2'), 'internet');
  assert.equal(normalizeLaunchMode('public'), 'internet');
  assert.equal(normalizeLaunchMode('other'), null);
});

test('Quick Tunnel URL parser extracts the public URL only after it appears', () => {
  const before = 'INF Requesting new quick Tunnel on trycloudflare.com...';
  assert.equal(parseQuickTunnelUrl(before), null);
  assert.equal(
    parseQuickTunnelUrl(`${before}\nINF https://receiving-acquisition-ferry-bent.trycloudflare.com`),
    'https://receiving-acquisition-ferry-bent.trycloudflare.com',
  );
});

test('Internet credentials create a six-digit Join Code and unique GM Secret', () => {
  const first = createInternetCredentials();
  const second = createInternetCredentials();
  assert.match(first.joinCode, /^\d{6}$/);
  assert.match(first.gmSecret, /^[0-9A-F]{16}$/);
  assert.notEqual(first.gmSecret, second.gmSecret);
});

test('Internet READY display keeps player invite and GM secret concise and separated', () => {
  const publicUrl = 'https://example-room.trycloudflare.com';
  const joinCode = '123456';
  const text = buildConnectionInfo({
    publicUrl,
    joinCode,
    gmSecret: 'ABCDEF0123456789',
    version: '1.5.3',
    port: 30000,
  }).join('\n');

  assert.match(text, /RPGmap 1\.5\.3 · Internet \/ Public · READY/);
  assert.match(text, /PLAYER INVITE/);
  assert.match(text, /GM ONLY/);
  assert.match(text, /GM Secret\s+: ABCDEF0123456789/);
  assert.match(text, /Local\s+: http:\/\/127\.0\.0\.1:30000/);
  assert.equal(text.split(publicUrl).length - 1, 1);
  assert.equal(text.split(joinCode).length - 1, 1);
});

test('port guard identifies an existing RPGmap Local/LAN server', async () => {
  await withServer((req, res) => {
    if (req.url !== '/api/health') return res.end('no');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      app: 'RPGmap',
      version: '1.5.3',
      multiplayer: { publicMode: false },
    }));
  }, async port => {
    const result = await inspectServerPort(port);
    assert.equal(result.occupied, true);
    assert.equal(result.rpgmap, true);
    assert.equal(result.health.multiplayer.publicMode, false);
    assert.match(describePortConflict(result, port), /Local\/LAN/);
  });
});

test('port guard identifies an existing RPGmap Internet/Public server', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      app: 'RPGmap',
      version: '1.5.3',
      multiplayer: { publicMode: true },
    }));
  }, async port => {
    const result = await inspectServerPort(port);
    assert.equal(result.occupied, true);
    assert.equal(result.rpgmap, true);
    assert.match(describePortConflict(result, port), /Internet\/Public/);
  });
});

test('port guard reports a non-RPGmap HTTP listener as a generic conflict', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('other-service');
  }, async port => {
    const result = await inspectServerPort(port);
    assert.equal(result.occupied, true);
    assert.equal(result.rpgmap, false);
    assert.match(describePortConflict(result, port), /another program/);
  });
});
