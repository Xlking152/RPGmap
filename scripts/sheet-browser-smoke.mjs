import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Actor sheet browser smoke requires Windows');
const browserName = String(process.env.RPGMAP_SMOKE_BROWSER || 'edge').toLowerCase();
if (!['edge', 'chrome'].includes(browserName)) throw new Error(`Unsupported smoke browser: ${browserName}`);
const targetUrl = String(process.argv[2] || '').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/?/.test(targetUrl)) throw new Error('Actor sheet smoke requires a loopback HTTP URL');
const timeoutMs = Math.max(20_000, Number(process.argv[3]) || 45_000);

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
      if (existsSync(candidate)) return candidate;
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
const profile = await mkdtemp(path.join(os.tmpdir(), `rpgmap-${browserName}-sheet-smoke-`));
const edge = spawn(edgePath(), [
  '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, targetUrl,
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let edgeError = '';
let browserClosed = false;
edge.stderr.setEncoding('utf8');
edge.stderr.on('data', chunk => { edgeError += chunk; });

try {
  const deadline = Date.now() + timeoutMs;
  const page = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const pages = await response.json();
    return pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'Edge CDP endpoint', deadline);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Edge CDP WebSocket open timed out')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Edge CDP WebSocket failed')); }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const failures = [];
  const requests = new Map();
  const expectedResponses = [];
  const exceptions = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      return message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
    if (message.method === 'Network.loadingFailed' && message.params?.errorText !== 'net::ERR_ABORTED') failures.push(message.params?.errorText || 'request failed');
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request } = message.params;
      requests.set(requestId, request.method);
      const expected = expectedResponses.find(item => !item.requestId && item.url === request.url && item.method === request.method);
      if (expected) expected.requestId = requestId;
    }
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) >= 400) {
      const { response, requestId } = message.params;
      const expected = expectedResponses.find(item => !item.seen && item.url === response.url
        && item.method === requests.get(requestId) && item.status === response.status);
      if (expected) expected.seen = true;
      else failures.push(`${response.status} ${response.url}`);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails;
      exceptions.push(detail?.exception?.description || detail?.text || 'runtime exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args || []).map(arg => arg.value ?? arg.unserializableValue ?? arg.description ?? '').filter(Boolean).join(' ');
      exceptions.push(text || 'browser console error');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      const entry = message.params.entry;
      const expected = expectedResponses.find(item => item.requestId && item.requestId === entry.networkRequestId
        && item.url === entry.url && entry.source === 'network' && entry.text.includes(` ${item.status} `));
      if (!expected) exceptions.push(entry.text || 'browser log error');
    }
  });
  const rejectPending = message => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    pending.clear();
  };
  socket.addEventListener('close', () => rejectPending('Edge CDP WebSocket closed'));
  socket.addEventListener('error', () => rejectPending('Edge CDP WebSocket failed'));

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Edge CDP command timed out: ${method}`)); }, 7_500);
    pending.set(id, { resolve, reject, timer });
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

  await Promise.all([send('Runtime.enable'), send('Network.enable'), send('Log.enable'), send('Page.enable')]);

  // The GM page exposes api.world before the WebSocket welcome and initial
  // authoritative snapshot finish. Seeding before this point would take the
  // offline branch and the subsequent initial snapshot would overwrite it.
  const ready = await retry(() => evaluate(`(() => {
    const api = document.querySelector('#app')?.rpgMapApp;
    const mp = api?.multiplayer?.getStatus?.();
    const status = document.querySelector('[data-role="map-status"]')?.textContent || '';
    return api?.world?.performOperations && api?.tokens?.resolveActor && api?.entities?.openToken
      && mp?.connected === true && mp?.session?.role === 'gm' && mp?.permissions?.worldWrite === true
      && /^联机同步完成/.test(status)
      ? { revision: mp.revision, status }
      : null;
  })()`), 'authoritative GM runtime after initial sync', deadline);

  const ids = Object.freeze({ actor: 'smoke-sheet-monster', a: 'smoke-sheet-monster-a', b: 'smoke-sheet-monster-b' });
  const snapshot = label => evaluate(`(() => {
    const api = document.querySelector('#app')?.rpgMapApp;
    const mp = api?.multiplayer?.getStatus?.();
    return {
      label: ${JSON.stringify(label)}, multiplayer: mp ? { connected: mp.connected, revision: mp.revision, role: mp.session?.role, worldWrite: mp.permissions?.worldWrite } : null,
      activeSceneId: api?.world?.get?.()?.activeSceneId || null,
      tokens: ['${ids.a}', '${ids.b}'].map(id => { const token = api?.tokens?.get?.(id); return token ? { id: token.id, actorId: token.actorId, actorLink: token.actorLink } : null; }),
      actor: (api?.world?.get?.()?.actors || []).find(actor => String(actor?.id) === '${ids.actor}') || null,
      records: api?.entities?.listOpenSheets?.() || [],
      sheets: [...document.querySelectorAll('.entity-sheet')].map(sheet => ({ key: sheet.dataset.sheetWindowKey || '', actorId: sheet.dataset.actorId || '', tokenId: sheet.dataset.tokenId || '', sceneId: sheet.dataset.sceneId || '', mode: sheet.dataset.sheetMode || '', kind: sheet.dataset.sheetKind || '', tab: sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '' })),
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
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext('2d'); context.fillStyle = '#408d78'; context.fillRect(0, 0, 8, 8);
    const avatar = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const uploaded = await api.content.putImage(avatar);
    const duplicate = await api.content.putImage(avatar);
    if (uploaded.reference !== duplicate.reference || !/^asset:[a-f0-9]{64}$/.test(uploaded.reference)) throw new Error('content deduplication failed');
    if ((api.world.get().actors || []).some(actor => String(actor.id) === actorId)) {
      await api.world.performOperations([{ type: 'actor.delete', payload: { actorId } }], { source: 'smoke:sheets:reset' });
    }
    const created = api.ruleset.actor.createFromImport({
      formName: 'Smoke Form', identity: { name: 'Smoke Monster' }, description: {}, resources: { hp: { max: 20 } },
      attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] }, detection: {},
      tokenAppearance: { color: '#3d9b63', scale: 1 }, source: { type: 'manual' },
      avatarDataUrl: uploaded.reference,
    }, { actorId, name: 'Smoke Monster' });
    const actor = { ...created, id: actorId, name: 'Smoke Monster', type: 'monster', partyId: null, effects: [] };
    const sceneId = api.world.get().activeSceneId;
    const commit = await api.world.performOperations([
      { type: 'actor.upsert', payload: { actor } },
      { type: 'token.create', payload: { sceneId, token: { id: tokenA, actorId, actorLink: false, placement: 'map', x: 80, y: 80, diameterMeters: 1, visibility: { mode: 'public', userIds: [] }, effects: [] } } },
      { type: 'token.create', payload: { sceneId, token: { id: tokenB, actorId, actorLink: false, placement: 'map', x: 100, y: 80, diameterMeters: 1, visibility: { mode: 'public', userIds: [] }, effects: [] } } },
    ], { source: 'smoke:sheets:setup' });
    const present = Boolean(api.tokens.get(tokenA) && api.tokens.get(tokenB) && api.world.get().actors.some(item => String(item.id) === actorId));
    const openedA = present ? await api.entities.openToken(tokenA) : false;
    await new Promise(resolve => setTimeout(resolve, 50));
    const openedB = present ? await api.entities.openToken(tokenB) : false;
    return { actorId, tokenA, tokenB, sceneId, commit, present, openedA, openedB, asset: uploaded.reference, revision: api.multiplayer.getStatus().revision };
  })()`);
  if (!setup?.present || !setup.openedA || !setup.openedB) throw new Error(`authoritative fixture/openToken failed: ${JSON.stringify(setup)}; snapshot=${JSON.stringify(await snapshot('fixture setup'))}`);

  await retryWithSnapshot(() => evaluate(`(() => {
    const images = [...document.querySelectorAll('img[data-content-ref="${setup.asset}"]')];
    return images.length >= 2 && images.every(image => image.complete && image.naturalWidth === 8 && image.src.startsWith('blob:'));
  })()`), 'authenticated content hydrates map and sheet portraits without data URLs');
  const refusedDelete = { method: 'DELETE', url: new URL(`/api/content/${setup.asset.slice(6)}`, targetUrl).href, status: 409, seen: false };
  expectedResponses.push(refusedDelete);
  await evaluate(`(async () => {
    const api = document.querySelector('#app').rpgMapApp;
    const refs = await api.content.references('${setup.asset}');
    if (refs.count < 1) throw new Error('content reference accounting failed');
    try { await api.content.remove('${setup.asset}'); throw new Error('referenced content was removed'); }
    catch (error) { if (error.message !== 'content_in_use') throw error; }
    return true;
  })()`);
  if (!refusedDelete.seen) throw new Error('referenced asset deletion did not produce the required HTTP 409');

  const opened = await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const wanted = ['${ids.a}', '${ids.b}'];
    const sheets = wanted.map(tokenId => document.querySelector('.entity-sheet[data-token-id="' + tokenId + '"]'));
    if (sheets.some(sheet => !sheet)) return null;
    const records = api.entities.listOpenSheets?.() || [];
    const tabs = sheets.map(sheet => sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '');
    const keys = sheets.map(sheet => sheet.dataset.sheetWindowKey || '');
    if (!wanted.every(tokenId => records.some(record => String(record.tokenId) === tokenId)) || new Set(keys).size !== 2) return null;
    if (tabs.some(tab => tab !== 'combat')) throw new Error('Monster first-open tab is not combat: ' + JSON.stringify(tabs));
    return { tabs, keys, count: records.length };
  })()`), 'two independently live Monster Token sheets on Combat');

  const dragBefore = await evaluate(`Object.fromEntries(['${ids.a}','${ids.b}'].map(tokenId => { const rect = document.querySelector('.entity-sheet[data-token-id="' + tokenId + '"]').getBoundingClientRect(); return [tokenId, { left: rect.left, top: rect.top }]; }))`);
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
    return JSON.stringify(a) !== ${JSON.stringify(JSON.stringify(healthBefore.a))} && JSON.stringify(b) === ${JSON.stringify(JSON.stringify(healthBefore.b))} ? true : null;
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
    const allA = [...(a.actorStatuses||[]), ...(a.tokenStatuses||[])], allB = [...(b.actorStatuses||[]), ...(b.tokenStatuses||[])];
    const aHas = allA.some(status => String(status.definitionId) === '${statusChoice.definitionId}');
    const bHas = allB.some(status => String(status.definitionId) === '${statusChoice.definitionId}');
    return aHas && !bHas ? { definitionId: '${statusChoice.definitionId}', aCount: allA.length, bCount: allB.length } : null;
  })()`), 'Status mutation isolated to originating synthetic Actor');

  await evaluate(`document.querySelector('.entity-sheet[data-token-id="${ids.a}"] [data-sheet-action="close"]').click()`);
  await retryWithSnapshot(() => evaluate(`!document.querySelector('.entity-sheet[data-token-id="${ids.a}"]')`), 'Token A sheet close');
  await evaluate(`document.querySelector('#app').rpgMapApp.entities.openToken('${ids.a}')`);
  const restoreAudit = await retryWithSnapshot(() => evaluate(`(() => { const tab = document.querySelector('.entity-sheet[data-token-id="${ids.a}"] .entity-sheet-tab.active')?.dataset.sheetTab; return tab === 'status' ? { tab } : null; })()`), 'per-World tab restoration after close and reopen');

  await evaluate(`document.querySelector('#app').rpgMapApp.entities.openActor('${ids.actor}')`);
  await retryWithSnapshot(() => evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || ''));
    const toggle = sheet?.querySelector('[data-sheet-mode-toggle]');
    return sheet?.dataset.sheetInteractionMode === 'play' && toggle ? true : null;
  })()`), 'Actor template Play mode');
  await evaluate(`(() => { const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || '')); sheet?.querySelector('[data-sheet-mode-toggle]')?.click(); return true; })()`);
  const playEditAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || ''));
    return sheet?.dataset.sheetInteractionMode === 'edit' && sheet.querySelector('[data-sheet-mode-toggle]') ? { before: 'play', after: 'edit' } : null;
  })()`), 'Actor template Edit mode');
  await evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !node.dataset.tokenId);
    const input = sheet.querySelector('[data-actor-name]');
    input.focus(); input.value = 'local draft name'; input.setSelectionRange(3, 8);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const observer = new MutationObserver(() => {});
    observer.observe(sheet.querySelector('.entity-sheet-header'), { attributes: true, childList: true, subtree: true, characterData: true });
    window.sheetDraftProbe = { input, observer };
    return true;
  })()`);
  await evaluate(`(async () => {
    const api = document.querySelector('#app').rpgMapApp;
    const actor = api.world.get().actors.find(item => item.id === '${ids.actor}');
    await api.world.performOperations([{ type: 'actor.metadata.update', payload: { actorId: actor.id, changes: { partyId: 'draft-probe-party' }, expected: { partyId: actor.partyId } } }]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { input, observer } = window.sheetDraftProbe;
    if (!input.isConnected || document.activeElement !== input || input.value !== 'local draft name' || input.selectionStart !== 3 || input.selectionEnd !== 8) throw new Error('Unrelated commit replaced or disturbed the active input');
    if (observer.takeRecords().length) throw new Error('Unrelated classification field rendered the header Part');
    observer.disconnect();
    await api.world.performOperations([{ type: 'actor.metadata.update', payload: { actorId: actor.id, changes: { name: 'remote name' }, expected: { name: actor.name } } }]);
    return true;
  })()`);
  const draftAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const input = window.sheetDraftProbe.input;
    const sheet = input.closest('.entity-sheet');
    const retry = sheet?.querySelector('[data-sheet-field-resolution="retry"]');
    if (!retry) return null;
    if (!input.isConnected || input !== sheet.querySelector('[data-actor-name]') || input.value !== 'local draft name' || input.selectionStart !== 3 || input.selectionEnd !== 8) throw new Error('Conflicting commit discarded the focused field draft');
    retry.click();
    return { stableNode: true, caret: [input.selectionStart, input.selectionEnd], conflict: true };
  })()`), 'dirty field conflict and explicit resubmission');
  await retryWithSnapshot(() => evaluate(`document.querySelector('#app').rpgMapApp.world.get().actors.find(item => item.id === '${ids.actor}')?.name === 'local draft name'`), 'field resubmission acknowledged with current field precondition');
  await evaluate('delete window.sheetDraftProbe');
  await evaluate(`(() => { const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || '')); sheet?.querySelector('[data-sheet-tab="public-profile"]')?.click(); return true; })()`);
  await retryWithSnapshot(() => evaluate(`(() => { const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || '')); return sheet?.querySelector('[data-public-profile-editor]') ? true : null; })()`), 'GM public profile editor');
  await evaluate(`(() => { const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || '')); const summary = sheet?.querySelector('[name="summary"]'); if (!summary) return false; summary.value = 'Smoke LIMITED profile'; sheet.querySelector('[data-public-profile-save]')?.click(); return true; })()`);
  const publicProfileAudit = await retryWithSnapshot(() => evaluate(`(() => { const actor = document.querySelector('#app').rpgMapApp.world.get().actors.find(item => item.id === '${ids.actor}'); return actor?.publicProfile?.summary === 'Smoke LIMITED profile' ? { summary: actor.publicProfile.summary } : null; })()`), 'GM public profile authoritative update');
  const portraitBefore = await evaluate(`(async () => {
    const api = document.querySelector('#app').rpgMapApp;
    const actor = api.world.get().actors.find(item => item.id === '${ids.actor}');
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !node.dataset.tokenId);
    sheet.querySelector('[data-sheet-action="avatar"]').click();
    const source = await api.content.get('${setup.asset}');
    const transfer = new DataTransfer(); transfer.items.add(new File([source], 'portrait.png', { type: source.type }));
    const input = document.querySelector('input[data-entity-avatar-file]');
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify(actor.system.runtime);
  })()`);
  const portraitAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const actor = api.world.get().actors.find(item => item.id === '${ids.actor}');
    const portrait = api.ruleset.actor.portrait.describe(actor);
    if (!portrait.reference?.startsWith('asset:') || portrait.reference === '${setup.asset}') return null;
    const image = document.querySelector('img[data-content-ref="' + portrait.reference + '"]');
    return image?.complete && image.naturalWidth === 8 ? { reference: portrait.reference, runtime: JSON.stringify(actor.system.runtime) } : null;
  })()`), 'portrait upload uses its field-specific authoritative intent and hydrates the WebP asset');
  if (portraitAudit.runtime !== portraitBefore) throw new Error('portrait update overwrote Actor runtime data');
  await evaluate(`(() => { const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || '')); sheet?.querySelector('[data-sheet-mode-toggle]')?.click(); return true; })()`);
  await retryWithSnapshot(() => evaluate(`(() => { const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.actor}"]')].find(node => !String(node.dataset.tokenId || '')); return sheet?.dataset.sheetInteractionMode === 'play' ? true : null; })()`), 'Actor template Play mode restored');

  if (process.env.RPGMAP_SMOKE_SCREENSHOT_DIR) {
    const directory = path.resolve(process.env.RPGMAP_SMOKE_SCREENSHOT_DIR);
    await mkdir(directory, { recursive: true });
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(directory, 'packaged-sheets.png'), Buffer.from(capture.data, 'base64'));
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    for (const sheet of api.entities.listOpenSheets()) api.entities.closeSheet(sheet.key);
    api.entities.openActor('${ids.actor}', 'public-profile');
    return true;
  })()`);
  const mobileAudit = await retryWithSnapshot(() => evaluate(`(() => {
    const sheet = document.querySelector('.entity-sheet');
    if (!sheet?.querySelector('[data-public-profile-editor]')) return null;
    const rect = sheet.getBoundingClientRect();
    if (document.documentElement.scrollWidth > 390 || rect.left < 0 || rect.right > 390 || sheet.scrollWidth > sheet.clientWidth) throw new Error('390px sheet has horizontal overflow');
    return { viewport: innerWidth, sheetWidth: rect.width, scrollWidth: sheet.scrollWidth, clientWidth: sheet.clientWidth };
  })()`), '390px Actor sheet without horizontal overflow');
  if (process.env.RPGMAP_SMOKE_SCREENSHOT_DIR) {
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(path.resolve(process.env.RPGMAP_SMOKE_SCREENSHOT_DIR), 'packaged-sheet-mobile.png'), Buffer.from(capture.data, 'base64'));
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  if (failures.length) throw new Error(`Actor sheet browser requests failed: ${failures.join('; ')}`);
  if (exceptions.length) throw new Error(`Actor sheet browser runtime errors: ${exceptions.join('; ')}`);

  console.log(JSON.stringify({ ready, fixtureRevision: setup.revision, liveSheets: opened, drag: dragAudit, tabs: tabAudit,
    health: { fieldId: healthBefore.fieldId, change: healthChange, isolated: true }, status: statusAudit, restored: restoreAudit, playEdit: playEditAudit, drafts: draftAudit, publicProfile: publicProfileAudit,
    portrait: { reference: portraitAudit.reference, runtimePreserved: true }, mobile: mobileAudit }));
  await send('Browser.close');
  browserClosed = true;
} catch (error) {
  throw new Error(`${error.message}${edgeError ? `\nEdge stderr:\n${edgeError.slice(-4000)}` : ''}`);
} finally {
  if (!browserClosed && edge.exitCode === null) edge.kill('SIGKILL');
  if (edge.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2_000);
      edge.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    .catch(error => console.warn(`Actor sheet smoke profile cleanup deferred: ${error.message}`));
}
