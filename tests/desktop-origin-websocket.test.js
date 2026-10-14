import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { OriginWebSocket } from '../scripts/desktop-origin-websocket.mjs';

function queue() {
  const values = [], waiters = [];
  return {
    push(value) { const waiter = waiters.shift(); if (waiter) waiter(value); else values.push(value); },
    next() {
      if (values.length) return Promise.resolve(values.shift());
      return new Promise((resolve, reject) => {
        const receive = value => { clearTimeout(timer); resolve(value); };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(receive), 1); reject(new Error('Fixture response timed out')); }, 2000);
        waiters.push(receive);
      });
    },
  };
}

function serverFrame(opcode, data = '', final = true) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const length = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const result = Buffer.alloc(length + payload.length);
  result[0] = (final ? 0x80 : 0) | opcode;
  if (length === 2) result[1] = payload.length;
  else if (length === 4) { result[1] = 126; result.writeUInt16BE(payload.length, 2); }
  else { result[1] = 127; result.writeBigUInt64BE(BigInt(payload.length), 2); }
  payload.copy(result, length);
  return result;
}

async function fixture(t, { denied = false, invalidAccept = false, initialFrames = [] } = {}) {
  const requests = queue(), frames = queue(), connections = new Set();
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    requests.push({ url: request.url, headers: request.headers, socket });
    if (denied) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const accept = invalidAccept ? 'wrong-key' : createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const headers = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    socket.write(Buffer.concat([Buffer.from(headers), ...initialFrames]));
    let pending = Buffer.alloc(0);
    socket.on('data', incoming => {
      pending = Buffer.concat([pending, incoming]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15, masked = Boolean(pending[1] & 128);
        let offset = 2, length = pending[1] & 127;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); offset = 10; }
        const maskBytes = masked ? 4 : 0;
        if (pending.length < offset + maskBytes + length) return;
        const mask = pending.subarray(offset, offset + maskBytes), payload = Buffer.alloc(length);
        for (let index = 0; index < length; index++) payload[index] = pending[offset + maskBytes + index] ^ (masked ? mask[index % 4] : 0);
        pending = pending.subarray(offset + maskBytes + length);
        frames.push({ opcode, masked, mask, payload });
        if (opcode === 1) socket.write(serverFrame(1, payload));
        else if (opcode === 8) { socket.end(serverFrame(8, payload)); return; }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin.replace('http:', 'ws:')}/ws?fixture=scene`, request: () => requests.next(), frame: () => frames.next() };
}

function event(transport, type) {
  return new Promise((resolve, reject) => {
    const listener = value => { clearTimeout(timer); transport.removeEventListener(type, listener); resolve(value); };
    const timer = setTimeout(() => { transport.removeEventListener(type, listener); reject(new Error(`Transport event timed out: ${type}`)); }, 2000);
    transport.addEventListener(type, listener);
  });
}

test('Desktop observer sends the real Origin and masked text/pong frames through an actual local upgrade', async t => {
  const initial = JSON.stringify({ type: 'welcome', sceneId: 'scene-a' }), split = 17;
  const server = await fixture(t, { initialFrames: [serverFrame(1, initial.slice(0, split), false), serverFrame(9, 'alive'), serverFrame(0, initial.slice(split))] });
  const transport = new OriginWebSocket(server.url, server.origin);
  t.after(() => transport.close());
  const welcome = event(transport, 'message');
  await transport.open();
  const request = await server.request();
  assert.equal(request.headers.origin, server.origin);
  assert.equal(request.headers.host, new URL(server.origin).host);
  assert.equal(request.headers['sec-websocket-version'], '13');
  assert.equal(request.url, '/ws?fixture=scene');
  assert.deepEqual(JSON.parse((await welcome).data), { type: 'welcome', sceneId: 'scene-a' });
  const pong = await server.frame();
  assert.equal(pong.opcode, 10); assert.equal(pong.masked, true); assert.equal(pong.payload.toString(), 'alive');
  for (const length of [20, 300, 70000]) {
    const value = '场'.repeat(length), echoed = event(transport, 'message');
    transport.send(value);
    const sent = await server.frame();
    assert.equal(sent.opcode, 1); assert.equal(sent.masked, true);
    assert.equal(sent.mask.length, 4); assert.equal(sent.payload.toString(), value);
    assert.equal((await echoed).data, value);
  }
  const closed = event(transport, 'close');
  transport.close();
  const closeFrame = await server.frame();
  assert.equal(closeFrame.opcode, 8); assert.equal(closeFrame.masked, true);
  await closed;
});

test('Desktop observer surfaces the server Origin rejection rather than bypassing it', async t => {
  const server = await fixture(t, { denied: true });
  const suppliedOrigin = 'http://127.0.0.1:1', transport = new OriginWebSocket(server.url, suppliedOrigin);
  await assert.rejects(transport.open(), /handshake rejected: HTTP\/1\.1 403 Forbidden/);
  assert.equal((await server.request()).headers.origin, suppliedOrigin);
});

test('Desktop observer verifies the server handshake challenge', async t => {
  const server = await fixture(t, { invalidAccept: true });
  const transport = new OriginWebSocket(server.url, server.origin);
  await assert.rejects(transport.open(), /Invalid WebSocket handshake acceptance/);
});

test('Desktop observer rejects masked server frames and invalid continuations', async t => {
  for (const malformed of [Buffer.from([0x81, 0x80, 0, 0, 0, 0]), serverFrame(0, 'orphan')]) {
    const server = await fixture(t, { initialFrames: [malformed] });
    const transport = new OriginWebSocket(server.url, server.origin), rejected = event(transport, 'error');
    await transport.open();
    assert.match((await rejected).error.message, /masked WebSocket frames|Invalid WebSocket text continuation/);
  }
});

test('Desktop observer refuses URL credentials and noncanonical or non-HTTP origins', () => {
  assert.throws(() => new OriginWebSocket('ws://user:secret@127.0.0.1:1/ws', 'http://127.0.0.1:1'), /Invalid local/);
  assert.throws(() => new OriginWebSocket('ws://127.0.0.1:1/ws', 'http://127.0.0.1:1/path'), /Invalid local/);
  assert.throws(() => new OriginWebSocket('ws://127.0.0.1:1/ws', 'file:///tmp/observer'), /Invalid local/);
});
