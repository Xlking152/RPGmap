import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('NPC and monster imports refresh visible templates on canonical Actor changes without interaction', async () => {
  // Run the real panel with a minimal map adapter; no browser layout is required.
  const source = await readFile(new URL('../src/marker/system.js', import.meta.url), 'utf8');
  const factory = vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, '')
    .replace('export function createLightweightMarkerSystem', 'function createLightweightMarkerSystem')
    + '\ncreateLightweightMarkerSystem;', {
    structuredClone,
    L: { layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }) },
  });
  const handlers = new Map();
  const panel = { innerHTML: '', addEventListener() {} };
  const shell = { querySelector: () => null };
  const document = { getElementById: () => ({}), defaultView: {} };
  const container = { ownerDocument: document, closest: () => shell, addEventListener() {} };
  const world = { activeSceneId: 'scene', actors: [], scenes: [{ id: 'scene', tokens: [], markers: [] }] };
  const api = {
    map: { getContainer: () => container, getPane: () => ({ style: {} }) },
    uiPanels: { get: () => panel }, world: { get: () => structuredClone(world) },
    entities: { canImportXlsx: true },
    on(name, callback) { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list); return () => {}; },
  };
  factory().register(api);
  for (const type of ['npc', 'monster']) {
    const name = `${type}-imported`;
    assert.equal(panel.innerHTML.includes(name), false);
    world.actors.push({ id: name, name, type });
    for (const callback of handlers.get('actor:change') || []) callback({ detail: { actorIds: [name], canonical: true } });
    assert.equal(panel.innerHTML.includes(`data-marker-actor-open="${name}"`), true);
    assert.equal(world.scenes[0].tokens.length, 0);
  }
  world.actors = [];
  for (const callback of handlers.get('actor:change') || []) callback({ detail: { canonical: true } });
  assert.equal(panel.innerHTML.includes('npc-imported'), false);
  assert.equal(panel.innerHTML.includes('monster-imported'), false);
});
