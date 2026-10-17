import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createVisionPanelActions, readVisionPanelState, renderVisionPanel } from '../src/ui/vision-panel.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';

function fixture({ role = 'gm', connected = false, confirmed = true } = {}) {
  const actors = [{ id: 'a', name: 'Scout', partyId: 'party-a' }, { id: 'b', name: 'Other', partyId: 'party-b' }];
  const scene = { id: 's', name: 'Scene', settings: { lighting: 'normal', extension: 'keep' },
    tokens: [{ id: 't', actorId: 'a', name: 'Scout', placement: 'map', x: 10, y: 20, light: { enabled: true, rangeMeters: 8, intensity: 2 } },
      { id: 'enemy', actorId: 'b', name: 'Other', placement: 'map', x: 30, y: 40 }],
    fog: { exploredByParty: { 'party-a': { rows: { 0: [[0, 2]] } } } } };
  const world = { activeSceneId: 's', actors, scenes: [scene] };
  const calls = [], connection = { connected, session: { role } };
  const api = {
    mapPackage: { lights: [{ id: 'static-light', name: 'Gate light', x: 5, y: 5, rangeMeters: 6 }] },
    multiplayer: { getConnectionState: () => connection, canControlToken: id => id === 't' },
    world: { get: () => world, performOperations: async (operations, options) => calls.push({ operations, options }) },
    tokens: { update: async (id, patch) => calls.push({ id, patch }) },
    vision: { getSource: () => 't', getVisibleRegion: () => ({ preciseRangeMeters: 40, vagueRangeMeters: 60 }),
      setSource: async id => calls.push({ source: id }),
      resetExplored: async (partyId, options) => calls.push({ reset: partyId, options }),
      hideExplored: async (partyId, circle, options) => calls.push({ hide: partyId, circle, options }) },
  };
  registerRuntimeStateReader(api, () => ({ preferences: { worldV2: world } }));
  const actions = createVisionPanelActions(api, { confirm: () => confirmed });
  return { api, actions, calls, scene, world, connection };
}

test('vision panel reads projected sources only and hides privileged controls from players', () => {
  const f = fixture({ connected: true, role: 'player' });
  const state = readVisionPanelState(f.api);
  assert.equal(state.gm, false);
  assert.deepEqual(state.sources.map(source => source.id), ['t']);
  assert.deepEqual(state.lights, []);
  const html = renderVisionPanel(state);
  assert.doesNotMatch(html, /data-vision-mode|data-vision-reset|data-vision-hide|data-vision-light-token/);
  assert.match(html, /data-vision-lighting="dark"[^>]+disabled/);
  assert.match(html, /data-vision-source/);
});

test('vision panel GM actions preserve scene fields and use existing authoritative APIs', async () => {
  const f = fixture({ connected: true });
  assert.equal(readVisionPanelState(f.api).gm, true);
  await f.actions.setSource(null);
  await f.actions.setSource('enemy');
  await f.actions.setLighting('dark');
  await f.actions.setLight('t', false);
  assert.deepEqual(f.calls[0], { source: null });
  assert.deepEqual(f.calls[1], { source: 'enemy' });
  assert.equal(f.calls[2].operations[0].type, 'scene.upsert');
  assert.deepEqual(f.calls[2].operations[0].payload.scene.settings, { lighting: 'dark', extension: 'keep' });
  assert.deepEqual(f.calls[2].operations[0].payload.scene.tokens, f.scene.tokens);
  assert.deepEqual(f.calls[3], { id: 't', patch: { light: { enabled: false, rangeMeters: 8, intensity: 2 } } });
  assert.equal(f.scene.settings.lighting, 'normal', 'UI never mutates canonical data before acknowledgement');
  assert.equal(f.scene.tokens[0].light.enabled, true);
});

test('forged UI requests and disconnected player sessions never submit GM operations', async () => {
  for (const connected of [true, false]) {
    const f = fixture({ connected, role: 'player' });
    f.connection.retainsServerState = !connected;
    for (const run of [() => f.actions.setSource(null), () => f.actions.setLighting('dark'),
      () => f.actions.setLight('t', false), () => f.actions.resetExplored('party-a'),
      () => f.actions.hideExplored('party-a', { x: 20, y: 20, radiusMeters: 10 }, 's')]) {
      await assert.rejects(run, { code: 'vision_panel_gm_only' });
    }
    await assert.rejects(() => f.actions.setSource('enemy'), { code: 'vision_source_forbidden' });
    assert.equal(f.calls.length, 0);
    await f.actions.setSource('t');
    assert.deepEqual(f.calls, [{ source: 't' }]);
  }
});

test('reset requires confirmation and hide rejects stale scene, unknown party and invalid radius', async () => {
  const canceled = fixture({ confirmed: false });
  await canceled.actions.resetExplored('party-a');
  assert.deepEqual(canceled.calls, []);
  const f = fixture();
  await f.actions.resetExplored('party-a');
  await f.actions.hideExplored('party-a', { x: 20, y: 25, radiusMeters: 15 }, 's');
  assert.deepEqual(f.calls, [{ reset: 'party-a', options: { sceneId: 's' } },
    { hide: 'party-a', circle: { x: 20, y: 25, radiusMeters: 15 }, options: { sceneId: 's' } }]);
  await assert.rejects(() => f.actions.hideExplored('party-a', { x: 20, y: 25, radiusMeters: 15 }, 'stale'));
  await assert.rejects(() => f.actions.resetExplored('missing'));
  await assert.rejects(() => f.actions.hideExplored('party-a', { x: Infinity, y: 25, radiusMeters: 15 }, 's'));
  assert.equal(f.calls.length, 2);
});

test('panel shows authoritative light data, escapes names and preserves compact responsive controls', async () => {
  const f = fixture();
  f.scene.name = '<script>scene</script>';
  f.scene.tokens[0].name = '<img src=x onerror=alert(1)>';
  const html = renderVisionPanel(readVisionPanelState(f.api), { partyId: 'party-a', busy: true });
  assert.match(html, /&lt;script&gt;scene/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /Gate light/);
  assert.match(html, /地图光源 · 只读/);
  assert.match(html, /data-vision-light-token="t" checked disabled/);
  assert.match(html, /规则启用/);
  assert.doesNotMatch(html, /data-vision-los-toggle/);
  const css = await readFile(new URL('../src/ui/vision-panel.css', import.meta.url), 'utf8');
  assert.match(css, /grid-template-columns:36px minmax\(0,1fr\) 30px/);
  assert.match(css, /@media\(max-width:760px\)/);
});
