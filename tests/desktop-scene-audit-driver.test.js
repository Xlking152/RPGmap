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
  const listeners = new Set();
  return { addEventListener(_type, callback) { listeners.add(callback); }, removeEventListener(_type, callback) { listeners.delete(callback); },
    sendMessage(value) { for (const callback of [...listeners]) callback({ data: JSON.stringify(value) }); }, count: () => listeners.size };
}

test('Scene observer waits for its exact protocol response and removes the listener on success', async () => {
  const ws = socket(), pending = nextMessage(ws, 'welcome');
  ws.sendMessage({ type: 'presence', clients: [] }); assert.equal(ws.count(), 1);
  ws.sendMessage({ type: 'welcome', identity: { status: 'active' } });
  assert.equal((await pending).identity.status, 'active'); assert.equal(ws.count(), 0);
});

test('Scene observer surfaces protocol errors instead of treating a failed identity as synchronized', async () => {
  const ws = socket(), pending = nextMessage(ws, 'welcome');
  ws.sendMessage({ type: 'error', code: 'identity_required' });
  await assert.rejects(pending, /identity_required/); assert.equal(ws.count(), 0);
});
