import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../scripts/desktop-browser-smoke.mjs', import.meta.url), 'utf8');
function functionFromDriver(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(end > start);
  return runInNewContext(`(${source.slice(start, end)})`, { structuredClone, JSON, setTimeout, clearTimeout, Error });
}
const capture = functionFromDriver('sceneAuditContent');
const explorationSettled = functionFromDriver('sceneAuditExplorationSettled');
const keyboardDiagnostic = functionFromDriver('desktopKeyboardDiagnostic');
const walMovements = functionFromDriver('desktopMovementWalResults');
const nextMessage = functionFromDriver('socketMessage');
const scene = () => ({ id: 'a', name: 'A', mapPackage: { id: 'lanzhou', version: '1.1.0', fingerprint: 'same-content' },
  tokens: [{ id: 't', x: 730.5, y: 450.5 }], markers: [], attackAreas: [],
  sceneEvents: [{ type: 'damage', featureId: 'house' }], featureStates: { door: { open: true } },
  occlusionShapes: [], fog: { exploredByParty: { party: { rows: { 90: [[140, 150]] } } } }, settings: { gridVisible: true } });

test('Scene audit compares detached persisted content rather than only identities', () => {
  const initial = scene(), captured = capture(initial);
  initial.tokens[0].x = 0; initial.featureStates.door.open = false;
  assert.equal(captured.tokens[0].x, 730.5);
  assert.equal(captured.featureStates.door.open, true);
  for (const mutate of [
    value => { value.mapPackage.version = '1.2.0'; },
    value => { value.mapPackage.fingerprint = 'other-content'; },
    value => { value.tokens[0].y = 445.5; },
    value => { value.featureStates.door.open = false; },
    value => { value.sceneEvents = []; },
    value => { value.fog.exploredByParty = {}; },
    value => { value.settings.gridVisible = false; },
  ]) {
    const changed = scene(); mutate(changed);
    assert.notDeepEqual(capture(changed), captured, 'A meaningful Scene or package change cannot pass through identity matching');
  }
});

test('Scene audit ignores unrelated projection metadata without weakening persisted content equality', () => {
  const before = scene(), after = { ...scene(), projectedAt: 'new audience', diagnostic: { revision: 900 } };
  assert.deepEqual(capture(before), capture(after));
});

function socket() {
  const listeners = new Map();
  const emit = (type, event) => { for (const callback of [...(listeners.get(type) || [])]) callback(event); };
  return { addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    sendMessage(value) { emit('message', { data: JSON.stringify(value) }); }, fail(error) { emit('error', { error }); }, close() { emit('close', {}); },
    count: () => [...listeners.values()].reduce((total, values) => total + values.size, 0) };
}

test('Scene observer waits for its exact protocol response and removes the listener on success', async () => {
  const ws = socket(), pending = nextMessage(ws, 'welcome');
  ws.sendMessage({ type: 'presence', clients: [] }); assert.equal(ws.count(), 3);
  ws.sendMessage({ type: 'welcome', identity: { status: 'active' } });
  assert.equal((await pending).identity.status, 'active'); assert.equal(ws.count(), 0);
});

test('Scene observer surfaces protocol errors instead of treating a failed identity as synchronized', async () => {
  const ws = socket(), pending = nextMessage(ws, 'welcome');
  ws.sendMessage({ type: 'error', code: 'identity_required' });
  await assert.rejects(pending, /identity_required/); assert.equal(ws.count(), 0);
});

test('Scene observer rejects transport failures and premature close without leaving listeners', async () => {
  const failed = socket(), rejected = nextMessage(failed, 'welcome');
  failed.fail(new Error('handshake refused'));
  await assert.rejects(rejected, /handshake refused/); assert.equal(failed.count(), 0);
  const closed = socket(), interrupted = nextMessage(closed, 'welcome');
  closed.close();
  await assert.rejects(interrupted, /closed while waiting for welcome/); assert.equal(closed.count(), 0);
});

test('Both successful and failed desktop audit evidence record the observer transport hash', () => {
  for (const outcome of ['passed', 'failed']) {
    const record = source.split('\n').find(line => line.includes('writeFile(recordFile,') && line.includes(`outcome: '${outcome}'`));
    assert.ok(record?.includes('driverSha256, observerTransportSha256,'), `${outcome} evidence must identify both driver modules`);
  }
});

