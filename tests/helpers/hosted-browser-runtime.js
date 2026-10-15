import { readFileSync } from 'node:fs';
import { hostedRuntimeAdapters } from '../../src/adapters/hosted-runtime.js';
import { createHostedWorldSystem } from '../../src/world/hosted-system.js';
import { createMultiplayerController } from '../../src/multiplayer/controller.js';
import { createDocumentBackendSystem } from '../../src/documents/index.js';
import { applyDocumentChanges, documentChangeSet, createDocumentChanges } from '../../src/documents/changes.js';
import { registerRuntimeStateReader } from '../../src/engine/state-access.js';
import { readConnectionState } from '../../src/multiplayer/connection-state.js';
import { exportRuntimeState, prepareRuntimeState, validateRuntimeState } from '../../src/engine/runtime-state.js';
import { applyWorldOperations, WORLD_OPERATION_SCHEMA_VERSION } from '../../src/world/operations.js';
import { STATUS_SCHEMA_VERSION } from '../../src/status/model.js';
import { ACCESS_SCHEMA_VERSION } from '../../src/permissions/model.js';
import { infiniteHorrorRuleset as ruleset } from '../../src/rulesets/infinite-horror/index.js';

const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
class Element {
  constructor() { this.dataset = {}; this.style = { removeProperty() {} }; this.hidden = false; this.children = []; }
  append(child) { this.children.push(child); }
  prepend(child) { this.children.unshift(child); }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  remove() {}
  querySelector(selector) { return this.queries?.[selector] || null; }
  querySelectorAll() { return []; }
}
class Socket {
  static OPEN = 1;
  static instances = [];
  constructor() { this.listeners = new Map(); this.messages = []; this.readyState = 0; Socket.instances.push(this); }
  addEventListener(type, callback) { this.listeners.set(type, [...this.listeners.get(type) || [], callback]); }
  fire(type, event) { for (const callback of this.listeners.get(type) || []) callback(event); }
  send(text) { this.messages.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.fire('open', {}); }
  close() { this.readyState = 3; this.fire('close', {}); }
  async receive(message) { this.fire('message', { data: JSON.stringify(message) }); await settle(); }
}

// Execute the complete production Runtime body, replacing its import bindings
// for Leaflet/DOM rendering only. Canonical import, commit, counters, EventTarget,
// hosted adapter, session authority, controller and Document backend stay real.
const runtimeSource = readFileSync(new URL('../../src/engine/runtime.js', import.meta.url), 'utf8');
const runtimeBody = runtimeSource.slice(runtimeSource.indexOf('const MAX_SAVE_FILE_BYTES'))
  .replace('export function createRpgMapRuntime', 'function createRpgMapRuntime');
const dependencies = { readConnectionState, exportRuntimeState, prepareRuntimeState, validateRuntimeState,
  applyDocumentChanges, documentChangeSet, registerRuntimeStateReader,
  worldToLatLng: point => [point.y, point.x],
  createMapPresentation: () => ({ destroy() {} }), createMapGridRenderer: () => () => {},
  createMapViewportScheduler: () => ({ schedule() {}, dispose() {} }),
  createSceneRenderer: () => ({ render() {}, dispose() {} }),
  occlusionGeometryCacheStats: () => ({}),
  DOMParser: class { parseFromString() { return { querySelector: () => null, documentElement: {} }; } },
};

export async function hostedBrowserRuntime(t) {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket; Socket.instances = [];
  t.after(() => { globalThis.WebSocket = originalSocket; });
  const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
  const view = { performance: globalThis.performance,
    location: { protocol: 'http:', host: '127.0.0.1:30000', hostname: '127.0.0.1' },
    localStorage: storage(), sessionStorage: storage(),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} };
  const label = new Element(), toolbar = new Element(), shell = new Element(), status = new Element();
  shell.queries = { '.toolbar-right': toolbar, '[data-role="map-status"]': status };
  const document = { defaultView: view, head: new Element(), body: new Element(), getElementById: () => null,
    createElement() { const node = new Element(); node.queries = { '[data-mp-label]': label }; return node; } };
  const mapElement = new Element(); mapElement.ownerDocument = document; mapElement.closest = () => shell;
  const container = new Element(); container.ownerDocument = document;
  container.queries = { '#map': mapElement, '[data-role="app-title"]': new Element(),
    '[data-role="map-status"]': status, '[data-role="toasts"]': new Element(), '[data-role="modal-root"]': new Element() };
  const map = { getContainer: () => mapElement, createPane: () => ({ style: {} }), fitBounds() {}, remove() {} };
  const leaflet = { CRS: { Simple: {} }, map: () => map, latLngBounds: value => value,
    svgOverlay: () => ({ addTo() {} }), layerGroup: () => ({ addTo() { return this; } }) };
  const createRuntime = new Function(...Object.keys(dependencies), 'L', `${runtimeBody}\nreturn createRpgMapRuntime;`)
    (...Object.values(dependencies), leaflet);
  const mapPackage = { id: 'audit-map', version: '1', fingerprint: 'frozen-audit-map',
    width: 100, height: 100, metersPerUnit: 1, features: [], createSvg: () => '<svg/>' };
  const initialLoad = hostedRuntimeAdapters.prepare({ worldId: 'audit-world', worldName: 'Initial', mapPackage, ruleset });
  const api = createRuntime({ container, mapPackage, ruleset, storageAdapter: storage(), initialLoad,
    runtimeAdapters: hostedRuntimeAdapters,
    tools: [createHostedWorldSystem(), createDocumentBackendSystem(), createMultiplayerController()] });
  api.vision = { getSource: () => null };
  t.after(() => { api.emit('app:destroy'); api.destroy(); globalThis.WebSocket = originalSocket; });
  api.multiplayer.connect({ name: 'GM', requestedRole: 'gm', gmSecret: 'test-only' });
  const socket = Socket.instances.at(-1); socket.open();
  await socket.receive({ type: 'welcome', capabilities: { occlusion: 1 },
    operationSchema: WORLD_OPERATION_SCHEMA_VERSION, statusSchema: STATUS_SCHEMA_VERSION,
    accessSchema: ACCESS_SCHEMA_VERSION, world: { state: initialLoad.state, revision: 40 },
    session: { id: 'session', role: 'gm', identityStatus: 'active' },
    permissions: { worldWrite: true, manageAccess: true }, audienceRevision: 0, audienceFingerprint: 'audience' });
  let serverState = api.exportState(), serverRevision = 40;
  return { api, socket, settle, request: () => socket.messages.filter(message => message.type === 'document.batch').at(-1),
    async commit(operationId, operations) {
      const next = applyWorldOperations(serverState, operations, { ruleset, mapPackage, source: { role: 'gm' } }).state;
      const changes = createDocumentChanges(serverState, next), baseRevision = serverRevision++;
      serverState = next;
      await socket.receive({ type: 'document.batch.committed', operationId, baseRevision, revision: serverRevision,
        changes, results: [], updatedAt: next.preferences.worldV2.updatedAt });
      return { serverRevision, hostRevision: api.getStateRevision(), changes };
    },
  };
}
