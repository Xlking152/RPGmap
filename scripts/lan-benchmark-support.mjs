import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export const WAIT_MS = 60_000;
export const GM_SECRET = 'BENCHMARK-GM-SECRET';
export const JOIN_CODE = '246810';
export const benchmarkTmpRoot = path.resolve(String(process.env.RPGMAP_BENCHMARK_TMPDIR || '').trim() || tmpdir());

const decodedMessages = new WeakMap();
export function benchmarkMessage(event) {
  // Concurrent requests register separate predicates on the same socket. A
  // real client decodes each WebSocket message once, not once per predicate.
  // Keep timing the actual recipient events without multiplying JSON work.
  if (decodedMessages.has(event)) return decodedMessages.get(event);
  let message = null;
  try { message = JSON.parse(event.data); } catch { /* Ignore non-JSON frames. */ }
  decodedMessages.set(event, message);
  return message;
}

export async function benchmarkBuildInfo(root, packageRoot) {
  if (!packageRoot) return { sourceVersion: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version };
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'VERSION.json'), 'utf8'));
  const fileHashes = {};
  // The exploration worker and shared validators are part of the measured
  // server too. Fingerprint every bundled runtime module so a concurrent
  // rebuild cannot silently mix versions during an acceptance run.
  const runtimeFiles = (await readdir(packageRoot)).filter(file => file.endsWith('.mjs')).sort();
  for (const file of runtimeFiles) {
    fileHashes[file] = createHash('sha256').update(await readFile(path.join(packageRoot, file))).digest('hex');
  }
  return { metadata, fileHashes };
}

export class BenchmarkWebSocket {
  constructor(url) { this.socket = new WebSocket(url); }
  addEventListener(type, listener) { this.socket.addEventListener(type, listener); }
  removeEventListener(type, listener) { this.socket.removeEventListener(type, listener); }
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket handshake timed out')); }, WAIT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener('open', onOpen);
        this.removeEventListener('error', onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = event => { cleanup(); reject(event?.error || new Error('WebSocket handshake failed')); };
      this.addEventListener('open', onOpen);
      this.addEventListener('error', onError);
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  close() { this.socket.close(); }
}

export function waitForMessage(socket, predicate, label = 'message', { operationId, timeoutMs = WAIT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} timed out`)); }, timeoutMs);
    const onMessage = event => {
      const message = benchmarkMessage(event);
      if (!message) return;
      if (message.type === 'error' || (operationId && message.operationId === operationId && message.type.endsWith('.denied'))) {
        cleanup();
        return reject(new Error(`${label} rejected: ${JSON.stringify(message)}`));
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = event => { cleanup(); reject(event?.error || new Error(`${label} failed`)); };
    const onClose = () => { cleanup(); reject(new Error(`${label} socket closed`)); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

export async function startBenchmarkServer(root, { packageRoot = null, env = {}, nodeArgs = [] } = {}) {
  const mapDir = await mkdtemp(path.join(benchmarkTmpRoot, 'rpgmap-lan-benchmark-'));
  const serverPath = packageRoot ? path.join(packageRoot, 'server.mjs') : path.join(root, 'deployment', 'local-server', 'server.mjs');
  const child = spawn(process.execPath, [...nodeArgs, serverPath], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', RPGMAP_TEST_ALLOW_MISSING_ORIGIN: '1',
      RPGMAP_GM_SECRET: GM_SECRET, RPGMAP_JOIN_CODE: JOIN_CODE, RPGMAP_MAP_DIR: mapDir,
      RPGMAP_PUBLIC_DIR: packageRoot ? path.join(packageRoot, 'public') : mapDir, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (process.argv.includes('--debug')) process.stderr.write(chunk);
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error(`Server start timed out\n${stderr}`)), WAIT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const match = stdout.match(/Local\s+: http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}\n${stderr}`)); });
    });
    return { child, mapDir, sockets: [], serverPath, httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, stderr: () => stderr };
  } catch (error) {
    await stopBenchmarkServer({ child, mapDir });
    throw error;
  }
}

export async function stopBenchmarkServer(runtime) {
  for (const socket of runtime.sockets || []) socket.close();
  if (runtime.child.exitCode === null) {
    const exited = new Promise(resolve => runtime.child.once('exit', resolve));
    if (runtime.child.connected) runtime.child.send('rpgmap.shutdown');
    else runtime.child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (runtime.child.exitCode === null) { runtime.child.kill('SIGKILL'); await exited; }
  }
  // Delete only the absolute directory returned by this helper's mkdtemp.
  const relative = path.relative(benchmarkTmpRoot, path.resolve(runtime.mapDir));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(relative).startsWith('rpgmap-lan-benchmark-')) {
    throw new Error(`Refusing to remove unexpected benchmark directory: ${runtime.mapDir}`);
  }
  await rm(runtime.mapDir, { recursive: true, force: true });
}

export async function connectBenchmarkClient(runtime, schemas, hello) {
  const socket = new BenchmarkWebSocket(runtime.wsUrl);
  await socket.open();
  runtime.sockets.push(socket);
  const welcome = waitForMessage(socket, message => message.type === 'welcome', 'welcome');
  socket.send({ type: 'hello', capabilities: { occlusion: 1 }, ...hello, ...schemas, joinCode: JOIN_CODE });
  return { socket, welcome: await welcome };
}

export function summarizeLatency(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = quantile => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
  return { count: sorted.length, medianMs: Number(percentile(0.5).toFixed(3)), p95Ms: Number(percentile(0.95).toFixed(3)) };
}

export async function measureDocumentBatch(sender, recipients, request) {
  const { operationId } = request;
  const startedAt = performance.now();
  const acknowledged = waitForMessage(sender, message => message.type === 'document.batch.ack'
    && message.operationId === operationId, `${operationId} ACK`, { operationId })
    .then(message => ({ message, ms: performance.now() - startedAt }));
  const delivered = recipients.map((socket, index) => waitForMessage(socket,
    message => message.type === 'document.batch.committed' && message.operationId === operationId,
    `${operationId} recipient ${index + 1}`, { operationId })
    .then(message => ({ message, ms: performance.now() - startedAt })));
  let rejectFailure;
  const failed = new Promise((resolve, reject) => { rejectFailure = reject; });
  const onFailure = event => {
    const message = benchmarkMessage(event);
    if (!message) return;
    if (message.type === 'error') rejectFailure(new Error(`${operationId} fanout failed after submission: ${JSON.stringify(message)}`));
  };
  sender.addEventListener('message', onFailure);
  try {
    sender.send(request);
    const [ack, messages] = await Promise.race([Promise.all([acknowledged, Promise.all(delivered)]), failed]);
    return { ackMs: ack.ms, fanoutMs: Math.max(...messages.map(item => item.ms)), ack: ack.message,
      messages: messages.map(item => item.message) };
  } finally { sender.removeEventListener('message', onFailure); }
}