test('Scene audit waits for its Actor party Fog and an empty durable background queue', () => {
  const snapshot = { state: { preferences: { worldV2: { scenes: [scene()] } } }, exploration: { jobs: {} } };
  assert.equal(explorationSettled(snapshot, 'a', 'party'), true);
  assert.equal(explorationSettled(snapshot, 'a', 'desktop-audit'), false);
  assert.equal(explorationSettled(snapshot, 'other-scene', 'party'), false);
  snapshot.exploration.jobs.source = { sceneId: 'a', partyId: 'party' };
  assert.equal(explorationSettled(snapshot, 'a', 'party'), false, 'Visible rows alone do not prove that all durable work has finished');
  snapshot.exploration.jobs = {};
  snapshot.state.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows = {};
  assert.equal(explorationSettled(snapshot, 'a', 'party'), false);
  delete snapshot.exploration;
  assert.equal(explorationSettled(snapshot, 'a', 'party'), false, 'A projected snapshot without private queue metadata cannot prove completion');
});

test('Scene audit uses authenticated vision requests and never submits the server-only explore intent', () => {
  assert.doesNotMatch(source, /scene\.fog\.explore/);
  assert.match(source, /actor\.partyId/);
  assert.match(source, /type:'token\.upsert'[\s\S]*vision:\{\.\.\.token\.vision,enabled:true/);
  assert.match(source, /type:'scene\.settings\.patch',payload:\{sceneId,patch:\{lineOfSightEnabled:true\}\}/);
  assert.match(source, /await api\.multiplayer\.setVisionSource\(token\.id\)/);
  assert.match(source, /await api\.multiplayer\.setVisionSource\(null\)/);
  assert.match(source, /vision:\{\.\.\.token\.vision,enabled:false\}/);
  assert.match(source, /wal\.replay\(snapshot, \{ repairTail: false \}\)/);
});

test('Desktop input diagnostics observe movement keys without intercepting events or capturing arbitrary text', () => {
  let prevented = false;
  const input = { type: 'keydown', key: 'W', code: 'KeyW', repeat: true, isTrusted: true, target: { tagName: 'DIV' },
    preventDefault() { prevented = true; }, stopPropagation() { prevented = true; } };
  const result = keyboardDiagnostic(input, { x: 730.5, y: 450.5 });
  assert.equal(result.key, 'W'); assert.equal(result.code, 'KeyW'); assert.equal(result.repeat, true); assert.equal(result.isTrusted, true);
  assert.equal(result.targetTag, 'DIV'); assert.equal(result.tokenPosition.x, 730.5); assert.equal(result.tokenPosition.y, 450.5);
  assert.equal(prevented, false);
  assert.equal(keyboardDiagnostic({ ...input, key: 'x', code: 'KeyX', target: { tagName: 'INPUT' } }, null), null);
  assert.equal(keyboardDiagnostic({ ...input, key: 'ArrowUp', code: 'ArrowUp', type: 'keyup' }, null).type, 'keyup');
  assert.equal(keyboardDiagnostic({ ...input, key: 'Shift', code: 'ShiftLeft' }, null).key, 'Shift');
  assert.match(source, /for\(const type of \['keydown','keyup'\]\)/);
  assert.match(source, /\{capture:true,passive:true\}/);
  assert.doesNotMatch(keyboardDiagnostic.toString(), /preventDefault|stopPropagation|dispatchKeyEvent/);
  assert.match(source, /movementKeyEventCount:window\.__desktopSmokeKeyboardTrace\.length/);
});

test('Desktop WAL diagnostics report each actual movement method once instead of copied operation history', () => {
  const drag = { operationId: 'drag', revision: 16, results: [{ motion: [{ tokenId: 't', method: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 2 } }] }] };
  const keyboard = { operationId: 'key', revision: 17, results: [{ motion: [{ tokenId: 't', method: 'keyboard', from: { x: 3, y: 2 }, to: { x: 3, y: 1 } }] }] };
  const records = [
    { operationId: 'drag', revision: 16, results: [drag] },
    { operationId: 'key', revision: 17, results: [drag, keyboard] },
  ];
  const movements = walMovements(records, 't', 15);
  assert.equal(movements.length, 2); assert.equal(movements[0].method, 'drag'); assert.equal(movements[1].method, 'keyboard');
  assert.equal(walMovements(records, 't', 16).length, 1);
  assert.equal(walMovements(records, 'other', 15).length, 0);
});
