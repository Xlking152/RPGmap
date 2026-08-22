import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  describePortConflict,
  inspectServerPort,
  normalizeLaunchMode,
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

test('launcher normalizes the two public startup modes', () => {
  assert.equal(normalizeLaunchMode('1'), 'local');
  assert.equal(normalizeLaunchMode('LAN'), 'local');
  assert.equal(normalizeLaunchMode('2'), 'internet');
  assert.equal(normalizeLaunchMode('public'), 'internet');
  assert.equal(normalizeLaunchMode('other'), null);
});

test('inspectServerPort identifies an existing RPGmap Local/LAN server', async () => {
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

test('inspectServerPort identifies an existing RPGmap Internet/Public server', async () => {
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

test('inspectServerPort reports a non-RPGmap HTTP listener as a generic conflict', async () => {
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
