import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw new Error('Browser performance benchmark requires Windows');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packageRoot = path.resolve(process.env.RPGMAP_BENCHMARK_PACKAGE
  || path.join(root, 'artifact', `RPGmap-v${packageJson.version}`));
const browserName = String(process.env.RPGMAP_BENCHMARK_BROWSER || 'edge').toLowerCase();
const headless = process.env.RPGMAP_BROWSER_BENCHMARK_HEADLESS === '1';
const phaseSeconds = Math.max(5, Number(process.env.RPGMAP_BROWSER_BENCHMARK_SECONDS) || 60);
const shouldAssert = process.argv.includes('--assert');
const GM_SECRET = 'BROWSER-BENCHMARK-GM';
const JOIN_CODE = '246810';
const ACTOR_COUNT = 100;
const TOKEN_COUNT = Math.max(1, Math.min(500, Number(process.env.RPGMAP_BROWSER_BENCHMARK_TOKENS) || 500));
const SESSION_COUNT = Math.max(1, Math.min(7, Number(process.env.RPGMAP_BROWSER_BENCHMARK_SESSIONS) || 7));
const WAIT_MS = 60_000;
const SETUP_WAIT_MS = 20_000;
const CDP_WAIT_MS = Math.max(10_000, Number(process.env.RPGMAP_BROWSER_BENCHMARK_CDP_TIMEOUT_MS) || 60_000);

function browserExecutable() {
  const override = process.env.RPGMAP_BENCHMARK_BROWSER_EXECUTABLE;
  if (override) {
    if (!existsSync(override)) throw new Error('Configured benchmark browser executable was not found');
    return path.resolve(override);
  }
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const suffixes = browserName === 'chrome'
    ? [['Google', 'Chrome', 'Application', 'chrome.exe']]
    : [['Microsoft', 'Edge', 'Application', 'msedge.exe']];
  for (const base of roots) for (const suffix of suffixes) {
    const candidate = path.join(base, ...suffix);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${browserName} executable was not found`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function retry(task, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await task();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

class JsonSocket {
  constructor(url) { this.socket = new WebSocket(url); }
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), WAIT_MS);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket open failed')); }, { once: true });
    });
  }
  send(value) { this.socket.send(JSON.stringify(value)); }
  wait(predicate, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} timed out`)); }, WAIT_MS);
      const message = event => {
        let value;
        try { value = JSON.parse(String(event.data)); } catch { return; }
        if (!predicate(value)) return;
        cleanup(); resolve(value);
      };
      const closed = () => { cleanup(); reject(new Error(`${label} socket closed`)); };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener('message', message);
        this.socket.removeEventListener('close', closed);
      };
      this.socket.addEventListener('message', message);
      this.socket.addEventListener('close', closed);
    });
  }
  close() { try { this.socket.close(); } catch {} }
}

