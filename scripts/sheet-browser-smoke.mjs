import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Actor sheet browser smoke requires Windows Edge');
const targetUrl = String(process.argv[2] || '').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/?/.test(targetUrl)) throw new Error('Actor sheet smoke requires a loopback HTTP URL');
const timeoutMs = Math.max(20_000, Number(process.argv[3]) || 45_000);

function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    for (const suffix of [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Microsoft', 'Edge SxS', 'Application', 'msedge.exe'],
    ]) {
      const candidate = path.join(root, ...suffix);
      try { if (process.getBuiltinModule('fs').existsSync(candidate)) return candidate; } catch {}
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
  '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, targetUrl,
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
    for (const { reject, timeout } of pending.values()) { clearTimeout(timeout); reject(new Error(message)); }
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
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      return;
    }
    if (message.method === 'Network.loadingFailed' && message.params?.errorText !== 'net::ERR_ABORTED') {
      failures.push(message.params?.errorText || 'request failed');
    }
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) >= 400) {
      failures.push(`${message.params.response.status} ${message.params.response.url}`);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails;
      exceptions.push(detail?.exception?.description || detail?.text || 'runtime exception');
    }
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
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Edge CDP command timed out: ${method}`)); }, 7_500);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || 'evaluation failed');
    }
    return result.result?.value;
  };

  await Promise.all([send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);
  await retry(() => evaluate(`(() => {
    const api = document.querySelector('#app')?.rpgMapApp;
    return Boolean(api?.world?.performOperations && api?.tokens?.resolveActor && api?.entities?.openToken);
  })()`), 'RPGmap live runtime', deadline);

  const ids = Object.freeze({ actor: 'smoke-sheet-monster', a: 'smoke-sheet-monster-a', b: 'smoke-sheet-monster-b' });
  const snapshot = async label => evaluate(`(() => {
    const api = document.querySelector('#app')?.rpgMapApp;
    return {
      label: ${JSON.stringify(label)},
      activeSceneId: api?.world?.get?.()?.activeSceneId || null,
      tokens: ['${ids.a}', '${ids.b}'].map(id => {
        const token = api?.tokens?.get?.(id);
        return token ? { id: token.id, actorId: token.actorId, actorLink: token.actorLink } : null;
      }),
      actor: (api?.world?.get?.()?.actors || []).find(actor => String(actor?.id) === '${ids.actor}') || null,
      records: api?.entities?.listOpenSheets?.() || [],
      sheets: [...document.querySelectorAll('.entity-sheet')].map(sheet => ({
        key: sheet.dataset.sheetWindowKey || '', actorId: sheet.dataset.actorId || '',
        tokenId: sheet.dataset.tokenId || '', sceneId: sheet.dataset.sceneId || '',
        mode: sheet.dataset.sheetMode || '', kind: sheet.dataset.sheetKind || '',
        tab: sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '',
        title: sheet.querySelector('.entity-sheet-title')?.textContent?.trim()?.slice(0, 120) || '',
      })),
      mapStatus: document.querySelector('[data-role="map-status"]')?.textContent || '',
    };
  })()`);
  const retryWithSnapshot = async (task, label) => {
    try { return await retry(task, label, deadline); }
    catch (error) { throw new Error(`${error.message}; snapshot=${JSON.stringify(await snapshot(label))}; browserErrors=${JSON.stringify(exceptions)}`); }
  };

  const setup = await evaluate(`(async () => {
    const api = document.querySelector('#app').rpgMapApp;
    const actorId = '${ids.actor}', tokenA = '${ids.a}', tokenB = '${ids.b}';
    const existing = (api.world.get().actors || []).some(actor => String(actor.id) === actorId);
    if (existing) await api.world.performOperations([{ type: 'actor.delete', payload: { actorId } }], { source: 'smoke:sheets:reset' });
    const created = api.ruleset.actor.createFromImport({
      formName: 'Smoke Form', identity: { name: 'Smoke Monster' }, description: {},
      resources: { hp: { max: 20 } }, attributes: [], checks: { skills: [], saves: [] },
      badStatuses: [], combat: { attacks: [], defenses: [] }, detection: {},
      tokenAppearance: { color: '#3d9b63', scale: 1 }, source: { type: 'manual' },
    }, { actorId, name: 'Smoke Monster' });
    const actor = { ...created, id: actorId, name: 'Smoke Monster', type: 'monster', partyId: null, effects: [] };
    const sceneId = api.world.get().activeSceneId;
    await api.world.performOperations([
      { type: 'actor.upsert', payload: { actor } },
      { type: 'token.create', payload: { sceneId, token: { id: tokenA, actorId, actorLink: false, placement: 'map', x: 80, y: 80, diameterMeters: 1, visibility: { mode: 'public', userIds: [] }, effects: [] } } },
      { type: 'token.create', payload: { sceneId, token: { id: tokenB, actorId, actorLink: false, placement: 'map', x: 100, y: 80, diameterMeters: 1, visibility: { mode: 'public', userIds: [] }, effects: [] } } },
    ], { source: 'smoke:sheets:setup' });
    for (let attempt = 0; attempt < 40 && (!api.tokens.get(tokenA) || !api.tokens.get(tokenB)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const openedA = await api.entities.openToken(tokenA);
    await new Promise(resolve => setTimeout(resolve, 50));
    const openedB = await api.entities.openToken(tokenB);
    return { actorId, tokenA, tokenB, sceneId, openedA, openedB };
  })()`);
  if (!setup?.openedA || !setup?.openedB) throw new Error(`openToken returned false; snapshot=${JSON.stringify(await snapshot('openToken result'))}`);

  const opened = await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const wanted = ['${ids.a}', '${ids.b}'];
    const sheets = wanted.map(tokenId => document.querySelector('.entity-sheet[data-token-id="' + tokenId + '"]'));
    if (sheets.some(sheet => !sheet)) return null;
    const records = api.entities.listOpenSheets?.() || [];
    if (!wanted.every(tokenId => records.some(record => String(record.tokenId) === tokenId))) return null;
    const tabs = sheets.map(sheet => sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '');
    const keys = sheets.map(sheet => sheet.dataset.sheetWindowKey || '');
    if (new Set(keys).size !== 2) return null;
    if (tabs.some(tab => tab !== 'combat')) throw new Error('Monster/Summon first-open tab is not combat: ' + JSON.stringify(tabs));
    return { tabs, keys, count: records.length };
  })()`), 'two independently live Monster Token sheets on Combat');

  const dragBefore = await evaluate(`Object.fromEntries(['${ids.a}','${ids.b}'].map(tokenId => {
    const rect = document.querySelector('.entity-sheet[data-token-id="' + tokenId + '"]').getBoundingClientRect();
    return [tokenId, { left: rect.left, top: rect.top }];
  }))`);
  await evaluate(`(() => {
    const header = document.querySelector('.entity-sheet[data-token-id="${ids.b}"] .entity-sheet-header');
    const rect = header.getBoundingClientRect();
    const x = rect.left + Math.min(80, rect.width / 3), y = rect.top + Math.min(30, rect.height / 2);
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 96, clientY: y + 54 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 96, clientY: y + 54 }));
    return true;
  })()`);
  const dragAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const a = document.querySelector('.entity-sheet[data-token-id="${ids.a}"]').getBoundingClientRect();
    const b = document.querySelector('.entity-sheet[data-token-id="${ids.b}"]').getBoundingClientRect();
    const movedA = Math.abs(a.left-${dragBefore[ids.a].left}) + Math.abs(a.top-${dragBefore[ids.a].top});
    const movedB = Math.abs(b.left-${dragBefore[ids.b].left}) + Math.abs(b.top-${dragBefore[ids.b].top});
    return movedB > 20 && movedA < 4 ? { movedA, movedB } : null;
  })()`), 'independent sheet dragging');

  await evaluate(`document.querySelector('.entity-sheet[data-token-id="${ids.a}"] [data-sheet-tab="status"]').click()`);
  const tabAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const a = document.querySelector('.entity-sheet[data-token-id="${ids.a}"] .entity-sheet-tab.active')?.dataset.sheetTab;
    const b = document.querySelector('.entity-sheet[data-token-id="${ids.b}"] .entity-sheet-tab.active')?.dataset.sheetTab;
    return a === 'status' && b === 'combat' ? { a, b } : null;
  })()`), 'independent tab routing');

  await evaluate(`document.querySelector('.entity-sheet[data-token-id="${ids.a}"] [data-sheet-tab="combat"]').click()`);
  const healthBefore = await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const input = document.querySelector('.entity-sheet[data-token-id="${ids.a}"] [data-health-field-id]:not([disabled])');
    const other = document.querySelector('.entity-sheet[data-token-id="${ids.b}"] [data-health-field-id]:not([disabled])');
    if (!input || !other || !api.health?.resolveToken) return null;
    return { a: api.health.resolveToken('${ids.a}'), b: api.health.resolveToken('${ids.b}'), fieldId: input.dataset.healthFieldId };
  })()`), 'editable Health fields on both Token sheets');
  const healthChange = await evaluate(`(() => {
    const input = document.querySelector('.entity-sheet[data-token-id="${ids.a}"] [data-health-field-id="${healthBefore.fieldId}"]:not([disabled])');
    const current = Number(input.value), min = input.min === '' ? 0 : Number(input.min), max = input.max === '' ? Infinity : Number(input.max);
    let next = current > min ? current - 1 : current + 1;
    if (Number.isFinite(max)) next = Math.min(max, next);
    if (next === current) throw new Error('Health field has no editable neighboring value');
    input.value = String(next); input.dispatchEvent(new Event('change', { bubbles: true }));
    return { current, next };
  })()`);
  await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const a = api.health.resolveToken('${ids.a}'), b = api.health.resolveToken('${ids.b}');
    return JSON.stringify(a) !== ${JSON.stringify(JSON.stringify(healthBefore.a))}
      && JSON.stringify(b) === ${JSON.stringify(JSON.stringify(healthBefore.b))} ? true : null;
  })()`), 'Health mutation isolated to originating Token sheet');

  await evaluate(`document.querySelector('.entity-sheet[data-token-id="${ids.a}"] [data-sheet-tab="status"]').click()`);
  const statusChoice = await retryWithSnapshot(() => evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet[data-token-id="${ids.a}"]');
    const scope = sheet?.querySelector('[data-status-palette-scope]');
    if (!scope) return null;
    scope.value = 'token'; scope.dispatchEvent(new Event('change', { bubbles: true }));
    const definition = sheet.querySelector('[data-status-palette-definition]');
    const submit = sheet.querySelector('[data-status-action="palette-submit"]');
    return definition?.value && submit && !submit.disabled ? { definitionId: definition.value } : null;
  })()`), 'Token-instance Status palette');
  await evaluate(`document.querySelector('.entity-sheet[data-token-id="${ids.a}"] [data-status-action="palette-submit"]').click()`);
  const statusAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const a = api.status.resolve({ actorId: '${ids.actor}', tokenId: '${ids.a}' });
    const b = api.status.resolve({ actorId: '${ids.actor}', tokenId: '${ids.b}' });
    const allA = [...(a.actorStatuses||[]), ...(a.tokenStatuses||[])];
    const allB = [...(b.actorStatuses||[]), ...(b.tokenStatuses||[])];
    const aHas = allA.some(status => String(status.definitionId) === '${statusChoice.definitionId}');
    const bHas = allB.some(status => String(status.definitionId) === '${statusChoice.definitionId}');
    return aHas && !bHas ? { definitionId: '${statusChoice.definitionId}', aCount: allA.length, bCount: allB.length } : null;
  })()`), 'Status mutation isolated to originating synthetic Actor');

  await evaluate(`document.querySelector('.entity-sheet[data-token-id="${ids.a}"] [data-sheet-action="close"]').click()`);
  await retryWithSnapshot(() => evaluate(`!document.querySelector('.entity-sheet[data-token-id="${ids.a}"]')`), 'Token A sheet close');
  await evaluate(`document.querySelector('#app').rpgMapApp.entities.openToken('${ids.a}')`);
  const restoreAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const tab = document.querySelector('.entity-sheet[data-token-id="${ids.a}"] .entity-sheet-tab.active')?.dataset.sheetTab;
    return tab === 'status' ? { tab } : null;
  })()`), 'per-World tab restoration after close and reopen');

  await evaluate(`document.querySelector('#app').rpgMapApp.entities.openActor('${ids.actor}')`);
  const playEditAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || ''));
    const toggle = sheet?.querySelector('[data-sheet-v2-mode-toggle]');
    if (!sheet || !toggle) return null;
    const before = sheet.dataset.sheetInteractionMode; toggle.click();
    return before === 'play' && sheet.dataset.sheetInteractionMode === 'edit' ? { before, after: sheet.dataset.sheetInteractionMode } : null;
  })()`), 'Actor template Play/Edit toggle');
  await evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || ''));
    sheet?.querySelector('[data-sheet-v2-mode-toggle]')?.click(); return true;
  })()`);

  if (process.env.RPGMAP_SMOKE_SCREENSHOT_DIR) {
    const directory = path.resolve(process.env.RPGMAP_SMOKE_SCREENSHOT_DIR);
    await mkdir(directory, { recursive: true });
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(directory, 'packaged-sheets.png'), Buffer.from(capture.data, 'base64'));
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  if (failures.length) throw new Error(`Actor sheet browser requests failed: ${failures.join('; ')}`);
  if (exceptions.length) throw new Error(`Actor sheet browser runtime errors: ${exceptions.join('; ')}`);

  console.log(JSON.stringify({ liveSheets: opened, drag: dragAudit, tabs: tabAudit,
    health: { fieldId: healthBefore.fieldId, change: healthChange, isolated: true },
    status: statusAudit, restored: restoreAudit, playEdit: playEditAudit }));
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
