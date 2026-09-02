import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Actor sheet browser smoke requires Windows Edge');
const targetUrl = String(process.argv[2] || '').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/?/.test(targetUrl)) throw new Error('Actor sheet smoke requires a loopback HTTP URL');
const timeoutMs = Math.max(15_000, Number(process.argv[3]) || 45_000);

function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const suffixes = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Microsoft', 'Edge SxS', 'Application', 'msedge.exe'],
  ];
  for (const root of roots) {
    for (const suffix of suffixes) {
      const candidate = path.join(root, ...suffix);
      try {
        if (process.getBuiltinModule('fs').existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  throw new Error('Microsoft Edge executable was not found');
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-sheet-smoke-'));
const edge = spawn(edgePath(), [
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,1000',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  targetUrl,
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let edgeError = '';
edge.stderr.setEncoding('utf8');
edge.stderr.on('data', chunk => { edgeError += chunk; });
let browserClosed = false;

try {
  const deadline = Date.now() + timeoutMs;
  const page = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const pages = await response.json();
    return pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'Edge CDP endpoint', deadline);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Edge CDP WebSocket open timed out')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Edge CDP WebSocket failed')); }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const failures = [];
  const exceptions = [];
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
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Edge CDP command timed out: ${method}`));
    }, 7_500);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result?.value;
  };

  await Promise.all([send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);
  await retry(
    () => evaluate(`(() => {
      const api = document.querySelector('#app')?.rpgMapApp;
      return Boolean(api?.world?.performOperations && api?.tokens?.resolveActor && api?.entities?.openToken);
    })()`),
    'RPGmap live runtime',
    deadline,
  );

  const setup = await evaluate(`(async () => {
    const api = document.querySelector('#app').rpgMapApp;
    const actorId = 'smoke-sheet-monster';
    const tokenA = 'smoke-sheet-monster-a';
    const tokenB = 'smoke-sheet-monster-b';
    const world = api.world.get();
    if ((world.actors || []).some(actor => String(actor.id) === actorId)) {
      await api.world.performOperations([{ type: 'actor.delete', payload: { actorId } }], { source: 'smoke:sheets:reset' });
    }
    const imported = {
      formName: 'Smoke Form',
      identity: { name: 'Smoke Monster' },
      description: {},
      resources: { hp: { max: 20 } },
      attributes: [],
      checks: { skills: [], saves: [] },
      badStatuses: [],
      combat: { attacks: [], defenses: [] },
      detection: {},
      tokenAppearance: { color: '#3d9b63', scale: 1 },
      source: { type: 'manual' },
    };
    const created = api.ruleset.actor.createFromImport(imported, { actorId, name: 'Smoke Monster' });
    const actor = { ...created, id: actorId, name: 'Smoke Monster', type: 'monster', partyId: null, effects: [] };
    const sceneId = api.world.get().activeSceneId;
    await api.world.performOperations([
      { type: 'actor.upsert', payload: { actor } },
      { type: 'token.create', payload: { sceneId, token: { id: tokenA, actorId, actorLink: false, placement: 'map', x: 80, y: 80, diameterMeters: 1, visibility: { mode: 'public', userIds: [] }, effects: [] } } },
      { type: 'token.create', payload: { sceneId, token: { id: tokenB, actorId, actorLink: false, placement: 'map', x: 100, y: 80, diameterMeters: 1, visibility: { mode: 'public', userIds: [] }, effects: [] } } },
    ], { source: 'smoke:sheets:setup' });
    await api.entities.openToken(tokenA);
    await api.entities.openToken(tokenB);
    return { actorId, tokenA, tokenB, sceneId };
  })()`);

  const opened = await retry(
    () => evaluate(`(() => {
      const api = document.querySelector('#app').rpgMapApp;
      const ids = ['${setup.tokenA}', '${setup.tokenB}'];
      const sheets = ids.map(tokenId => document.querySelector('.entity-sheet[data-token-id="' + tokenId + '"]'));
      if (sheets.some(sheet => !sheet)) return null;
      const records = api.entities.listOpenSheets?.() || [];
      if (!ids.every(tokenId => records.some(record => record.tokenId === tokenId))) return null;
      const tabs = sheets.map(sheet => sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '');
      const keys = sheets.map(sheet => sheet.dataset.sheetWindowKey || '');
      if (tabs.some(tab => tab !== 'combat') || new Set(keys).size !== 2) return null;
      return { tabs, keys, count: records.length };
    })()`),
    'two independently live Monster Token sheets on Combat',
    deadline,
  );

  const dragBefore = await evaluate(`(() => {
    const ids = ['${setup.tokenA}', '${setup.tokenB}'];
    return Object.fromEntries(ids.map(tokenId => {
      const rect = document.querySelector('.entity-sheet[data-token-id="' + tokenId + '"]').getBoundingClientRect();
      return [tokenId, { left: rect.left, top: rect.top }];
    }));
  })()`);
  await evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenB}"]');
    const header = sheet.querySelector('.entity-sheet-header');
    const rect = header.getBoundingClientRect();
    const x = rect.left + Math.min(80, rect.width / 3);
    const y = rect.top + Math.min(30, rect.height / 2);
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 96, clientY: y + 54 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 96, clientY: y + 54 }));
    return true;
  })()`);
  const dragAudit = await retry(
    () => evaluate(`(() => {
      const a = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]').getBoundingClientRect();
      const b = document.querySelector('.entity-sheet[data-token-id="${setup.tokenB}"]').getBoundingClientRect();
      const movedB = Math.abs(b.left - ${dragBefore[setup.tokenB].left}) + Math.abs(b.top - ${dragBefore[setup.tokenB].top});
      const movedA = Math.abs(a.left - ${dragBefore[setup.tokenA].left}) + Math.abs(a.top - ${dragBefore[setup.tokenA].top});
      return movedB > 20 && movedA < 4 ? { movedA, movedB, b: { left: b.left, top: b.top } } : null;
    })()`),
    'independent sheet dragging',
    deadline,
  );

  await evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
    sheet.querySelector('[data-sheet-tab="status"]').click();
    return true;
  })()`);
  const tabAudit = await retry(
    () => evaluate(`(() => {
      const a = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
      const b = document.querySelector('.entity-sheet[data-token-id="${setup.tokenB}"]');
      const tabA = a?.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab;
      const tabB = b?.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab;
      return tabA === 'status' && tabB === 'combat' ? { tabA, tabB } : null;
    })()`),
    'independent tab routing',
    deadline,
  );

  await evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
    sheet.querySelector('[data-sheet-tab="combat"]').click();
    return true;
  })()`);
  const healthBefore = await retry(
    () => evaluate(`(() => {
      const api = document.querySelector('#app').rpgMapApp;
      const sheetA = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
      const sheetB = document.querySelector('.entity-sheet[data-token-id="${setup.tokenB}"]');
      const input = sheetA?.querySelector('[data-health-field-id]:not([disabled])');
      const other = sheetB?.querySelector('[data-health-field-id]:not([disabled])');
      if (!input || !other) return null;
      const a = api.health.resolveToken('${setup.tokenA}');
      const b = api.health.resolveToken('${setup.tokenB}');
      if (!a || !b) return null;
      return { a, b, fieldId: input.dataset.healthFieldId, value: Number(input.value), min: input.min, max: input.max };
    })()`),
    'editable Health fields on both Token sheets',
    deadline,
  );
  const healthChange = await evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
    const input = sheet.querySelector('[data-health-field-id="${healthBefore.fieldId}"]:not([disabled])');
    const current = Number(input.value);
    const min = input.min === '' ? 0 : Number(input.min);
    const max = input.max === '' ? Number.POSITIVE_INFINITY : Number(input.max);
    let next = current > min ? current - 1 : current + 1;
    if (Number.isFinite(max)) next = Math.min(max, next);
    if (next === current) throw new Error('Health field has no editable neighboring value');
    input.value = String(next);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { current, next };
  })()`);
  const healthAudit = await retry(
    () => evaluate(`(() => {
      const api = document.querySelector('#app').rpgMapApp;
      const a = api.health.resolveToken('${setup.tokenA}');
      const b = api.health.resolveToken('${setup.tokenB}');
      const changedA = JSON.stringify(a) !== ${JSON.stringify(JSON.stringify(healthBefore.a))};
      const unchangedB = JSON.stringify(b) === ${JSON.stringify(JSON.stringify(healthBefore.b))};
      return changedA && unchangedB ? { a, b } : null;
    })()`),
    'Health mutation isolated to the originating Token sheet',
    deadline,
  );

  await evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
    sheet.querySelector('[data-sheet-tab="status"]').click();
    return true;
  })()`);
  const statusChoice = await retry(
    () => evaluate(`(() => {
      const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
      const definition = sheet?.querySelector('[data-status-palette-definition]');
      const submit = sheet?.querySelector('[data-status-action="palette-submit"]');
      if (!definition?.value || !submit || submit.disabled) return null;
      return { definitionId: definition.value };
    })()`),
    'Monster Status palette',
    deadline,
  );
  const statusBefore = await evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    return {
      a: api.status.resolve({ actorId: '${setup.actorId}', tokenId: '${setup.tokenA}' }).actorStatuses || [],
      b: api.status.resolve({ actorId: '${setup.actorId}', tokenId: '${setup.tokenB}' }).actorStatuses || [],
    };
  })()`);
  await evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
    sheet.querySelector('[data-status-action="palette-submit"]').click();
    return true;
  })()`);
  const statusAudit = await retry(
    () => evaluate(`(() => {
      const api = document.querySelector('#app').rpgMapApp;
      const a = api.status.resolve({ actorId: '${setup.actorId}', tokenId: '${setup.tokenA}' }).actorStatuses || [];
      const b = api.status.resolve({ actorId: '${setup.actorId}', tokenId: '${setup.tokenB}' }).actorStatuses || [];
      const aHas = a.some(status => String(status.definitionId) === '${statusChoice.definitionId}');
      const bHas = b.some(status => String(status.definitionId) === '${statusChoice.definitionId}');
      return aHas && !bHas ? { definitionId: '${statusChoice.definitionId}', aCount: a.length, bCount: b.length } : null;
    })()`),
    'Status mutation isolated to the originating Token sheet',
    deadline,
  );

  await evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
    sheet.querySelector('[data-sheet-action="close"]').click();
    return true;
  })()`);
  await retry(
    () => evaluate(`!document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]')`),
    'Token A sheet close',
    deadline,
  );
  await evaluate(`document.querySelector('#app').rpgMapApp.entities.openToken('${setup.tokenA}')`);
  const restoreAudit = await retry(
    () => evaluate(`(() => {
      const sheet = document.querySelector('.entity-sheet[data-token-id="${setup.tokenA}"]');
      const tab = sheet?.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab;
      return tab === 'status' ? { tab } : null;
    })()`),
    'per-World tab restoration after close and reopen',
    deadline,
  );

  await evaluate(`document.querySelector('#app').rpgMapApp.entities.openActor('${setup.actorId}')`);
  const playEditAudit = await retry(
    () => evaluate(`(() => {
      const sheet = document.querySelector('.entity-sheet[data-actor-id="${setup.actorId}"]:not([data-token-id]:not([data-token-id=""]))');
      const toggle = sheet?.querySelector('[data-sheet-v2-mode-toggle]');
      if (!sheet || !toggle) return null;
      const before = sheet.dataset.sheetInteractionMode;
      toggle.click();
      return { before, after: sheet.dataset.sheetInteractionMode };
    })()`).then(value => value?.before === 'play' && value.after === 'edit' ? value : null),
    'Actor template Play/Edit toggle',
    deadline,
  );
  await evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${setup.actorId}"]')].find(node => !String(node.dataset.tokenId || ''));
    const toggle = sheet?.querySelector('[data-sheet-v2-mode-toggle]');
    if (toggle) toggle.click();
    return sheet?.dataset.sheetInteractionMode || null;
  })()`);

  if (process.env.RPGMAP_SMOKE_SCREENSHOT_DIR) {
    const directory = path.resolve(process.env.RPGMAP_SMOKE_SCREENSHOT_DIR);
    await mkdir(directory, { recursive: true });
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(directory, 'packaged-sheets.png'), Buffer.from(capture.data, 'base64'));
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  if (failures.length) throw new Error(`Actor sheet browser requests failed: ${failures.join('; ')}`);
  if (exceptions.length) throw new Error(`Actor sheet browser runtime errors: ${exceptions.join('; ')}`);

  console.log(JSON.stringify({
    liveSheets: opened,
    drag: dragAudit,
    tabs: tabAudit,
    health: { fieldId: healthBefore.fieldId, change: healthChange, isolated: Boolean(healthAudit) },
    status: { before: statusBefore, ...statusAudit },
    restored: restoreAudit,
    playEdit: playEditAudit,
  }));
  await send('Browser.close');
  browserClosed = true;
} catch (error) {
  throw new Error(`${error.message}${edgeError ? `\nEdge stderr:\n${edgeError.slice(-4000)}` : ''}`);
} finally {
  if (!browserClosed && edge.exitCode === null) edge.kill('SIGKILL');
  if (edge.exitCode === null) {
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2_000);
      edge.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    .catch(error => console.warn(`Actor sheet smoke profile cleanup deferred: ${error.message}`));
}
