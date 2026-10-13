import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { buildMapArchive } from '../src/packages/map-archive.js';
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { createDefaultActor } from '../src/actor/index.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { minimalRuleset } from '../src/rulesets/minimal/index.js';
import { prepareRuleset } from '../src/ruleset/contract.js';
import { buildRulesetArchive } from '../deployment/local-server/ruleset-store.mjs';
import { projectWorldV2ToRuntimeState } from '../src/world/model.js';

const rule = { id: infiniteHorrorRuleset.id, version: infiniteHorrorRuleset.version };
const ref = map => ({ id: map.id, version: map.version });
function receive(ws, predicate) {
  return new Promise((resolve, reject) => {
    const recent = [];
    const timer = setTimeout(() => { cleanup(); reject(new Error(`protocol timeout: ${JSON.stringify(recent)}`)); }, 7000);
    const handler = event => {
      const message = JSON.parse(String(event.data));
      recent.push(message); if (recent.length > 3) recent.shift();
      if (!predicate(message)) return;
      cleanup(); resolve(message);
    };
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener('message', handler); };
    ws.addEventListener('message', handler);
  });
}
async function runtime(root) {
  const child = spawn(process.execPath, ['deployment/local-server/server.mjs'], {
    env: { ...process.env, RPGMAP_DATA_DIR: root, RPGMAP_MANAGER_SECRET: 'fixture-manager',
      RPGMAP_GM_SECRET: 'fixture-gm', PORT: '0', NODE_ENV: 'test', RPGMAP_TEST_ALLOW_MISSING_ORIGIN: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'startup timeout')), 8000);
    child.stdout.on('data', bytes => { output += bytes; const found = /Local\s+: http:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (found) { clearTimeout(timer); resolve(Number(found[1])); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`startup exited ${code}: ${stderr}`)); });
  });
  const url = `http://127.0.0.1:${port}`, sockets = [];
  const api = (route, { method = 'GET', body, manager = true, token } = {}) => fetch(`${url}${route}`, {
    method, headers: { Origin: url, ...(manager ? { 'x-rpgmap-manager': 'fixture-manager' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const request = async (route, options) => { const response = await api(route, options); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; };
  const connect = async (role, identity = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const health = await request('/api/health');
    const welcome = receive(ws, value => value.type === 'welcome' || value.type === 'error');
    ws.send(JSON.stringify({ type: 'hello', requestedRole: role, name: role, capabilities: { occlusion: 1 },
      operationSchema: health.operationSchema, statusSchema: health.statusSchema, accessSchema: health.accessSchema,
      ...(role === 'gm' ? { gmSecret: 'fixture-gm' } : {}), ...identity }));
    const result = await welcome; assert.equal(result.type, 'welcome', JSON.stringify(result));
    return { ws, welcome: result };
  };
  const exited = new Promise(resolve => child.once('exit', resolve));
  return { child, url, api, request, connect, exited,
    async stop() {
      for (const socket of sockets) socket.close();
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send('rpgmap.shutdown'); else child.kill();
        const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
        if (!stopped) { child.kill('SIGKILL'); await exited; }
      }
    },
  };
}
async function snapshot(ws) {
  const pending = receive(ws, value => value.type === 'world.snapshot' && value.reason === 'request');
  ws.send(JSON.stringify({ type: 'world.snapshot.request' })); return pending;
}
let serial = 0;
async function operation(ws, operations) {
  const current = await snapshot(ws), operationId = `v3-${++serial}`;
  const pending = receive(ws, value => value.operationId === operationId && ['world.operation.ack', 'world.operation.denied', 'error'].includes(value.type));
  ws.send(JSON.stringify({ type: 'world.operation', operationId, baseRevision: current.revision, operations }));
  return pending;
}

test('management package inspection validates bytes without installing maps or executing rule entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-inspect-'));
  const server = await runtime(root);
  try {
    const mapBytes = buildMapArchive({ data: createMinimalReferencePackage() });
    assert.equal((await server.api('/api/manage/maps/inspect', { method: 'POST', manager: false, body: mapBytes })).status, 403);
    const original = await server.request('/api/manage/catalog');
    const inspected = await server.request('/api/manage/maps/inspect', { method: 'POST', body: mapBytes });
    assert.equal(inspected.id, 'rpgmap-minimal-reference');
    assert.equal(inspected.version, '1.2.0');
    assert.equal(inspected.compatibility.mapPackageApiVersion, 1);
    assert.equal(inspected.filesCount, 3);
    const rulesBytes = buildRulesetArchive({ ruleset: minimalRuleset,
      entry: 'throw new Error("Inspection must not execute this entry"); export default {};',
      metadata: { compatibility: { application: 'RPGmap 3', rulesetApiVersion: 1 } } });
    const rules = await server.request('/api/manage/rulesets/inspect', { method: 'POST', body: rulesBytes });
    assert.equal(rules.id, minimalRuleset.id);
    assert.equal(rules.compatibility.rulesetApiVersion, 1);
    assert.equal(rules.compatibility.authorDeclaration.application, 'RPGmap 3');
    assert.equal(rules.filesCount, 2);
    const after = await server.request('/api/manage/catalog');
    assert.deepEqual(after.maps, original.maps);
    assert.deepEqual(after.rulesets, original.rulesets);
    assert.deepEqual(after.worlds, original.worlds);
    assert.deepEqual(await readdir(path.join(root, 'packages', 'maps')), []);
    assert.deepEqual((await readdir(path.join(root, 'packages', 'rulesets'))).filter(name => !name.startsWith('.')), []);
    assert.equal((await server.api('/api/manage/maps/inspect', { method: 'POST', body: Buffer.from('invalid archive') })).status, 400);
    assert.equal((await server.api('/api/manage/rulesets/inspect', { method: 'POST', body: Buffer.from('invalid archive') })).status, 400);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test('installed server packages enforce exact maps, multiplayer Scene isolation, reset backups and durable restoration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-v3-server-'));
  let server = await runtime(root);
  try {
    assert.equal((await server.api('/api/manage/catalog', { manager: false })).status, 403);
    assert.deepEqual((await server.request('/api/packages/maps')).maps, []);
    const data = createMinimalReferencePackage(), map = await server.request('/api/manage/maps', { method: 'POST', body: buildMapArchive({ data }) });
    const newer = await server.request('/api/manage/maps', { method: 'POST', body: buildMapArchive({ data: { ...data, version: '1.3.0' } }) });
    const different = await server.request('/api/manage/maps', { method: 'POST', body: buildMapArchive({ data: { ...data, id: 'second-map', name: 'Second map' } }) });
    const served = await server.request(`/api/packages/maps/${map.id}/${map.version}`);
    assert.equal(served.fingerprint, map.fingerprint); assert.equal(served.features.length, data.features.length);
    const conflict = await server.api('/api/manage/maps', { method: 'POST', body: buildMapArchive({ data: { ...data, name: 'Conflict' } }) });
    assert.equal(conflict.status, 400); assert.equal((await conflict.json()).error, 'map_package_version_conflict');
    const world = await server.request('/api/manage/worlds', { method: 'POST', body: { name: 'Multi-map', ruleset: rule, mapPackage: ref(map) } });
    await server.request('/api/manage/worlds/activate', { method: 'POST', body: { worldId: world.id } });
    await server.exited; server = await runtime(root);
    const gm = await server.connect('gm');
    const claim = receive(gm.ws, value => value.type === 'access.claim');
    gm.ws.send(JSON.stringify({ type: 'access.user.create', name: 'Approved Player' }));
    const player = await server.connect('player', { claimCode: (await claim).claimCode });
    assert.equal((await server.api('/api/manage/catalog', { manager: false, token: player.welcome.contentToken })).status, 403);
    assert.equal((await server.api('/api/manage/worlds/import-directory', { method: 'POST', manager: false, token: gm.welcome.contentToken, body: { directory: root } })).status, 403);
    const original = await snapshot(gm.ws), a = original.state.preferences.worldV2.scenes[0];
    const b = { ...structuredClone(a), id: 'scene-b', name: 'B', tokens: [] };
    const c = { ...structuredClone(b), id: 'scene-c', name: 'C', mapPackage: ref(different) };
    const d = { ...structuredClone(b), id: 'scene-d', name: 'D', mapPackage: ref(newer) };
    assert.equal((await operation(gm.ws, [b, c, d].map(scene => ({ type: 'scene.upsert', payload: { scene } })))).type, 'world.operation.ack');
    const actor = createDefaultActor({ id: 'v3-scout', name: 'Scout', ruleset: infiniteHorrorRuleset });
    const token = { id: 'v3-token', actorId: actor.id, actorLink: true, actorDelta: null, placement: 'map', x: 10, y: 10,
      featureId: null, diameterMeters: 1, rotation: 0, elevationMeters: 0, effects: [], controllerUserIds: [],
      visibility: { mode: 'public', userIds: [] }, vision: { enabled: false }, locked: false, showName: true };
    assert.equal((await operation(gm.ws, [{ type: 'actor.upsert', payload: { actor } }, { type: 'token.upsert', payload: { sceneId: a.id, token } },
      { type: 'scene.featureState.patch', payload: { sceneId: a.id, featureId: 'demo-door', patch: { open: true } } }])).type, 'world.operation.ack');
    const collision = await operation(gm.ws, [{ type: 'token.move', payload: { sceneId: a.id, tokenId: token.id, placement: 'map', x: 500, y: 300 } }]);
    assert.equal(collision.type, 'world.operation.denied', 'server must enforce the installed house geometry');
    const saved = await server.request('/api/manage/worlds/backup', { method: 'POST', body: { worldId: world.id } });
    for (const scene of [b, c, d, a]) {
      assert.equal((await operation(gm.ws, [{ type: 'scene.activate', payload: { sceneId: scene.id } }])).type, 'world.operation.ack');
      assert.equal((await snapshot(player.ws)).state.preferences.worldV2.activeSceneId, scene.id);
    }
    const switched = (await snapshot(gm.ws)).state.preferences.worldV2;
    assert.equal(switched.scenes.find(scene => scene.id === a.id).featureStates['demo-door'].open, true);
    for (const scene of switched.scenes.filter(scene => scene.id !== a.id)) assert.deepEqual(scene.featureStates, {});
    const reset = await operation(gm.ws, [{ type: 'scene.environment.reset', payload: { sceneId: a.id } }]);
    assert.equal(reset.type, 'world.operation.ack');
    let current = (await snapshot(gm.ws)).state.preferences.worldV2;
    assert.equal(current.scenes.find(scene => scene.id === a.id).tokens.length, 1); assert.deepEqual(current.scenes.find(scene => scene.id === a.id).featureStates, {});
    assert.equal((await operation(player.ws, [{ type: 'scene.clear', payload: { sceneId: a.id } }])).type, 'world.operation.denied');
    assert.equal((await operation(gm.ws, [{ type: 'scene.clear', payload: { sceneId: a.id } }])).type, 'world.operation.ack');
    current = (await snapshot(gm.ws)).state.preferences.worldV2;
    assert.equal(current.scenes.find(scene => scene.id === a.id).tokens.length, 0); assert.equal(current.actors.length, 1);
    const catalog = await server.request('/api/manage/catalog'); assert.ok(catalog.worlds[0].backups.length >= 3);
    const inUse = await server.api(`/api/manage/maps?id=${map.id}&version=${map.version}`, { method: 'DELETE' });
    assert.equal(inUse.status, 400); assert.equal((await inUse.json()).error, 'map_package_in_use');
    await server.request('/api/manage/worlds/restore', { method: 'POST', body: { worldId: world.id, backupId: saved.id } });
    const worldFile = path.join(root, 'worlds', world.id, 'world.json');
    const accessFile = path.join(root, 'worlds', world.id, 'users.json');
    const restoredBytes = await readFile(worldFile), restoredAccess = await readFile(accessFile);
    const deniedPush = receive(gm.ws, value => value.operationId === 'late-recovery');
    const deniedAccess = receive(gm.ws, value => value.operationId === 'late-user');
    gm.ws.send(JSON.stringify({ type: 'world.push', operationId: 'late-recovery',
      reason: 'recovery:old-session', state: (await snapshot(gm.ws)).state }));
    gm.ws.send(JSON.stringify({ type: 'access.user.create', operationId: 'late-user', name: 'Must not survive restore' }));
    assert.equal((await deniedPush).code, 'world_transition_pending');
    assert.equal((await deniedAccess).code, 'world_transition_pending');
    await server.exited; server = await runtime(root);
    assert.deepEqual(await readFile(worldFile), restoredBytes);
    assert.deepEqual(await readFile(accessFile), restoredAccess);
    const reconnected = await server.connect('gm');
    const restored = (await snapshot(reconnected.ws)).state.preferences.worldV2;
    assert.equal(restored.activeSceneId, a.id); assert.equal(restored.scenes.find(scene => scene.id === a.id).tokens.length, 1);
    assert.equal(restored.scenes.find(scene => scene.id === a.id).featureStates['demo-door'].open, true);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test('a second trusted ruleset imports, binds a World and reloads without an infinite rules dependency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-v3-rule-server-'));
  let server = await runtime(root);
  try {
    const entry = await readFile(new URL('../src/rulesets/minimal/index.js', import.meta.url), 'utf8');
    const installedRule = await server.request('/api/manage/rulesets', { method: 'POST', body: buildRulesetArchive({ ruleset: minimalRuleset, entry }) });
    const map = await server.request('/api/manage/maps', { method: 'POST', body: buildMapArchive({ data: createMinimalReferencePackage() }) });
    const world = await server.request('/api/manage/worlds', { method: 'POST', body: { name: 'Counter', ruleset: ref(installedRule), mapPackage: ref(map) } });
    await server.request('/api/manage/worlds/activate', { method: 'POST', body: { worldId: world.id } });
    await server.exited; server = await runtime(root);
    const gm = await server.connect('gm');
    assert.deepEqual((await snapshot(gm.ws)).state.preferences.worldV2.ruleset, ref(installedRule));
    const actor = createDefaultActor({ id: 'counter', ruleset: prepareRuleset(minimalRuleset) });
    assert.equal((await operation(gm.ws, [{ type: 'actor.upsert', payload: { actor } }])).type, 'world.operation.ack');
    assert.equal((await snapshot(gm.ws)).state.preferences.worldV2.actors[0].system.counter, 0);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test('managed JSON imports and startup migrations publish inline images in shared durable storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-v3-shared-content-'));
  let server = await runtime(root);
  try {
    const map = await server.request('/api/manage/maps', { method: 'POST', body: buildMapArchive({ data: createMinimalReferencePackage() }) });
    const preparedMap = await server.request(`/api/packages/maps/${map.id}/${map.version}`);
    const seed = await server.request('/api/manage/worlds', { method: 'POST', body: { name: 'Image import', ruleset: rule, mapPackage: ref(map) } });
    const envelope = JSON.parse(await readFile(path.join(root, 'worlds', seed.id, 'world.json'), 'utf8'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc8AAAAASUVORK5CYII=', 'base64');
    const id = createHash('sha256').update(png).digest('hex'), reference = `asset:${id}`;
    const actor = createDefaultActor({ id: 'image-actor', ruleset: infiniteHorrorRuleset });
    actor.img = `data:image/png;base64,${png.toString('base64')}`;
    const world = structuredClone(envelope.state.preferences.worldV2); world.actors = [actor];
    envelope.state = projectWorldV2ToRuntimeState(envelope.state, world, { mapPackage: preparedMap, ruleset: infiniteHorrorRuleset });
    const imported = await server.request('/api/manage/worlds/import', { method: 'POST', body: envelope });
    const worldFile = path.join(root, 'worlds', imported.id, 'world.json');
    let stored = JSON.parse(await readFile(worldFile, 'utf8'));
    assert.equal(stored.state.preferences.worldV2.actors[0].img, reference);
    const blobFile = path.join(root, 'uploads', 'content', `${id}.content`);
    assert.deepEqual(Buffer.from(JSON.parse(await readFile(blobFile, 'utf8')).data, 'base64'), png);
    await server.request('/api/manage/worlds/activate', { method: 'POST', body: { worldId: imported.id } });
    await server.exited; server = await runtime(root);
    let gm = await server.connect('gm');
    let response = await server.api(`/api/content/${id}`, { manager: false, token: gm.welcome.contentToken });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    await server.stop();
    // A v2.5.5 snapshot may still contain inline images at startup. Removing
    // the blob here ensures this path really publishes a new durable record.
    stored = JSON.parse(await readFile(worldFile, 'utf8'));
    stored.state.preferences.worldV2.actors[0].img = actor.img;
    await writeFile(worldFile, JSON.stringify(stored)); await rm(blobFile);
    server = await runtime(root); gm = await server.connect('gm');
    assert.equal((await snapshot(gm.ws)).state.preferences.worldV2.actors[0].img, reference);
    response = await server.api(`/api/content/${id}`, { manager: false, token: gm.welcome.contentToken });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.deepEqual(Buffer.from(JSON.parse(await readFile(blobFile, 'utf8')).data, 'base64'), png);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});
