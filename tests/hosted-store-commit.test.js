import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { CombatStore } from '../src/combat/store.js';
import { ChatStore } from '../src/chat/store.js';
import { EntityStore } from '../src/entities/store.js';
import * as combatModel from '../src/combat/model.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const kinds = [
  ['combat', CombatStore, 'combatSystem', store => { store.state.combat = combatModel.createCombat([{ tokenId: 'token' }]); }],
  ['chat', ChatStore, 'chatSystem', store => { store.state.messages.push({ id: 'message', type: 'chat', text: 'pending', createdAt: '2026-10-14T00:00:00Z' }); }],
  ['entities', EntityStore, 'entitySystem', store => { store.state.statusDefinitions.push({ id: 'test-status', name: 'pending' }); }],
];

for (const [name, Store, key, mutate] of kinds) {
  for (const rejected of [false, true]) {
    test(`${name} store waits for hosted confirmation and ${rejected ? 'restores canonical data on refusal' : 'reloads the confirmed projection'}`, async () => {
      let resolve, reject, candidate;
      let canonical = { preferences: {} };
      const events = [];
      const api = { getState: () => structuredClone(canonical), emit: (type, detail) => events.push({ type, detail }),
        commitState(next) { candidate = structuredClone(next); return new Promise((yes, no) => { resolve = yes; reject = no; }); } };
      const store = new Store(api); store.load({ migrateLegacy: false, dropMarkers: false });
      const before = structuredClone(store.state); mutate(store);
      const pending = store.persist();
      assert.equal(store.saving, true); assert.equal(store.commitPending, true);
      assert.deepEqual(canonical, { preferences: {} });
      assert.throws(() => store.persist(), { code: 'store_commit_pending' });
      if (rejected) {
        reject(Object.assign(new Error('server denied'), { code: 'permission_denied' }));
        await assert.rejects(pending, { code: 'permission_denied' });
        assert.deepEqual(store.state, before);
        assert.deepEqual(events.map(event => event.type), ['state:commit-failed']);
      } else {
        canonical = candidate; resolve({ revision: 7 }); await pending;
        const confirmed = new Store({ getState: () => structuredClone(canonical) });
        confirmed.load({ migrateLegacy: false, dropMarkers: false });
        assert.deepEqual(store.state, confirmed.state);
        assert.ok(canonical.preferences[key]);
        assert.deepEqual(events.map(event => event.type), ['state:commit-complete']);
      }
      assert.equal(store.saving, false); assert.equal(store.commitPending, false);
    });
  }
}

test('standalone store commits preserve synchronous return values', async () => {
  let canonical = { preferences: {} };
  const api = { getState: () => structuredClone(canonical), commitState(next) { canonical = structuredClone(next); } };
  const store = new CombatStore(api); store.load();
  store.state.combat = combatModel.createCombat([{ tokenId: 'token' }]);
  assert.equal(store.persist(), true);
  assert.ok(canonical.preferences.combatSystem.combat);
  assert.equal(store.saving, true); await tick(); assert.equal(store.saving, false);
});

// Execute the real controller against a small DOM/Leaflet facade. The actual
// CombatStore and combat model retain their production commit behavior.
async function controllerFixture() {
  const created = [], events = new Map(), status = { textContent: '' }, chat = [];
  const node = () => ({ style: {}, classList: { toggle() {} }, listeners: new Map(),
    querySelector: () => null, querySelectorAll: () => [], append() {},
    addEventListener(type, listener) { this.listeners.set(type, listener); } });
  const shell = { querySelector: selector => selector === '[data-role="map-status"]' ? status : null };
  const documentNode = { createElement() { const value = node(); created.push(value); return value; } };
  const mapElement = { ownerDocument: documentNode, parentElement: node(), closest: () => shell };
  let canonical = { preferences: {} }, resolve, reject, commits = 0;
  const api = { map: { getContainer: () => mapElement, getPane: () => null, createPane: () => ({ style: {} }) },
    mapPackage: { height: 100 }, getState: () => structuredClone(canonical),
    tokens: { get: id => ({ id, placement: 'map', x: 5, y: 5 }) },
    chat: { combat: (...args) => chat.push(args) },
    on(type, handler) { events.set(type, [...events.get(type) || [], handler]); },
    emit(type, detail) { for (const handler of events.get(type) || []) handler({ detail }); },
    commitState(next) { commits++; return new Promise((yes, no) => { resolve = () => { canonical = structuredClone(next); yes({ revision: 3 }); }; reject = no; }); },
  };
  const source = (await readFile(new URL('../src/combat/controller.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from\s*['"][^'"]+['"];?\r?\n/gm, '').replace(/export function /g, 'function ');
  const factory = runInNewContext(`${source}\ncreateCombatController;`, { ...combatModel, CombatStore,
    L: { layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }), circleMarker: () => ({ addTo() {} }) },
    installCombatStyles() {}, renderCombatTracker() {}, renderCombatTopbar() {}, describeActor: () => null,
    worldToLatLng: point => point, getComputedStyle: () => ({ position: 'relative' }), window: { confirm: () => true } });
  factory({ selection: { getSelectedTokenIds: () => ['token'] } }).register(api);
  const action = value => created[1].listeners.get('click')({ target: { closest: () => ({ dataset: { combatAction: value } }) }, preventDefault() {} });
  return { api, action, status, chat, commits: () => commits, resolve: () => resolve(), reject: error => reject(error), state: () => canonical };
}

for (const rejected of [false, true]) test(`combat UI ${rejected ? 'reports refusal without a success chat' : 'announces success only after ACK'}`, async () => {
  const f = await controllerFixture(); f.action('enter');
  assert.equal(f.commits(), 1); assert.equal(f.chat.length, 0);
  assert.equal(f.state().preferences.combatSystem, undefined);
  f.action('enter'); assert.equal(f.commits(), 1, 'pending action cannot submit twice');
  if (rejected) f.reject(new Error('permission denied')); else f.resolve();
  await tick();
  if (rejected) {
    assert.match(f.status.textContent, /战斗操作失败/); assert.equal(f.chat.length, 0);
    assert.equal(f.state().preferences.combatSystem, undefined);
  } else {
    assert.match(f.status.textContent, /已建立战斗/); assert.equal(f.chat.length, 1);
    assert.ok(f.state().preferences.combatSystem.combat);
  }
});
