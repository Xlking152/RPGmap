import { createHash } from 'node:crypto';

export function websocketAccept(key) {
  return createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

export function hasSameOrigin(req, { allowMissingOrigin = false } = {}) {
  const host = String(req.headers.host || '').trim();
  const origin = String(req.headers.origin || '').trim();
  if (!origin && allowMissingOrigin) return true;
  if (!host || !origin) return false;
  return origin === `http://${host}`;
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

export function sendSocket(socket, message) {
  if (socket.destroyed) return false;
  try { socket.write(encodeFrame(JSON.stringify(message))); return true; } catch { return false; }
}

export function closeSocket(socket, code = 1000, reason = '') {
  if (socket.destroyed) return;
  const reasonBytes = Buffer.from(String(reason).slice(0, 120));
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  try { socket.write(encodeFrame(payload, 0x8)); } catch {}
  socket.end();
}

export function attachFrameReader(socket, onText, onClose, { maxPayload = 8 * 1024 * 1024 } = {}) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentedOpcode = null;
  let fragmentBytes = 0;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (first & 0x70) return closeSocket(socket, 1002, 'extensions unsupported');
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(maxPayload)) return closeSocket(socket, 1009, 'payload too large');
        length = Number(big);
        offset = 10;
      }
      if (length > maxPayload) return closeSocket(socket, 1009, 'payload too large');
      if (opcode >= 0x8 && length > 125) return closeSocket(socket, 1002, 'control frame too large');
      if (!masked) return closeSocket(socket, 1002, 'client frames must be masked');
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 0x8) return closeSocket(socket, 1000, 'bye');
      if (opcode === 0x9) { try { socket.write(encodeFrame(payload, 0xA)); } catch {} continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 && !fin) {
        if (fragmentedOpcode !== null) return closeSocket(socket, 1002, 'nested fragments');
        fragmentedOpcode = opcode;
        fragments = [payload];
        fragmentBytes = payload.length;
        continue;
      }
      if (opcode === 0x0 && fragmentedOpcode !== null) {
        fragmentBytes += payload.length;
        if (fragmentBytes > maxPayload) return closeSocket(socket, 1009, 'payload too large');
        fragments.push(payload);
        if (!fin) continue;
        const combined = Buffer.concat(fragments);
        fragments = [];
        fragmentedOpcode = null;
        fragmentBytes = 0;
        onText(combined.toString('utf8'));
        continue;
      }
      if (opcode === 0x0) return closeSocket(socket, 1002, 'unexpected continuation');
      if (fragmentedOpcode !== null) return closeSocket(socket, 1002, 'fragment sequence incomplete');
      if (opcode !== 0x1) return closeSocket(socket, 1003, 'text only');
      onText(payload.toString('utf8'));
    }
  });
  socket.on('close', onClose);
  socket.on('end', onClose);
  socket.on('error', onClose);
}
