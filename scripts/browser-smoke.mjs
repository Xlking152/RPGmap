import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runRuinsBrowserSmoke } from './ruins-browser-smoke.mjs';
import { runLocalBrowserPerformance } from './local-browser-performance.mjs';
import { createPackagedOfflineServer, openPersistentOfflineRuntime } from './ruins-offline-browser-support.mjs';
import { benchmarkBuildInfo } from './lan-benchmark-support.mjs';
import { closeOwnedBrowser } from './owned-browser-close.mjs';
import { cdpCommandEnvelope, proveLiveValidationWorker } from './live-validation-worker-proof.mjs';

if (process.platform !== 'win32') throw new Error('Packaged browser smoke requires Windows');
const browserName = String(process.env.RPGMAP_SMOKE_BROWSER || 'edge').toLowerCase();
if (!['edge', 'chrome'].includes(browserName)) throw new Error(`Unsupported smoke browser: ${browserName}`);
const targetUrl = String(process.argv[2] || '').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/?/.test(targetUrl)) throw new Error('Browser smoke requires a loopback HTTP URL');
const timeoutMs = Math.max(10_000, Number(process.argv[3]) || 30_000);
const mode = String(process.argv[4] || 'bootstrap');
if (!['bootstrap', 'fog'].includes(mode)) throw new Error(`Unknown browser smoke mode: ${mode}`);
const packageRoot = String(process.argv[5] || '').trim();
if (!packageRoot) throw new Error('Browser smoke requires the actual served package directory');
const buildInfo = await benchmarkBuildInfo(process.cwd(), path.resolve(packageRoot));
const hostedPerformanceObservation = buildInfo.metadata.version === '2.5.5'
  && process.env.RPGMAP_SMOKE_HOSTED_PERFORMANCE_OBSERVATION === '1';
const versionResponse = await fetch(new URL('/api/version', targetUrl), { cache: 'no-store' });
if (!versionResponse.ok || !isDeepStrictEqual(await versionResponse.json(), buildInfo.metadata)) {
  throw new Error('Browser smoke server version does not match the actual package');
}
const viewportMatch = /^(\d{2,4})x(\d{2,4})$/.exec(String(process.env.RPGMAP_SMOKE_VIEWPORT || ''));

