import { createConnection } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

// Pure test transport adapted from the existing lan-vision-smoke OriginWebSocket.
// Native Node WebSocket cannot attach Origin; the desktop server correctly
// requires the real application's Origin rather than a test-only exemption.
export class OriginWebSocket {
  constructor(url, origin) {
    this.url = new URL(url);
    const originUrl = new URL(origin);
    if (this.url.protocol !== 'ws:' || this.url.username || this.url.password || this.url.hash
      || originUrl.protocol !== 'http:' || originUrl.origin !== origin) throw new Error('Invalid local WebSocket origin');
    this.origin = origin;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.closing = false;
    this.listeners = new Map();
    this.fragments = [];
    this.fragmentBytes = 0;
  }

  addEventListener(type, listener, options = {}) {
    const values = this.listeners.get(type) || [];
    values.push({ listener, once: options?.once === true });
    this.listeners.set(type, values);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(record => record.listener !== listener));
  }

  dispatch(type, value = {}) {
    for (const record of [...(this.listeners.get(type) || [])]) {
      if (record.once) this.removeEventListener(type, record.listener);
      record.listener(value);
    }
  }

  async open() {
    if (this.socket) throw new Error('WebSocket transport can only be opened once');
    const key = randomBytes(16).toString('base64');
    this.expectedAccept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    this.socket = createConnection({ host: this.url.hostname.replace(/^\[|\]$/g, ''), port: Number(this.url.port || 80) });
    this.socket.on('data', chunk => this.onData(chunk));
    this.socket.on('error', error => this.dispatch('error', { error }));
    this.socket.on('close', () => this.dispatch('close'));
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener('open', opened); this.removeEventListener('error', failed); this.removeEventListener('close', closed);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = event => { cleanup(); reject(event.error || new Error('WebSocket handshake failed')); };
      const closed = () => { cleanup(); reject(new Error('WebSocket closed before its handshake completed')); };
      const timer = setTimeout(() => { cleanup(); this.socket.destroy(); reject(new Error('WebSocket handshake timed out')); }, 10000);
      this.addEventListener('open', opened); this.addEventListener('error', failed); this.addEventListener('close', closed);
      this.socket.once('connect', () => this.socket.write([
        `GET ${this.url.pathname}${this.url.search} HTTP/1.1`, `Host: ${this.url.host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Origin: ${this.origin}`, '\r\n',
      ].join('\r\n')));
    });
  }

  reject(error) { this.dispatch('error', { error }); this.socket?.destroy(); }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end > 65536 || (end < 0 && this.buffer.length > 65536)) return this.reject(new Error('WebSocket handshake headers are too large'));
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101 /i.test(header)) return this.reject(new Error(`WebSocket handshake rejected: ${header.split('\r\n')[0]}`));
      const accept = header.match(/^Sec-WebSocket-Accept:\s*(.+)$/im)?.[1]?.trim();
      if (accept !== this.expectedAccept) return this.reject(new Error('Invalid WebSocket handshake acceptance'));
      if (!/^Upgrade:\s*websocket\s*$/im.test(header)
        || !header.match(/^Connection:\s*(.+)$/im)?.[1].split(',').some(value => value.trim().toLowerCase() === 'upgrade')) {
        return this.reject(new Error('Invalid WebSocket upgrade headers'));
      }
      this.handshakeComplete = true;
      this.dispatch('open');
    }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0], opcode = first & 0x0f, final = (first & 0x80) !== 0;
      if (first & 0x70) return this.reject(new Error('Unexpected WebSocket extension bits'));
      if (this.buffer[1] & 0x80) return this.reject(new Error('The server cannot send masked WebSocket frames'));
      let offset = 2, length = this.buffer[1] & 0x7f;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const size = this.buffer.readBigUInt64BE(2);
        if (size > 64n * 1024n * 1024n) return this.reject(new Error('WebSocket fixture frame is too large'));
        length = Number(size); offset = 10;
      }
      if (opcode >= 0x8 && (!final || length > 125)) return this.reject(new Error('Invalid WebSocket control frame'));
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1 || opcode === 0x0) {
        if ((opcode === 0x0 && !this.fragments.length) || (opcode === 0x1 && this.fragments.length)) {
          return this.reject(new Error('Invalid WebSocket text continuation'));
        }
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > 64 * 1024 * 1024) return this.reject(new Error('WebSocket fixture message is too large'));
        this.fragments.push(payload);
        if (final) {
          const data = Buffer.concat(this.fragments).toString('utf8'); this.fragments = []; this.fragmentBytes = 0;
          this.dispatch('message', { data });
        }
      } else if (opcode === 0x8) {
        if (payload.length === 1) return this.reject(new Error('Invalid WebSocket close frame'));
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        if (code !== 1000) this.dispatch('error', { error: new Error(`WebSocket closed ${code}: ${payload.subarray(2).toString('utf8')}`) });
        if (!this.closing) this.sendFrame(0x8, payload);
        this.closing = true;
        this.socket.end();
        return;
      } else if (opcode === 0x9) this.sendFrame(0xA, payload);
      else if (opcode !== 0xA) return this.reject(new Error(`Unsupported WebSocket opcode ${opcode}`));
    }
  }

  sendFrame(opcode, raw) {
    if (!this.handshakeComplete || !this.socket || this.socket.destroyed) throw new Error('WebSocket is not open');
    const payload = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    const mask = randomBytes(4), headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
    const frame = Buffer.alloc(headerLength + 4 + payload.length);
    frame[0] = 0x80 | opcode;
    if (payload.length < 126) frame[1] = 0x80 | payload.length;
    else if (payload.length <= 0xffff) { frame[1] = 0x80 | 126; frame.writeUInt16BE(payload.length, 2); }
    else { frame[1] = 0x80 | 127; frame.writeBigUInt64BE(BigInt(payload.length), 2); }
    mask.copy(frame, headerLength);
    for (let index = 0; index < payload.length; index++) frame[headerLength + 4 + index] = payload[index] ^ mask[index % 4];
    this.socket.write(frame);
  }

  send(value) {
    if (this.closing) throw new Error('WebSocket is closing');
    this.sendFrame(0x1, value);
  }
  close() {
    if (!this.socket || this.socket.destroyed || this.closing) return;
    if (this.handshakeComplete) this.sendFrame(0x8, Buffer.alloc(0));
    this.closing = true;
    this.socket.end();
  }
}
