import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Final sheet browser smoke requires Windows Edge');
const targetUrl = String(process.argv[2] || '').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/?/.test(targetUrl)) throw new Error('Final sheet smoke requires a loopback HTTP URL');
const timeoutMs = Math.max(20_000, Number(process.argv[3]) || 45_000);

function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    for (const suffix of [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Microsoft', 'Edge SxS', 'Application', 'msedge.exe'],
    ]) {
      const candidate = path.join(root, ...suffix);
      if (existsSync(candidate)) return candidate;
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-sheet-final-smoke-'));
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
  const exceptions = [];
  const rejectPending = message => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    pending.clear();
  };
  socket.addEventListener('close', () => rejectPending('Edge CDP WebSocket closed'));
  socket.addEventListener('error', () => rejectPending('Edge CDP WebSocket failed'));
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      return message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
    if (message.method === 'Network.loadingFailed' && message.params?.errorText !== 'net::ERR_ABORTED') failures.push(message.params?.errorText || 'request failed');
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) >= 400) failures.push(`${message.params.response.status} ${message.params.response.url}`);
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails;
      exceptions.push(detail?.exception?.description || detail?.text || 'runtime exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args || []).map(arg => arg.value ?? arg.unserializableValue ?? arg.description ?? '').filter(Boolean).join(' ');
      exceptions.push(text || 'browser console error');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') exceptions.push(message.params.entry.text || 'browser log error');
  });

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

  await Promise.all([send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);

  const ready = await retry(() => evaluate(`(() => {
    const api = document.querySelector('#app')?.rpgMapApp;
    const mp = api?.multiplayer?.getStatus?.();
    const status = document.querySelector('[data-role="map-status"]')?.textContent || '';
    return api?.world?.performOperations && api?.entities?.openActor && api?.entities?.openToken
      && mp?.connected === true && mp?.session?.role === 'gm' && mp?.permissions?.worldWrite === true
      && /^联机同步完成/.test(status)
      ? { revision: mp.revision, status }
      : null;
  })()`), 'authoritative GM runtime after initial sync', deadline);

  const ids = Object.freeze({
    pcActor: 'smoke-sheet-final-pc', pcToken: 'smoke-sheet-final-pc-token',
    npcActor: 'smoke-sheet-final-npc', npcToken: 'smoke-sheet-final-npc-token',
  });

  const snapshot = label => evaluate(`(() => {
    const api = document.querySelector('#app')?.rpgMapApp;
    return {
      label: ${JSON.stringify(label)},
      revision: api?.multiplayer?.getStatus?.()?.revision || null,
      activeSceneId: api?.world?.get?.()?.activeSceneId || null,
      actors: ['${ids.pcActor}','${ids.npcActor}'].map(actorId => (api?.world?.get?.()?.actors || []).find(actor => String(actor.id) === actorId) || null),
      tokens: ['${ids.pcToken}','${ids.npcToken}'].map(tokenId => api?.tokens?.get?.(tokenId) || null),
      records: api?.entities?.listOpenSheets?.() || [],
      sheets: [...document.querySelectorAll('.entity-sheet')].map(sheet => ({
        key: sheet.dataset.sheetWindowKey || '', actorId: sheet.dataset.actorId || '', tokenId: sheet.dataset.tokenId || '',
        sceneId: sheet.dataset.sceneId || '', mode: sheet.dataset.sheetMode || '', kind: sheet.dataset.sheetKind || '',
        interactionMode: sheet.dataset.sheetInteractionMode || '', tab: sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '',
        width: sheet.getBoundingClientRect().width, height: sheet.getBoundingClientRect().height,
      })),
      mapStatus: document.querySelector('[data-role="map-status"]')?.textContent || '',
    };
  })()`);
  const retryWithSnapshot = async (task, label) => {
    try { return await retry(task, label, deadline); }
    catch (error) { throw new Error(`${error.message}; snapshot=${JSON.stringify(await snapshot(label))}; browserErrors=${JSON.stringify(exceptions)}`); }
  };

  const fixture = await evaluate(`(async () => {
    const api = document.querySelector('#app').rpgMapApp;
    const actorIds = ['${ids.pcActor}','${ids.npcActor}'];
    const existing = new Set((api.world.get().actors || []).map(actor => String(actor.id)));
    const resets = actorIds.filter(actorId => existing.has(actorId)).map(actorId => ({ type: 'actor.delete', payload: { actorId } }));
    if (resets.length) await api.world.performOperations(resets, { source: 'smoke:final:reset' });
    const imported = name => ({
      formName: 'Smoke Form', identity: { name }, description: {}, resources: { hp: { max: 20 } },
      attributes: [], checks: { skills: [], saves: [] }, badStatuses: [], combat: { attacks: [], defenses: [] }, detection: {},
      tokenAppearance: { color: '#557f83', scale: 1 }, source: { type: 'manual' },
    });
    const pcCreated = api.ruleset.actor.createFromImport(imported('Smoke PC'), { actorId: '${ids.pcActor}', name: 'Smoke PC' });
    const npcCreated = api.ruleset.actor.createFromImport(imported('Smoke NPC'), { actorId: '${ids.npcActor}', name: 'Smoke NPC' });
    const pcActor = { ...pcCreated, id: '${ids.pcActor}', name: 'Smoke PC', type: 'pc', partyId: null, effects: [] };
    const npcActor = { ...npcCreated, id: '${ids.npcActor}', name: 'Smoke NPC', type: 'npc', partyId: null, effects: [] };
    const sceneId = api.world.get().activeSceneId;
    const commit = await api.world.performOperations([
      { type: 'actor.upsert', payload: { actor: pcActor } },
      { type: 'actor.upsert', payload: { actor: npcActor } },
      { type: 'token.create', payload: { sceneId, token: { id: '${ids.pcToken}', actorId: '${ids.pcActor}', actorLink: true, placement: 'map', x: 120, y: 80, diameterMeters: 1, visibility: { mode: 'public', userIds: [] }, effects: [] } } },
      { type: 'token.create', payload: { sceneId, token: { id: '${ids.npcToken}', actorId: '${ids.npcActor}', actorLink: false, placement: 'map', x: 140, y: 80, diameterMeters: 1, visibility: { mode: 'public', userIds: [] }, effects: [] } } },
    ], { source: 'smoke:final:setup' });
    const pcToken = api.tokens.get('${ids.pcToken}'), npcToken = api.tokens.get('${ids.npcToken}');
    const present = Boolean(pcToken && npcToken && api.world.get().actors.some(actor => String(actor.id) === '${ids.pcActor}') && api.world.get().actors.some(actor => String(actor.id) === '${ids.npcActor}'));
    if (present) {
      await api.entities.openToken('${ids.pcToken}');
      await api.entities.openToken('${ids.npcToken}');
      await api.entities.openActor('${ids.pcActor}');
      await api.entities.openActor('${ids.npcActor}');
    }
    return { sceneId, commit, present, pcActorLink: pcToken?.actorLink, npcActorLink: npcToken?.actorLink, revision: api.multiplayer.getStatus().revision };
  })()`);
  if (!fixture?.present) throw new Error(`final fixture failed: ${JSON.stringify(fixture)}; snapshot=${JSON.stringify(await snapshot('fixture'))}`);

  const cards = await retryWithSnapshot(() => evaluate(`(() => {
    const tokenSheet = tokenId => document.querySelector('.entity-sheet[data-token-id="' + tokenId + '"]');
    const actorSheet = actorId => [...document.querySelectorAll('.entity-sheet[data-actor-id="' + actorId + '"]')].find(sheet => !String(sheet.dataset.tokenId || ''));
    const pcToken = tokenSheet('${ids.pcToken}'), npcToken = tokenSheet('${ids.npcToken}');
    const pcActor = actorSheet('${ids.pcActor}'), npcActor = actorSheet('${ids.npcActor}');
    if (![pcToken,npcToken,pcActor,npcActor].every(Boolean)) return null;
    const info = sheet => ({
      kind: sheet.dataset.sheetKind || '', mode: sheet.dataset.sheetMode || '', interactionMode: sheet.dataset.sheetInteractionMode || '',
      tab: sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '', key: sheet.dataset.sheetWindowKey || '',
      toggle: Boolean(sheet.querySelector('[data-sheet-v2-mode-toggle]')),
    });
    const result = { pcToken: info(pcToken), npcToken: info(npcToken), pcActor: info(pcActor), npcActor: info(npcActor) };
    if (result.pcToken.kind !== 'character' || result.pcToken.tab !== 'overview') return null;
    if (result.npcToken.kind !== 'npc' || result.npcToken.tab !== 'overview' || result.npcToken.mode !== 'instance') return null;
    if (result.pcActor.kind !== 'character' || result.pcActor.tab !== 'overview' || result.pcActor.interactionMode !== 'play' || !result.pcActor.toggle) return null;
    if (result.npcActor.kind !== 'npc' || result.npcActor.tab !== 'overview' || result.npcActor.interactionMode !== 'play' || !result.npcActor.toggle) return null;
    if (new Set(Object.values(result).map(item => item.key)).size !== 4) return null;
    return result;
  })()`), 'Character/NPC Actor and Token cards');

  if (fixture.pcActorLink !== true || fixture.npcActorLink !== false) {
    throw new Error(`Linked/Unlinked fixture mismatch: ${JSON.stringify(fixture)}`);
  }

  const linkedHealthBefore = await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const token = api.health?.resolveToken?.('${ids.pcToken}'), actor = api.health?.resolveActor?.('${ids.pcActor}');
    const input = document.querySelector('.entity-sheet[data-token-id="${ids.pcToken}"] [data-health-field-id]:not([disabled])');
    return token && actor && input && JSON.stringify(token) === JSON.stringify(actor)
      ? { token, actor, fieldId: input.dataset.healthFieldId, value: Number(input.value) }
      : null;
  })()`), 'Linked PC Token shares Actor Health');
  const linkedHealthChange = await evaluate(`(() => {
    const input = document.querySelector('.entity-sheet[data-token-id="${ids.pcToken}"] [data-health-field-id="${linkedHealthBefore.fieldId}"]:not([disabled])');
    const current = Number(input.value), min = input.min === '' ? 0 : Number(input.min), max = input.max === '' ? Infinity : Number(input.max);
    let next = current > min ? current - 1 : current + 1;
    if (Number.isFinite(max)) next = Math.min(max, next);
    if (next === current) throw new Error('Linked PC Health field has no editable neighboring value');
    input.value = String(next); input.dispatchEvent(new Event('change', { bubbles: true }));
    return { current, next };
  })()`);
  const linkedHealthAfter = await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const token = api.health.resolveToken('${ids.pcToken}'), actor = api.health.resolveActor('${ids.pcActor}');
    return JSON.stringify(token) !== ${JSON.stringify(JSON.stringify(linkedHealthBefore.token))} && JSON.stringify(token) === JSON.stringify(actor)
      ? { token, actor }
      : null;
  })()`), 'Linked PC Health mutation remains shared');

  const resizeBefore = await evaluate(`(() => {
    const pc = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(sheet => !String(sheet.dataset.tokenId || ''));
    const npc = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.npcActor}"]')].find(sheet => !String(sheet.dataset.tokenId || ''));
    const a = pc.getBoundingClientRect(), b = npc.getBoundingClientRect();
    return { pc: { width:a.width,height:a.height }, npc: { width:b.width,height:b.height } };
  })()`);
  const requestedSize = { width: Math.round(resizeBefore.pc.width + 92), height: Math.round(resizeBefore.pc.height + 68) };
  await evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(node => !String(node.dataset.tokenId || ''));
    const rect = sheet.getBoundingClientRect();
    sheet.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, button:0, clientX:rect.right-2, clientY:rect.bottom-2 }));
    sheet.style.width = '${requestedSize.width}px'; sheet.style.height = '${requestedSize.height}px';
    sheet.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, button:0, clientX:rect.left+${requestedSize.width}-2, clientY:rect.top+${requestedSize.height}-2 }));
    return true;
  })()`);
  const resizeCaptured = await retryWithSnapshot(() => evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const record = (api.entities.listOpenSheets?.() || []).find(item => item.key === 'actor:${ids.pcActor}');
    const npc = (api.entities.listOpenSheets?.() || []).find(item => item.key === 'actor:${ids.npcActor}');
    if (!record || Math.abs(Number(record.width)-${requestedSize.width}) > 2 || Math.abs(Number(record.height)-${requestedSize.height}) > 2) return null;
    if (npc?.width != null && Math.abs(Number(npc.width)-${requestedSize.width}) < 2) return null;
    return { width:record.width, height:record.height, npcWidth:npc?.width ?? null, npcHeight:npc?.height ?? null };
  })()`), 'native resize geometry captured independently');

  await evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(node => !String(node.dataset.tokenId || ''));
    sheet.querySelector('[data-sheet-tab="status"]').click();
    return true;
  })()`);
  const resizeAfterRender = await retryWithSnapshot(() => evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(node => !String(node.dataset.tokenId || ''));
    const rect = sheet?.getBoundingClientRect();
    return rect && Math.abs(rect.width-${requestedSize.width}) <= 2 && Math.abs(rect.height-${requestedSize.height}) <= 2
      ? { width:rect.width, height:rect.height, tab:sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab }
      : null;
  })()`), 'resized geometry survives sheet rerender');

  await evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(node => !String(node.dataset.tokenId || ''));
    sheet.querySelector('[data-sheet-action="close"]').click();
    return true;
  })()`);
  await retryWithSnapshot(() => evaluate(`!([...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(node => !String(node.dataset.tokenId || '')))`), 'resized Character Actor close');
  await evaluate(`document.querySelector('#app').rpgMapApp.entities.openActor('${ids.pcActor}')`);
  const resizeReopened = await retryWithSnapshot(() => evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(node => !String(node.dataset.tokenId || ''));
    const rect = sheet?.getBoundingClientRect();
    return rect && Math.abs(rect.width-${requestedSize.width}) <= 2 && Math.abs(rect.height-${requestedSize.height}) <= 2
      ? { width:rect.width, height:rect.height, tab:sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab }
      : null;
  })()`), 'resized geometry survives close and reopen');

  const playEdit = await retryWithSnapshot(() => evaluate(`(() => {
    const sheet = [...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(node => !String(node.dataset.tokenId || ''));
    const toggle = sheet?.querySelector('[data-sheet-v2-mode-toggle]');
    if (!sheet || !toggle || sheet.dataset.sheetInteractionMode !== 'play') return null;
    toggle.click();
    const after = sheet.dataset.sheetInteractionMode;
    toggle.click();
    return after === 'edit' && sheet.dataset.sheetInteractionMode === 'play' ? { before:'play', edit:after, restored:sheet.dataset.sheetInteractionMode } : null;
  })()`), 'Character Actor Play/Edit/Play');

  await new Promise(resolve => setTimeout(resolve, 400));
  if (failures.length) throw new Error(`Final sheet browser requests failed: ${failures.join('; ')}`);
  if (exceptions.length) throw new Error(`Final sheet browser runtime errors: ${exceptions.join('; ')}`);

  console.log(JSON.stringify({
    ready, fixtureRevision: fixture.revision,
    cards, linked: { pcActorLink: fixture.pcActorLink, npcActorLink: fixture.npcActorLink, healthChange: linkedHealthChange, shared: Boolean(linkedHealthAfter) },
    resize: { before: resizeBefore, requested: requestedSize, captured: resizeCaptured, rerender: resizeAfterRender, reopened: resizeReopened },
    playEdit,
  }));
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
    .catch(error => console.warn(`Final sheet smoke profile cleanup deferred: ${error.message}`));
}