function edgePath() {
  const override = process.env.RPGMAP_SMOKE_BROWSER_EXECUTABLE;
  if (override) {
    if (!existsSync(override)) throw new Error('Configured smoke browser executable was not found');
    return path.resolve(override);
  }
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const suffixes = browserName === 'chrome'
    ? [['Google', 'Chrome', 'Application', 'chrome.exe'], ['Google', 'Chrome Beta', 'Application', 'chrome.exe']]
    : [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Microsoft', 'Edge SxS', 'Application', 'msedge.exe']];
  for (const root of roots) {
    for (const suffix of suffixes) {
      const candidate = path.join(root, ...suffix);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  throw new Error(`${browserName === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} executable was not found`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function retry(task, label, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await task();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

const port = await reservePort();
const profile = await mkdtemp(path.join(os.tmpdir(), `rpgmap-${browserName}-smoke-`));
const edge = spawn(edgePath(), [
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let edgeError = '';
edge.stderr.setEncoding('utf8');
edge.stderr.on('data', chunk => { edgeError += chunk; });
let browserClosed = false;
let socket;
let offlineServer = null;

try {
  const deadline = Date.now() + timeoutMs;
  const page = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const pages = await response.json();
    return pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'Edge CDP endpoint', deadline);

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Edge CDP WebSocket open timed out')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Edge CDP WebSocket failed')); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const failures = [];
  const exceptions = [];
  const responses = [];
  let resolveTraceCompletion = null;
  const rejectPending = message => {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(new Error(message));
    }
    pending.clear();
  };
  socket.addEventListener('close', () => rejectPending('Edge CDP WebSocket closed'));
  socket.addEventListener('error', () => rejectPending('Edge CDP WebSocket failed'));
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timeout } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Network.loadingFailed' && message.params?.errorText !== 'net::ERR_ABORTED') {
      failures.push(message.params?.errorText || 'request failed');
    }
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) >= 400) {
      failures.push(`${message.params.response.status} ${message.params.response.url}`);
    }
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) < 400) {
      responses.push(String(message.params.response.url || ''));
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params?.exceptionDetails?.text || 'runtime exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const rendered = (message.params.args || []).map(argument => (
        argument.value ?? argument.unserializableValue ?? argument.description ?? ''
      )).filter(Boolean).join(' ');
      exceptions.push(rendered || 'browser console error');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      exceptions.push(message.params.entry.text || 'browser log error');
    }
    if (message.method === 'Tracing.tracingComplete') {
      resolveTraceCompletion?.(message.params);
      resolveTraceCompletion = null;
    }
  });
  const send = (method, params = {}, commandTimeoutMs = 5000, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Edge CDP command timed out: ${method}`));
    }, commandTimeoutMs);
    pending.set(id, { resolve, reject, timeout });
    try { socket.send(JSON.stringify(cdpCommandEnvelope(id, method, params, sessionId))); }
    catch (error) { pending.delete(id); clearTimeout(timeout); reject(error); }
  });
  const evaluate = async (expression, commandTimeoutMs) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, commandTimeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result?.value;
  };
  await Promise.all([send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);
  if (viewportMatch) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(viewportMatch[1]), height: Number(viewportMatch[2]),
      deviceScaleFactor: 1, mobile: true,
    });
  }
  // Attach observers before navigation so cached/fast dynamic imports cannot
  // finish before Network.enable and disappear from the package asset audit.
  // Cold navigation shares the declared startup deadline. The generic 5 s
  // command limit must not cut that deadline short on a fresh Chrome profile.
  const initialNavigationBudget = deadline - Date.now();
  if (initialNavigationBudget <= 0) throw new Error('Browser startup deadline exceeded before navigation');
  await send('Page.navigate', { url: targetUrl }, initialNavigationBudget);

  if (mode === 'bootstrap') {
    const entryState = await retry(
      () => evaluate(`(() => {
        if (document.querySelector('[data-world-create-form]') && document.body.innerText.includes('北宋兰州城')) return 'manager';
        if (document.querySelector('#app')?.rpgMapApp && document.querySelector('.leaflet-container')) return 'runtime';
        return null;
      })()`),
      'World Manager with built-in Lanzhou metadata',
      deadline,
    );
    if (entryState === 'manager') {
      await evaluate(`(() => {
        const form = document.querySelector('[data-world-create-form]');
        form.querySelector('[name="name"]').value = 'Packaged Smoke World';
        form.requestSubmit();
        return true;
      })()`);
    }
  }
  let runtime;
  try {
    runtime = await retry(
      () => evaluate(`(() => {
        const api = document.querySelector('#app')?.rpgMapApp;
        const baseSvg = document.querySelector('.leaflet-base-pane svg.leaflet-image-layer');
        const bounds = baseSvg?.getBoundingClientRect();
        let center = null;
        let zoom = null;
        try {
          center = api?.map?.getCenter?.() || null;
          zoom = api?.map?.getZoom?.();
        } catch {}
        return {
          leaflet: Boolean(document.querySelector('.leaflet-container')),
          title: document.querySelector('[data-role="app-title"]')?.textContent || '',
          mapReady: Boolean(center) && Number.isFinite(zoom),
          baseSvg: Boolean(baseSvg),
          baseSvgWidth: bounds?.width || 0,
          baseSvgHeight: bounds?.height || 0,
          mapImages: baseSvg?.querySelectorAll('image').length || 0,
          rulesetId: api?.ruleset?.id || '',
        };
      })()`).then(value => value?.leaflet
        && value.title.includes('北宋兰州城')
        && value.rulesetId === 'infinite-horror'
        && value.mapReady
        && value.baseSvg
        && value.baseSvgWidth > 0
        && value.baseSvgHeight > 0
        && value.mapImages > 0
        ? value
        : null),
      'Lanzhou Leaflet Runtime',
      deadline,
    );
  } catch (error) {
    const pageState = await evaluate(`({
      title: document.title,
      boot: document.querySelector('[data-rpgmap-boot-status]')?.textContent || '',
      body: document.body.innerText.slice(0, 2000),
      leaflet: Boolean(document.querySelector('.leaflet-container')),
      features: document.querySelectorAll('[data-feature-id]').length,
    })`).catch(() => null);
    throw new Error(`${error.message}; page=${JSON.stringify(pageState)}; requests=${JSON.stringify(failures)}; errors=${JSON.stringify(exceptions)}`);
  }
  let fogAudit = null;
  if (mode === 'fog') {
    await retry(() => evaluate(`(() => {
        const api = document.querySelector('#app')?.rpgMapApp;
        return { connected: api?.multiplayer?.getStatus?.()?.connected === true, token: Boolean(api?.tokens?.get?.('smoke-pc-token')) };
      })()`).then(status => status?.connected && status?.token ? status : null),
    'LAN Runtime with smoke Token', deadline);
    await evaluate(`document.querySelector('#app').rpgMapApp.vision.setSource('smoke-pc-token')`);
    await evaluate(`document.querySelector('#app').rpgMapApp.selection.replace(['smoke-pc-token'], 'smoke-pc-token')`);
    fogAudit = await retry(() => evaluate(`(() => {
        const canvas = document.querySelector('.rpgmap-vision-fog-perception');
        if (!canvas || canvas.hidden || !canvas.width || !canvas.height) return null;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let minAlpha = 255, maxAlpha = 0;
        for (let index = 3; index < data.length; index += 4) {
          minAlpha = Math.min(minAlpha, data[index]);
          maxAlpha = Math.max(maxAlpha, data[index]);
        }
        return maxAlpha > 200 && minAlpha < 200 ? { width: canvas.width, height: canvas.height, minAlpha, maxAlpha } : null;
      })()`), 'Fog Canvas with opaque and realtime-visible pixels', deadline);
  }
  let movementAudit = null;
  if (mode === 'fog' && process.env.RPGMAP_SMOKE_CPU_PROFILE) {
    await send('Profiler.enable');
    await send('Profiler.start');
  }
  if (mode === 'fog') {
    movementAudit = await evaluate(`(async () => {
      const api = document.querySelector('#app').rpgMapApp;
      let id = 'smoke-pc-token';
      const lanFixture = { token: api.tokens.get(id) };
      lanFixture.actor = api.tokens.getActor(lanFixture.token?.actorId);
      if (!lanFixture.token || !lanFixture.actor) throw new Error('LAN movement fixture is incomplete');
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const records = [];
      for (const mode of ['lan', 'offline']) {
        if (mode === 'offline') {
          api.multiplayer.disconnect();
          if (!api.isLocalWorldActive() || api.multiplayer.getStatus().retainsServerState
            || api.tokens.get('smoke-pc-token')) throw new Error('Disconnect did not restore the independent offline World');
          // LAN is a temporary projection. Create a fresh local fixture through
          // the normal authoritative APIs after the saved offline World returns.
          const actor = { ...structuredClone(lanFixture.actor), id: 'smoke-offline-pc',
            name: 'Offline Smoke Scout', partyId: 'smoke-offline-party' };
          const sceneId = api.world.getActiveScene().id;
          await api.world.performOperations([
            { type: 'actor.upsert', payload: { actor } },
            { type: 'scene.settings.patch', payload: { sceneId,
              patch: { lineOfSightEnabled: true, movementBudgetMetersPerTurn: null } } },
          ], { source: 'browser-smoke:offline-fixture' });
          id = 'smoke-offline-pc-token';
          await api.tokens.create({ id, actorId: actor.id, actorLink: true,
            x: lanFixture.token.x, y: lanFixture.token.y,
            diameterMeters: lanFixture.token.diameterMeters, elevationMeters: lanFixture.token.elevationMeters,
            vision: structuredClone(lanFixture.token.vision) });
          await api.vision.setSource(id);
          api.selection.replace([id], id);
        }
        const origin = api.tokens.get(id);
        const mid = { x: origin.x + 2, y: origin.y };
        const end = { x: origin.x + 4, y: origin.y };
        const result = await api.movementFast.moveTokenPath([id], id, [mid, end]);
        if (!result.valid) throw new Error(mode + ' move rejected: ' + result.reason);
        api.renderer.renderTokens();
        await wait(50);
        // Returning to a waypoint of an active animation must supersede its old endpoint.
        const back = await api.movementFast.moveTokenTo(id, mid);
        if (!back.valid) throw new Error(mode + ' return rejected: ' + back.reason);
        api.renderer.renderTokens();
        await wait(1500);
        const canonical = api.tokens.get(id);
        const visual = api.renderer.getVisualTokenPoint(id);
        if (canonical.x !== mid.x || canonical.y !== mid.y
          || Math.abs(visual.x - canonical.x) > 0.001 || Math.abs(visual.y - canonical.y) > 0.001) {
          throw new Error(mode + ' Token snapped back: ' + JSON.stringify({ mid, canonical, visual }));
        }
        records.push({ mode, tokenId: id, origin: { x: origin.x, y: origin.y }, canonical: { x: canonical.x, y: canonical.y }, visual });
      }
      await api.vision.setSource(null);
      let largeOrigin, largeDestination;
      for (const start of [{ x: 500.5, y: 500.5 }, { x: 1000.5, y: 500.5 }, { x: 500.5, y: 4000.5 }]) {
        const end = { x: start.x + 425, y: start.y };
        if (api.inspectTokenPlacement(id, start).valid && api.movementFast.inspectTokenMove(id, end, { from: start }).valid) {
          largeOrigin = start; largeDestination = end; break;
        }
      }
      if (!largeOrigin) throw new Error('No clear 425 m route in smoke fixture');
      await api.tokens.reposition(id, largeOrigin);
      await wait(1000);
      await api.tokens.update(id, { vision: { ...api.tokens.get(id).vision,
        preciseRangeOverrideMeters: 1000, vagueRangeOverrideMeters: 1000 } });
      await api.vision.setSource(id);
      const diagnosticsInitiallyEnabled = api.diagnostics?.enabled === true;
      if (${process.env.RPGMAP_SMOKE_PROFILE_API ? 'true' : 'false'}) {
        api.diagnostics?.setEnabled?.(true);
        api.diagnostics?.reset?.();
      }
      const frameGaps = [];
      const longTasks = [];
      const apiTimings = {};
      const restoreApi = [];
      if (${process.env.RPGMAP_SMOKE_PROFILE_API ? 'true' : 'false'}) {
        for (const [object, name, label] of [
          [api, 'getState', 'state.read'], [api.world, 'get', 'world.read'],
          [api.world, 'getActiveScene', 'scene.read'], [api.world, 'performOperations', 'world.operation'],
          [api.tokens, 'get', 'token.read'], [api.tokens, 'create', 'token.create'],
          [api, 'applyAuthoritativeDocumentChanges', 'document.apply'], [api, 'persistNow', 'state.persist'],
        ]) {
          if (typeof object?.[name] !== 'function') continue;
          const original = object[name];
          object[name] = function(...args) {
            const begin = performance.now();
            const record = () => {
              const timing = apiTimings[label] ||= { calls: 0, totalMs: 0, maxMs: 0, events: [] };
              const elapsed = performance.now() - begin;
              timing.calls += 1; timing.totalMs += elapsed; timing.maxMs = Math.max(timing.maxMs, elapsed);
              timing.events.push({ offsetMs: Math.round(begin - measuredFrom), durationMs: Math.round(elapsed) });
            };
            try {
              const result = original.apply(this, args);
              if (result && typeof result.then === 'function') return result.finally(record);
              record(); return result;
            } catch (error) { record(); throw error; }
          };
          restoreApi.push(() => { object[name] = original; });
        }
      }
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))));
      observer.observe({ type: 'longtask', buffered: false });
      const measuredFrom = performance.now();
      const phases = [];
      let previousFrame = performance.now(), frame;
      const tick = time => { frameGaps.push(time - previousFrame); previousFrame = time; frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
      try {
        const original = api.tokens.get(id);
        const start = performance.now();
        const placed = await api.tokens.create({ actorId: original.actorId, x: original.x, y: original.y,
          actorLink: true, diameterMeters: 1, elevationMeters: 0 });
        while (!api.renderer.getVisualTokenPoint(placed.id) && performance.now() - start < 2000) await wait(16);
        const placementMs = performance.now() - start;
        phases.push({ name: 'placement', start, end: performance.now() });
        if (!api.renderer.getVisualTokenPoint(placed.id) || placementMs > 500) throw new Error('Large-vision placement stalled: ' + placementMs);
        const destination = largeDestination;
        const moveStart = performance.now();
        const result = await api.movementFast.moveTokenTo(id, destination);
        const commitMs = performance.now() - moveStart;
        phases.push({ name: 'movement-commit', start: moveStart, end: performance.now() });
        if (!result.valid || commitMs > 500) throw new Error('Large-vision movement stalled: ' + JSON.stringify({ result, commitMs }));
        await wait(4000);
        const visual = api.renderer.getVisualTokenPoint(id);
        const canonical = api.tokens.get(id);
        if (Math.hypot(visual.x - destination.x, visual.y - destination.y) > 0.001
          || canonical.x !== destination.x || canonical.y !== destination.y) throw new Error('425 m route did not settle');
        const maxFrameGapMs = Math.max(...frameGaps);
        if (maxFrameGapMs > 250) throw new Error('Large-vision main thread blocked: ' + maxFrameGapMs);
        longTasks.push(...observer.takeRecords().map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
        const measuredTasks = longTasks.filter(entry => entry.startTime >= measuredFrom);
        records.push({ mode: 'offline-large-range', rangeMeters: 1000, distanceMeters: 425, placementMs, commitMs, maxFrameGapMs,
          longTaskMs: measuredTasks.reduce((sum, entry) => sum + entry.duration, 0), longTaskCount: measuredTasks.length,
          longTaskDetails: measuredTasks.map(entry => ({ offsetMs: Math.round(entry.startTime - measuredFrom),
            durationMs: Math.round(entry.duration), phase: phases.find(phase => entry.startTime >= phase.start && entry.startTime < phase.end)?.name || 'settle' })),
          preWindowLongTasks: longTasks.filter(entry => entry.startTime < measuredFrom).map(entry => ({
            offsetMs: Math.round(entry.startTime - measuredFrom), durationMs: Math.round(entry.duration) })),
          heapBytes: performance.memory?.usedJSHeapSize || null, diagnostics: api.diagnostics?.snapshot?.(),
          ...(restoreApi.length ? { apiTimings } : {}) });
      } finally { cancelAnimationFrame(frame); observer.disconnect(); for (const restore of restoreApi) restore();
        if (${process.env.RPGMAP_SMOKE_PROFILE_API ? 'true' : 'false'}) {
          api.diagnostics?.setEnabled?.(diagnosticsInitiallyEnabled);
          const runtimeState = api.getState(), exportedState = api.exportState();
          const different = [];
          const compare = (a, b, path = '') => {
            if (different.length >= 12 || Object.is(a, b)) return;
            if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
              different.push(path || '(root)'); return;
            }
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], path + '/' + key);
          };
          compare(runtimeState, exportedState);
          records.at(-1).saveCompare = { different,
            runtimeBytes: JSON.stringify(runtimeState).length, exportBytes: JSON.stringify(exportedState).length };
        } }
      return records;
    })()`, 20000);
  }
  if (mode === 'fog' && process.env.RPGMAP_SMOKE_CPU_PROFILE) {
    const { profile: cpuProfile } = await send('Profiler.stop');
    await writeFile(process.env.RPGMAP_SMOKE_CPU_PROFILE, JSON.stringify(cpuProfile));
  }
  let occlusionAudit = null;
  let ruinsAudit = null;
  if (mode === 'fog' && await evaluate(`Boolean(document.querySelector('#app').rpgMapApp.occlusionEditor)`)) {
    const zoomRecords = [];
    for (const dpr of [1, 1.25, 1.5, 2]) {
      await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 720, deviceScaleFactor: dpr, mobile: false });
      const result = await evaluate(`(async () => {
        const api = document.querySelector('#app').rpgMapApp;
        const source = api.vision.getVisibleRegion();
        if (!source) throw new Error('occlusion audit needs a vision source');
        api.map.invalidateSize({ animate: false });
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        let maxProjectionError = 0, maxCenterAlpha = 0;
        const verifyViewportLabels = () => {
          const svg = document.querySelector('.leaflet-base-pane svg.leaflet-image-layer');
          const scale = svg.getBoundingClientRect().width / api.mapPackage.width;
          const expectedTier = scale <= 0.24 ? 'overview' : scale <= 0.52 ? 'mid' : 'detail';
          if (svg.dataset.zoomTier !== expectedTier) throw new Error('Viewport label tier did not follow zoom/resize: ' + JSON.stringify({
            zoom: api.map.getZoom(), actual: svg.dataset.zoomTier, expected: expectedTier }));
          if (!document.querySelector('.leaflet-grid-pane path.grid-minor')) throw new Error('Viewport grid is missing');
        };
        for (let zoom = -4; zoom <= 5; zoom += 0.25) {
          api.map.setView([api.mapPackage.height - source.y, source.x], zoom, { animate: false });
          await frame(); await frame(); api.vision.render(); await frame();
          verifyViewportLabels();
          const canvas = document.querySelector('.rpgmap-vision-fog-perception');
          const point = api.map.latLngToContainerPoint([api.mapPackage.height - source.y, source.x]);
          const ratio = canvas.width / api.map.getSize().x;
          const alpha = canvas.getContext('2d').getImageData(Math.round(point.x * ratio), Math.round(point.y * ratio), 1, 1).data[3];
          maxCenterAlpha = Math.max(maxCenterAlpha, alpha);
          if (alpha > 12) throw new Error('source becomes fog at zoom=' + zoom + ', alpha=' + alpha);
          const pixel = api.map.project([api.mapPackage.height - source.y, source.x], zoom);
          const origin = api.map.getPixelOrigin();
          const exact = api.map.layerPointToContainerPoint([pixel.x - origin.x, pixel.y - origin.y]);
          maxProjectionError = Math.max(maxProjectionError, Math.abs(exact.x - point.x), Math.abs(exact.y - point.y));
        }
        api.map.panBy([47, -31], { animate: false }); await frame(); api.vision.render(); await frame();
        verifyViewportLabels();
        api.map.fitBounds([[api.mapPackage.height - source.y - 200, source.x - 200],
          [api.mapPackage.height - source.y + 200, source.x + 200]], { animate: false });
        await frame(); api.vision.render(); await frame();
        if (maxProjectionError > 1) throw new Error('projection error exceeds one CSS pixel');
        let animations = 0, maxAnimationError = 0;
        const observed = () => { animations++; };
        api.map.on('zoomanim', observed);
        api.map.setZoom(api.map.getZoom()+0.5, { animate:true });
        const started = performance.now();
        while (performance.now()-started < 600) {
          await frame();
          const canvas = document.querySelector('.rpgmap-vision-fog-perception');
          const matrix = new DOMMatrix(getComputedStyle(canvas).transform);
          const pixel = api.map.project([api.mapPackage.height-source.y,source.x],api.map.getZoom());
          const origin = api.map.getPixelOrigin();
          const old = api.map.layerPointToContainerPoint([pixel.x-origin.x,pixel.y-origin.y]);
          const container = api.map.getContainer().getBoundingClientRect();
          const pane = canvas.parentElement.getBoundingClientRect();
          const actual = { x:matrix.a*old.x+matrix.e+pane.left-container.left,
            y:matrix.d*old.y+matrix.f+pane.top-container.top };
          const image = document.querySelector('.leaflet-base-pane svg.leaflet-image-layer').getBoundingClientRect();
          const expected = { x:image.left-container.left+source.x/api.mapPackage.width*image.width,
            y:image.top-container.top+source.y/api.mapPackage.height*image.height };
          maxAnimationError = Math.max(maxAnimationError,Math.abs(actual.x-expected.x),Math.abs(actual.y-expected.y));
        }
        api.map.off('zoomanim', observed);
        if (maxAnimationError > 1) throw new Error('animated mask leaves map image by ' + maxAnimationError + ' CSS pixels');
        return { dpr: devicePixelRatio, zoomLevels: 37, maxCenterAlpha, maxProjectionError, animations, maxAnimationError };
      })()`, 15000);
      zoomRecords.push(result);
    }
    const editor = await evaluate(`(async () => {
      const api = document.querySelector('#app').rpgMapApp;
      const original = structuredClone(api.world.getActiveScene().occlusionShapes || []);
      await api.occlusionEditor.open();
      document.querySelector('[data-occlusion-mode=wall]').click();
      for (const [x,y] of [[1100,1100],[1110,1100],[1110,1170],[1100,1170]])
        api.map.fire('click', { latlng: { lat: api.mapPackage.height-y, lng:x }, originalEvent: { target:api.map.getContainer() } });
      const finish = [...document.querySelectorAll('button')].find(button => button.textContent === '完成多边形');
      if (!finish) throw new Error('draw finish control missing'); finish.click();
      const before = api.occlusionEditor.getPreviewScene(api.world.getActiveScene()).occlusionShapes.length;
      document.querySelector('[data-occlusion-undo]').click();
      const undone = api.occlusionEditor.getPreviewScene(api.world.getActiveScene()).occlusionShapes.length;
      document.querySelector('[data-occlusion-redo]').click();
      if (before !== original.length + 1 || undone !== original.length) throw new Error('editor undo/redo failed');
      await api.occlusionEditor.commit(); api.occlusionEditor.close();
      const shape = api.world.getActiveScene().occlusionShapes.find(item => !original.some(old => old.id === item.id));
      if (!shape || shape.points.length !== 4) throw new Error('shape did not persist');
      await api.occlusionEditor.open();
      if (!document.querySelector('[data-occlusion-shape="' + shape.id + '"]')) throw new Error('shape did not reload in editor');
      api.occlusionEditor.close();
      await api.world.performOperations([{ type:'scene.occlusionShape.delete', payload:{sceneId:api.world.get().activeSceneId,shapeId:shape.id} }]);
      return { drew:true, undoRedo:true, committed:true, reopened:true };
    })()`, 10000);
    const feedbackProfilePath = process.env.RPGMAP_SMOKE_FEEDBACK_CPU_PROFILE;
    const feedbackTracePath = process.env.RPGMAP_SMOKE_FEEDBACK_TRACE;
    const traceCompletion = feedbackTracePath
      ? new Promise(resolve => { resolveTraceCompletion = resolve; }) : null;
    if (feedbackTracePath) {
      await send('Tracing.start', { categories: [
        'devtools.timeline', 'disabled-by-default-devtools.timeline',
        'blink.user_timing', 'toplevel', 'v8',
      ].join(','), transferMode: 'ReturnAsStream' });
    }
    if (feedbackProfilePath) {
      await send('Profiler.enable');
      await send('Profiler.start');
    }
    let feedback;
    let feedbackError;
    try {
      feedback = await evaluate(`(async () => {
      const api = document.querySelector('#app').rpgMapApp;
      const id = 'smoke-offline-pc-token';
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const traceMarks = ${Boolean(feedbackTracePath)};
      const observeFeedback = ${Boolean(feedbackTracePath || process.env.RPGMAP_SMOKE_FEEDBACK_OBSERVE)};
      const initialDiagnostics = api.diagnostics.enabled;
      api.diagnostics.setEnabled(true);
      const results = [];
      try {
        for (const range of [120, 500, 1000]) {
          await api.tokens.update(id, { vision: { ...api.tokens.get(id).vision,
            preciseRangeOverrideMeters: range, vagueRangeOverrideMeters: range } });
          await api.vision.setSource(id); await wait(500);
          const activeRegion = api.vision.getVisibleRegion();
          if (Math.abs(Number(activeRegion?.preciseRangeMeters) - range) > 0.001
            || Math.abs(Number(activeRegion?.vagueRangeMeters) - range) > 0.001) {
            throw new Error('vision range override was not applied: ' + JSON.stringify({ range, activeRegion }));
          }
          api.diagnostics.reset();
          const origin = api.tokens.get(id), totalMs = [], samples = [];
          for (let index = 0; index < 20; index++) {
            const previousVisual = api.renderer.getVisualTokenPoint(id) || api.tokens.get(id);
            const target = { x: origin.x + (index % 2 ? 0.75 : 0.25), y: origin.y };
            const started = performance.now();
            if (traceMarks) performance.mark('feedback.' + range + '.' + index + '.start');
            const queueBefore = api.world.getExplorationStatus();
            await api.tokens.reposition(id, target);
            const committedAt = performance.now();
            const expectedRevision = api.getStateRevision();
            if (traceMarks) performance.mark('feedback.' + range + '.' + index + '.commit');
            const matchesMovement = state => state?.rendered && state.stateRevision >= expectedRevision
              && state.requestedAt >= started
              && Number(state.source?.x) >= Math.min(previousVisual.x, target.x) - 0.001
              && Number(state.source?.x) <= Math.max(previousVisual.x, target.x) + 0.001
              && Number(state.source?.y) >= Math.min(previousVisual.y, target.y) - 0.001
              && Number(state.source?.y) <= Math.max(previousVisual.y, target.y) + 0.001;
            const compactFeedback = state => state && ({ requestedAt: state.requestedAt,
              stateRevision: state.stateRevision, rendered: state.rendered,
              x: state.source?.x, y: state.source?.y });
            let feedbackState = api.vision.getFeedbackState();
            const observedFeedbackStates = [];
            let previousFeedbackKey = null;
            while (!matchesMovement(feedbackState)) {
              if (observeFeedback && observedFeedbackStates.length < 16) {
                const key = JSON.stringify(compactFeedback(feedbackState));
                if (key !== previousFeedbackKey) {
                  observedFeedbackStates.push({ offsetMs: performance.now() - started, state: compactFeedback(feedbackState) });
                  previousFeedbackKey = key;
                }
              }
              if (performance.now() - started > 2000) throw new Error('realtime mask did not complete: ' + JSON.stringify({
                range, index, elapsedMs: performance.now() - started, expectedRevision,
                previousVisual, target, feedbackState: compactFeedback(feedbackState), observedFeedbackStates,
                token: api.tokens.get(id), visual: api.renderer.getVisualTokenPoint(id),
                region: api.vision.getVisibleRegion(), exploration: api.world.getExplorationStatus(),
                diagnostic: api.diagnostics.snapshot(), samples,
              }));
              await wait(1);
              feedbackState = api.vision.getFeedbackState();
            }
            const completedAt = performance.now();
            if (traceMarks) performance.mark('feedback.' + range + '.' + index + '.visible');
            totalMs.push(completedAt - started);
            samples.push({ index, totalMs: completedAt - started, commitMs: committedAt - started,
              maskWaitMs: completedAt - committedAt,
              previousVisual: { x: previousVisual.x, y: previousVisual.y }, target,
              expectedRevision, feedbackState: compactFeedback(feedbackState),
              ...(observeFeedback ? { observedFeedbackStates } : {}),
              queueBefore, queueAfter: api.world.getExplorationStatus() });
          }
          totalMs.sort((a,b) => a-b);
          const diagnostic = api.diagnostics.snapshot();
          const queueSerializedBytesAtRangeEnd = new Blob([JSON.stringify(api.getLocalExploration())]).size;
          const p95Ms = totalMs[18];
          if (!${hostedPerformanceObservation} && p95Ms > (range === 1000 ? 100 : 50)) throw new Error('realtime feedback latency failed: ' + JSON.stringify({range,p95Ms,totalMs,samples,diagnostic,queueSerializedBytesAtRangeEnd}));
          results.push({rangeMeters:range, effectiveRangeMeters:activeRegion.preciseRangeMeters,
            samplesMs:totalMs, phases:samples, p95Ms, queueSerializedBytesAtRangeEnd,
            mask:diagnostic.metrics['vision.feedback'], worker:diagnostic.metrics['vision.worker'],
            transferBytes:diagnostic.metrics['vision.transferBytes'], queue:diagnostic.metrics['vision.queue']});
        }
        // Inspect every animation frame on a separate short round trip. Canvas
        // readback is a correctness check and must not alter feedback timing.
        const blackFlashOrigin = api.tokens.get(id);
        let maxCenterAlpha = 0, inspectedFrames = 0;
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        for (const x of [blackFlashOrigin.x + 0.25, blackFlashOrigin.x - 0.25]) {
          const until = performance.now() + 350;
          const monitor = (async () => {
            while (performance.now() < until) {
              await frame();
              const visual = api.renderer.getVisualTokenPoint(id) || api.tokens.get(id);
              const point = api.map.latLngToContainerPoint([api.mapPackage.height - visual.y, visual.x]);
              const canvas = document.querySelector('.rpgmap-vision-fog-perception');
              const ratio = canvas.width / api.map.getSize().x;
              const alpha = canvas.getContext('2d').getImageData(Math.round(point.x * ratio), Math.round(point.y * ratio), 1, 1).data[3];
              maxCenterAlpha = Math.max(maxCenterAlpha, alpha);
              inspectedFrames++;
            }
          })();
          await api.tokens.reposition(id, { x, y: blackFlashOrigin.y });
          await monitor;
        }
        if (maxCenterAlpha > 12) throw new Error('continuous movement replaced completed mask with fog: ' + maxCenterAlpha);
        const started = performance.now();
        while (api.world.getExplorationStatus().queued || api.world.getExplorationStatus().running) {
          if (performance.now()-started > 60000) throw new Error('local exploration queue did not drain');
          await wait(25);
        }
        return { ranges:results, performanceGatesEnforced:${!hostedPerformanceObservation}, blackFlash: { inspectedFrames, maxCenterAlpha },
          queue:api.world.getExplorationStatus() };
      } finally { api.diagnostics.setEnabled(initialDiagnostics); }
    })()`, 90000);
    } catch (error) {
      feedbackError = error;
    } finally {
      if (feedbackProfilePath) {
        const { profile: cpuProfile } = await send('Profiler.stop');
        await mkdir(path.dirname(feedbackProfilePath), { recursive: true });
        await writeFile(feedbackProfilePath, JSON.stringify(cpuProfile));
      }
      if (feedbackTracePath) {
        await send('Tracing.end', {}, 30_000);
        let traceTimeout;
        const { stream } = await Promise.race([
          traceCompletion,
          new Promise((_, reject) => { traceTimeout = setTimeout(() => reject(new Error('Chrome feedback trace timed out')), 30_000); }),
        ]).finally(() => clearTimeout(traceTimeout));
        if (!stream) throw new Error('Chrome feedback trace did not return a stream');
        const chunks = [];
        for (;;) {
          const part = await send('IO.read', { handle: stream, size: 1_048_576 }, 30_000);
          chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64') : Buffer.from(part.data));
          if (part.eof) break;
        }
        await send('IO.close', { handle: stream });
        await mkdir(path.dirname(feedbackTracePath), { recursive: true });
        await writeFile(feedbackTracePath, Buffer.concat(chunks));
      }
    }
    // Measure serialized state only after feedback and profiling have ended.
    const storageSizes = await evaluate(`(() => {
      const api = document.querySelector('#app').rpgMapApp;
      const bytes = value => new Blob([JSON.stringify(value)]).size;
      return { runtimeBytes: bytes(api.getState()), exportBytes: bytes(api.exportState()),
        queueSerializedBytes: bytes(api.getLocalExploration()) };
    })()`);
    if (feedbackError) throw new Error(`${feedbackError.message}; storageSizes=${JSON.stringify(storageSizes)}`);
    occlusionAudit = { zoom: zoomRecords, editor, feedback, storageSizes };
    offlineServer = await createPackagedOfflineServer(packageRoot);
    await openPersistentOfflineRuntime({ evaluate, navigate:url=>send('Page.navigate',{url},timeoutMs), url:offlineServer.url });
    const ruinsProfilePath=process.env.RPGMAP_SMOKE_RUINS_CPU_PROFILE;
    ruinsAudit = await runRuinsBrowserSmoke(evaluate, {
      // Hosted CI records timings on its different machine. Formal local
      // publication requires all same-machine performance gates and raw proof.
      enforcePerformanceGates: !hostedPerformanceObservation,
      ...(ruinsProfilePath ? {
      beforeRecovery:async()=>{
        await evaluate(`(()=>{const diagnostics=document.querySelector('#app').rpgMapApp.diagnostics;
          globalThis.__ruinsDiagnosticWasEnabled=diagnostics.enabled;diagnostics.setEnabled(true);diagnostics.reset();})()`);
        await send('Profiler.enable');await send('Profiler.start');
      },
      afterRecovery:async()=>{
        const {profile}=await send('Profiler.stop');await writeFile(ruinsProfilePath,JSON.stringify(profile));
        const pipeline=await evaluate(`(()=>{const diagnostics=document.querySelector('#app').rpgMapApp.diagnostics;
          const snapshot=diagnostics.snapshot();diagnostics.setEnabled(globalThis.__ruinsDiagnosticWasEnabled===true);return snapshot;})()`);
        await writeFile(ruinsProfilePath+'.pipeline.json',JSON.stringify(pipeline));
      },
      } : {}),
    });
    ruinsAudit.storageMode = 'persistent-offline';
    if (process.env.RPGMAP_SMOKE_LOCAL_PERFORMANCE === '1') {
      ruinsAudit.localPerformance = await runLocalBrowserPerformance(evaluate);
    }
    try {
      ruinsAudit.validationWorker = await proveLiveValidationWorker(send);
    } catch (error) {
      const stress = ruinsAudit.stress;
      const completedRuinsStress = { rounds: stress.rounds,
        frames: { count: stress.frames.count, averageFPS: stress.frames.averageFPS, p95Ms: stress.frames.p95Ms },
        maxLongTaskMs: stress.maxLongTaskMs, damageP95Ms: stress.damageP95Ms, restoreP95Ms: stress.restoreP95Ms };
      throw new Error(`${error.message}; completedRuinsStress=${JSON.stringify(completedRuinsStress)}`, { cause: error });
    }
  }
  const assetAudit = await evaluate(`(async () => {
    const response = await fetch('./.vite/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('manifest request failed: ' + response.status);
    const manifest = await response.json();
    const htmlEntry = manifest['index.html'];
    const entry = manifest['src/map-package/default-map.js'];
    const runtimeKey = (htmlEntry?.dynamicImports || []).find(key => key === 'src/runtime/map-runtime.js'
      || manifest[key]?.name === 'map-runtime-core');
    const runtimeEntry = runtimeKey ? manifest[runtimeKey] : null;
    if (!runtimeEntry?.file?.endsWith('.js')) throw new Error('dynamic Map Runtime entry is missing');
    if (!(htmlEntry?.dynamicImports || []).includes('src/map-package/default-map.js')) {
      throw new Error('default MapPackage is not a dynamic application dependency');
    }
    const assets = (entry?.assets || []).filter(file => file.endsWith('.webp'));
    const runtimeAssets = [
      manifest['reference/maps/lanzhou/runtime.json']?.file,
      manifest['reference/maps/lanzhou/runtime.svg']?.file,
    ];
    if (assets.length !== 29) throw new Error('expected 29 Lanzhou WebP assets, got ' + assets.length);
    if (runtimeAssets.some(file => !file) || runtimeAssets.some(file => !(entry?.assets || []).includes(file))) {
      throw new Error('Lanzhou runtime JSON/SVG assets are missing from the default MapPackage');
    }
    const sizes = await Promise.all(assets.map(async file => {
      const assetResponse = await fetch('./' + file, { cache: 'no-store' });
      if (!assetResponse.ok) throw new Error(file + ' returned ' + assetResponse.status);
      if (!String(assetResponse.headers.get('content-type') || '').startsWith('image/webp')) {
        throw new Error(file + ' has invalid content type');
      }
      const bytes = (await assetResponse.arrayBuffer()).byteLength;
      if (!bytes) throw new Error(file + ' is empty');
      return bytes;
    }));
    const runtimeSizes = await Promise.all(runtimeAssets.map(async file => {
      const assetResponse = await fetch('./' + file, { cache: 'no-store' });
      if (!assetResponse.ok) throw new Error(file + ' returned ' + assetResponse.status);
      const expectedType = file.endsWith('.json') ? 'application/json' : 'image/svg+xml';
      if (!String(assetResponse.headers.get('content-type') || '').startsWith(expectedType)) {
        throw new Error(file + ' has invalid content type');
      }
      const bytes = (await assetResponse.arrayBuffer()).byteLength;
      if (!bytes) throw new Error(file + ' is empty');
      return bytes;
    }));
    return {
      count: sizes.length,
      bytes: sizes.reduce((sum, value) => sum + value, 0),
      runtimeCount: runtimeSizes.length,
      runtimeBytes: runtimeSizes.reduce((sum, value) => sum + value, 0),
      runtimeFile: runtimeEntry.file,
    };
  })()`);
  await new Promise(resolve => setTimeout(resolve, 750));
  const visualState = await evaluate(`({
    baseSvgCount: document.querySelectorAll('.leaflet-base-pane svg.leaflet-image-layer').length,
    mapImageCount: document.querySelectorAll('.leaflet-base-pane svg.leaflet-image-layer image').length,
    overlayChildren: document.querySelector('.leaflet-overlay-pane')?.childElementCount ?? -1,
    imageHrefs: [...document.querySelectorAll('image')].slice(0, 3).map(node => node.getAttribute('href')),
  })`);
  if (visualState.baseSvgCount !== 1 || visualState.mapImageCount < 1) {
    throw new Error(`Lanzhou base SVG was not rendered: ${JSON.stringify(visualState)}`);
  }
  const layoutAudit = await evaluate(`(() => {
    const summary = document.querySelector('.selected-token-summary:not([hidden])');
    const rect = summary?.getBoundingClientRect() || null;
    return {
      innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      summary: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
    };
  })()`);
  if (layoutAudit.bodyScrollWidth > layoutAudit.innerWidth || layoutAudit.documentScrollWidth > layoutAudit.innerWidth) {
    throw new Error(`Browser layout has horizontal overflow: ${JSON.stringify(layoutAudit)}`);
  }
  if (layoutAudit.summary && (layoutAudit.summary.left < 0 || layoutAudit.summary.right > layoutAudit.innerWidth)) {
    throw new Error(`Selected Token summary leaves the viewport: ${JSON.stringify(layoutAudit)}`);
  }
  if (process.env.RPGMAP_SMOKE_SCREENSHOT_DIR) {
    const directory = path.resolve(process.env.RPGMAP_SMOKE_SCREENSHOT_DIR);
    await mkdir(directory, { recursive: true });
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(directory, `packaged-${mode}.png`), Buffer.from(capture.data, 'base64'));
  }
  if (failures.length) throw new Error(`Browser requests failed: ${failures.join('; ')}`);
  if (exceptions.length) throw new Error(`Browser runtime errors: ${exceptions.join('; ')}`);
  for (const pattern of [/\/assets\/map-runtime-[^/]+\.js$/, /\/assets\/default-map-[^/]+\.js$/, /\/assets\/runtime-[^/]+\.json$/, /\/assets\/runtime-[^/]+\.svg$/, /\.webp$/]) {
    if (!responses.some(url => pattern.test(url))) {
      throw new Error(`Browser did not load required Runtime asset: ${pattern}; visual=${JSON.stringify(visualState)}; responses=${JSON.stringify(responses.slice(-20))}`);
    }
  }
  if (!isDeepStrictEqual(await benchmarkBuildInfo(process.cwd(), path.resolve(packageRoot)), buildInfo)) {
    throw new Error('Browser smoke package changed during validation');
  }
  console.log(JSON.stringify({ version: buildInfo.metadata.version, build: buildInfo,
    diagnosticProfiling:Boolean(process.env.RPGMAP_SMOKE_CPU_PROFILE||process.env.RPGMAP_SMOKE_FEEDBACK_CPU_PROFILE||process.env.RPGMAP_SMOKE_RUINS_CPU_PROFILE),
    worldManager: mode === 'bootstrap', map: 'northern-song-lanzhou-1104', assets: assetAudit, fog: fogAudit,
    movement: movementAudit, occlusion: occlusionAudit, ruins: ruinsAudit, layout: layoutAudit, ...runtime }));
  // This cleanup is outside all performance measurements. Windows Chromium
  // can take longer to exit; still require this owned process's normal exit.
  await closeOwnedBrowser({ process: edge, send, pending, label: `${browserName} browser smoke`, timeoutMs: 30_000 });
  browserClosed = true;
} catch (error) {
  throw new Error(`${error.message}${edgeError ? `\nEdge stderr:\n${edgeError.slice(-4000)}` : ''}`);
} finally {
  socket?.close();
  await offlineServer?.close();
  if (!browserClosed && edge.exitCode === null) edge.kill('SIGKILL');
  if (edge.exitCode === null) {
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2_000);
      edge.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    .catch(error => console.warn(`Browser smoke profile cleanup deferred: ${error.message}`));
}