function fixture(definitions) {
  const actors = Array.from({ length: ACTOR_COUNT }, (_, index) => ({
    id: `browser-actor-${index}`, name: `Browser Actor ${index}`, type: 'pc', partyId: 'browser-party',
    system: {}, effects: [], notes: '', ownership: {},
  }));
  const tokens = Array.from({ length: TOKEN_COUNT }, (_, index) => ({
    id: `browser-token-${index}`, actorId: `browser-actor-${index % ACTOR_COUNT}`,
    actorLink: true, actorDelta: null, placement: 'map',
    x: 2900 + (index % 25) * 2, y: 2500 + Math.floor(index / 25) * 2,
    featureId: null, diameterMeters: 1, rotation: 0, elevationMeters: 0,
    locked: false, showName: true, effects: [], controllerUserIds: [],
    visibility: { mode: 'party', userIds: [] },
    vision: { enabled: true, preciseRangeOverrideMeters: 80, vagueRangeOverrideMeters: 120, overrideUserIds: [] },
    movement: { mode: 'walk', budgetMetersPerTurn: null, spentMeters: 0, adjudicationRequired: false },
  }));
  const scene = {
    id: 'scene-northern-song-lanzhou-1104', name: 'Browser Performance Scene',
    mapPackage: { id: 'northern-song-lanzhou-1104', version: '1.1.0' },
    tokens, markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
    settings: { gridVisible: true, lineOfSightEnabled: false },
  };
  const world = {
    schemaVersion: 4, id: 'browser-performance-world', name: 'Browser Performance World',
    ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: scene.id,
    actors, statusDefinitions: definitions, scenes: [scene], journals: [], templateLibrary: {},
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    version: 2, mapId: scene.mapPackage.id, mapVersion: scene.mapPackage.version,
    markers: [], attackAreas: [], sceneEvents: [], preferences: {
      worldV2: world,
      entitySystem: { schemaVersion: 4, actors: structuredClone(actors), tokens: structuredClone(tokens), statusDefinitions: structuredClone(definitions) },
      combatSystem: { schemaVersion: 2, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  };
}

async function launchServer({ port, mapDir }) {
  const child = spawn(process.execPath, [path.join(packageRoot, 'server.mjs')], {
    cwd: packageRoot,
    env: {
      ...process.env, NODE_ENV: 'test', RPGMAP_TEST_ALLOW_MISSING_ORIGIN: '1',
      RPGMAP_GM_SECRET: GM_SECRET, RPGMAP_JOIN_CODE: JOIN_CODE,
      RPGMAP_MAP_DIR: mapDir, RPGMAP_PUBLIC_DIR: path.join(packageRoot, 'app'), PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await retry(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}: ${output.slice(-2000)}`);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
    return response?.ok;
  }, 'benchmark server');
  return { child, output: () => output };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise(resolve => server.child.once('exit', resolve));
  if (server.child.connected) server.child.send('rpgmap.shutdown', () => {});
  else server.child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

class BrowserSession {
  constructor({ index, name, role, credential, url, outputRoot }) {
    this.index = index; this.name = name; this.role = role; this.credential = credential;
    this.url = url; this.outputRoot = outputRoot; this.failures = []; this.exceptions = [];
  }
  async launch() {
    this.port = await reservePort();
    this.profile = await mkdtemp(path.join(os.tmpdir(), `rpgmap-browser-benchmark-${this.index}-`));
    this.process = spawn(browserExecutable(), [
      ...(headless ? ['--headless=new'] : []),
      '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
      '--window-size=1920,1080', `--window-position=${(this.index % 3) * 32},${Math.floor(this.index / 3) * 32}`,
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, this.url,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
    this.stderr = '';
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', chunk => { this.stderr += chunk; });
    const page = await retry(async () => {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      return (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl);
    }, `${this.name} CDP`);
    this.socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} CDP open timed out`)), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${this.name} CDP open failed`)); }, { once: true });
    });
    this.pending = new Map(); this.nextId = 1;
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else if (message.method === 'Network.loadingFailed' && message.params?.errorText !== 'net::ERR_ABORTED') {
        this.failures.push(message.params?.errorText || 'request failed');
      } else if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) >= 400) {
        this.failures.push(`${message.params.response.status} ${message.params.response.url}`);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || 'runtime exception');
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.exceptions.push((message.params.args || []).map(item => item.value ?? item.description ?? '').filter(Boolean).join(' ') || 'console error');
      }
    });
    await Promise.all([this.send('Runtime.enable'), this.send('Network.enable'), this.send('Log.enable')]);
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} ${method} timed out`)); }, CDP_WAIT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
    return result.result?.value;
  }
  async connect() {
    console.error(`[browser-benchmark] ${this.name} waiting for Runtime`);
    try {
      await retry(() => this.evaluate(`Boolean(document.querySelector('#app')?.rpgMapApp?.multiplayer)`), `${this.name} Runtime`);
    } catch (error) {
      const targets = await fetch(`http://127.0.0.1:${this.port}/json/list`).then(response => response.json()).catch(() => []);
      throw new Error(`${error.message}; process=${this.process?.exitCode}; targets=${JSON.stringify(targets.map(target => ({ type: target.type, url: target.url, title: target.title })))}; stderr=${this.stderr.slice(-2000)}`);
    }
    const connection = this.role === 'player'
      ? { name: this.name, requestedRole: 'player', joinCode: JOIN_CODE, playerKey: this.credential }
      : { name: this.name, requestedRole: 'gm', gmSecret: this.credential };
    console.error(`[browser-benchmark] ${this.name} submitting connection`);
    await this.evaluate(`document.querySelector('#app').rpgMapApp.multiplayer.connect(${JSON.stringify(connection)})`);
    console.error(`[browser-benchmark] ${this.name} connection submitted`);
    await retry(() => this.evaluate(`document.querySelector('#app').rpgMapApp.multiplayer.getStatus().connected === true`), `${this.name} connection`);
    const tokenId = `browser-token-${Math.max(0, this.index - 1)}`;
    if (this.role === 'player') {
      await retry(() => this.evaluate(`Boolean(document.querySelector('#app').rpgMapApp.tokens.get('${tokenId}'))`), `${this.name} Token projection`);
      await this.evaluate(`document.querySelector('#app').rpgMapApp.vision.setSource('${tokenId}')`);
    }
    await this.evaluate(`document.querySelector('#app').rpgMapApp.entities.openToken('${tokenId}')`);
    await retry(() => this.evaluate(`Boolean(document.querySelector('.entity-sheet-v3'))`), `${this.name} Actor sheet`);
    await this.evaluate(`(() => { const api=document.querySelector('#app').rpgMapApp; api.diagnostics.setEnabled(true); api.diagnostics.reset(); })()`);
  }
  async resetDiagnostics() {
    await this.evaluate(`document.querySelector('#app').rpgMapApp.diagnostics.reset()`);
  }
  async snapshot() {
    return this.evaluate(`document.querySelector('#app').rpgMapApp.diagnostics.snapshot()`);
  }
  async stimulateInput() {
    return this.evaluate(`(() => {
      const input = document.querySelector('.entity-sheet-v3 input:not([type="checkbox"]):not([type="radio"])');
      if (!input) return false;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }
  async screenshot(label) {
    const capture = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(this.outputRoot, `${label}-${this.name.replaceAll(' ', '-').toLowerCase()}.png`), Buffer.from(capture.data, 'base64'));
  }
  async close() {
    if (this.socket && this.pending) {
      try { await this.send('Browser.close'); } catch {}
      for (const pending of this.pending.values()) clearTimeout(pending.timer);
      this.pending.clear();
    }
    if (this.process?.exitCode === null) this.process.kill('SIGKILL');
    await rm(this.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
  }
}

function metric(snapshot, name) { return snapshot?.metrics?.[name] || null; }

function validatePhase(phase) {
  for (const session of phase.sessions) {
    const frame = metric(session.diagnostics, 'frame');
    const input = metric(session.diagnostics, 'input.frame');
    const longtask = metric(session.diagnostics, 'longtask');
    if (!frame || session.diagnostics.averageFps < 58 || frame.p95 > 20) {
      throw new Error(`${phase.name}/${session.name} frame gate failed: ${JSON.stringify({ fps: session.diagnostics.averageFps, frame })}`);
    }
    if (!input || input.p95 > 16.7) throw new Error(`${phase.name}/${session.name} input gate failed: ${JSON.stringify(input)}`);
    if (longtask?.max > 100) throw new Error(`${phase.name}/${session.name} long task gate failed: ${JSON.stringify(longtask)}`);
  }
  const confirms = phase.sessions.map(session => metric(session.diagnostics, 'network.confirm')).filter(Boolean);
  if (!confirms.length || Math.max(...confirms.map(value => value.p95)) > 60) {
    throw new Error(`${phase.name} network confirmation gate failed: ${JSON.stringify(confirms)}`);
  }
}

const port = await reservePort();
const mapDir = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-browser-performance-world-'));
const outputRoot = path.join(root, 'output', 'playwright', 'v2.4.0-seven-session');
await mkdir(outputRoot, { recursive: true });
let server = null;
let setupSocket = null;
const sessions = [];

try {
  server = await launchServer({ port, mapDir });
  console.error(`[browser-benchmark] server ready on ${port}`);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  const schemas = { operationSchema: health.operationSchema, statusSchema: health.statusSchema, accessSchema: health.accessSchema };
  setupSocket = new JsonSocket(`ws://127.0.0.1:${port}/ws`);
  await setupSocket.open();
  const welcome = setupSocket.wait(message => message.type === 'welcome', 'GM welcome');
  setupSocket.send({ type: 'hello', ...schemas, name: 'Benchmark Setup', requestedRole: 'gm', gmSecret: GM_SECRET, joinCode: JOIN_CODE });
  await welcome;
  console.error('[browser-benchmark] setup GM connected');
  const { INFINITE_HORROR_STATUS_DEFINITIONS } = await import(pathToFileURL(
    path.join(root, 'src', 'rulesets', 'infinite-horror', 'statuses.js'),
  ).href);
  const imported = setupSocket.wait(message => message.type === 'world.snapshot' && message.revision === 1, 'World import');
  setupSocket.send({ type: 'world.push', baseRevision: 0, state: fixture(INFINITE_HORROR_STATUS_DEFINITIONS), reason: 'file-import:browser-performance' });
  await imported;
  console.error(`[browser-benchmark] ${TOKEN_COUNT} Token World imported`);

  const playerKeys = [];
  for (let index = 0; index < SESSION_COUNT - 1; index += 1) {
    const claim = Promise.race([
      setupSocket.wait(message => message.type === 'access.claim', `Player ${index + 1} claim`),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Player ${index + 1} claim timed out`)), SETUP_WAIT_MS)),
    ]);
    const actorId = `browser-actor-${index}`;
    setupSocket.send({ type: 'access.user.create', name: `Browser Player ${index + 1}`, defaultActorId: actorId, ownership: { [actorId]: 'owner' } });
    playerKeys.push((await claim).claimCode);
    console.error(`[browser-benchmark] Player ${index + 1} identity created`);
  }
  setupSocket.close();
  setupSocket = null;
  await new Promise(resolve => setTimeout(resolve, 250));

  const baseUrl = `http://127.0.0.1:${port}/`;
  sessions.push(new BrowserSession({ index: 0, name: 'Browser GM', role: 'gm', credential: GM_SECRET,
    url: baseUrl, outputRoot }));
  playerKeys.forEach((credential, index) => sessions.push(new BrowserSession({
    index: index + 1, name: `Browser Player ${index + 1}`, role: 'player', credential, url: baseUrl, outputRoot,
  })));
  for (const session of sessions) {
    await session.launch();
    await session.connect();
    console.error(`[browser-benchmark] ${session.name} ready`);
  }
  console.error(`[browser-benchmark] ${SESSION_COUNT} browser session${SESSION_COUNT === 1 ? '' : 's'} connected`);
  await new Promise(resolve => setTimeout(resolve, 5000));
  console.error('[browser-benchmark] foreground sessions warmed up');

  async function runPhase(name, lineOfSightEnabled) {
    console.error(`[browser-benchmark] ${name} phase started (${phaseSeconds}s)`);
    const gm = sessions[0];
    await gm.evaluate(`document.querySelector('#app').rpgMapApp.world.performOperations([{
      type:'scene.settings.patch', payload:{sceneId:'scene-northern-song-lanzhou-1104',patch:{lineOfSightEnabled:${lineOfSightEnabled}}}
    }],{source:'benchmark:${name}'})`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await Promise.all(sessions.map(session => session.resetDiagnostics()));
    const started = performance.now();
    let step = 0;
    while (performance.now() - started < phaseSeconds * 1000) {
      const cycleStarted = performance.now();
      const session = sessions.length > 1 ? sessions[1 + (step % (sessions.length - 1))] : sessions[0];
      const tokenIndex = Math.max(0, session.index - 1);
      const tokenId = `browser-token-${tokenIndex}`;
      const x = 2900 + tokenIndex * 2;
      const y = 2500 + (step % 2 ? 0.5 : 0);
      await session.evaluate(`document.querySelector('#app').rpgMapApp.world.performOperations([{
        type:'token.move',payload:{sceneId:'scene-northern-song-lanzhou-1104',tokenId:'${tokenId}',placement:'map',x:${x},y:${y},movementMode:'walk'}
      }],{source:'benchmark:${name}'})`);
      await Promise.all(sessions.map(value => value.stimulateInput()));
      step += 1;
      const wait = Math.max(0, 500 - (performance.now() - cycleStarted));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    const measurements = await Promise.all(sessions.map(async session => ({
      name: session.name, diagnostics: await session.snapshot(), failures: session.failures, exceptions: session.exceptions,
    })));
    const phase = { name, seconds: phaseSeconds, operations: step, sessions: measurements };
    if (shouldAssert) validatePhase(phase);
    console.error(`[browser-benchmark] ${name} phase completed`);
    return phase;
  }

  const phases = [await runPhase('normal', false), await runPhase('los-light', true)];
  await sessions[0].screenshot('final');
  if (sessions[1]) await sessions[1].screenshot('final');

  const revisionsBefore = await Promise.all(sessions.map(session => session.evaluate(`document.querySelector('#app').rpgMapApp.multiplayer.getStatus().revision`)));
  const disconnectedAt = performance.now();
  await stopServer(server); server = null;
  await new Promise(resolve => setTimeout(resolve, 3000));
  server = await launchServer({ port, mapDir });
  await Promise.all(sessions.map(session => retry(
    () => session.evaluate(`document.querySelector('#app').rpgMapApp.multiplayer.getStatus().connected === true`),
    `${session.name} reconnect`, 10_000,
  )));
  const recoveredMs = performance.now() - disconnectedAt;
  const revisionsAfter = await Promise.all(sessions.map(session => session.evaluate(`document.querySelector('#app').rpgMapApp.multiplayer.getStatus().revision`)));
  const recovery = { outageDelayMs: 3000, recoveredMs, revisionsBefore, revisionsAfter };
  if (shouldAssert && recoveredMs > 13_000) throw new Error(`Reconnect gate failed: ${recoveredMs}ms including the 3 second outage`);
  if (shouldAssert && revisionsBefore.some((value, index) => value !== revisionsAfter[index])) {
    throw new Error(`Reconnect changed revision without an operation: ${JSON.stringify(recovery)}`);
  }
  for (const session of sessions) {
    if (session.failures.length || session.exceptions.length) {
      throw new Error(`${session.name} browser errors: ${JSON.stringify({ failures: session.failures, exceptions: session.exceptions })}`);
    }
  }
  const report = {
    version: packageJson.version, browser: browserName, headless, browserExecutable: browserExecutable(),
    fixture: { sessions: SESSION_COUNT, actors: ACTOR_COUNT, tokens: TOKEN_COUNT, viewport: '1920x1080' },
    phases, recovery, generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  setupSocket?.close();
  await Promise.allSettled(sessions.map(session => session.close()));
  await stopServer(server);
  await rm(mapDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
}
