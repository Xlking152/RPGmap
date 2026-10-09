import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { featureToPolygon } from '../src/engine/geometry.js';
import { createDamagePreview, commitDamageEvent, commitRestoreEvent, deriveSceneState } from '../src/engine/state.js';
import { benchmarkBuildInfo } from './lan-benchmark-support.mjs';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const sceneEventsHash = events => createHash('sha256').update(JSON.stringify(stable(events))).digest('hex');

// Use actual packaged map data and the same range preview as the UI. A small
// circle crossing a building edge gives a genuine partial hit without a
// manufactured server state or touching another object.
export function createRuinsLanFixture(map, sceneEvents = []) {
  const damaged = new Set(deriveSceneState(sceneEvents).damagedFeatureIds);
  for (const feature of [...map.features].filter(item => item.category === 'building'
    && item.capabilities?.destructible !== false && !damaged.has(String(item.id))).sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const ring = featureToPolygon(feature);
    const xs = ring.map(point => Number(point[0] ?? point.x)), ys = ring.map(point => Number(point[1] ?? point.y));
    const radius = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.12;
    if (!(radius > 0)) continue;
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index], b = ring[(index + 1) % ring.length];
      const area = { id: 'lan-ruins-partial-area', name: 'Packaged LAN partial destruction', shape: 'circle',
        origin: { x: (Number(a[0] ?? a.x) + Number(b[0] ?? b.x)) / 2,
          y: (Number(a[1] ?? a.y) + Number(b[1] ?? b.y)) / 2 }, radius,
        anchor: { type: 'free', markerId: null }, destructionEnabled: true,
        destructionTargets: ['building'], severeDamage: false, craterEnabled: false, visible: false };
      const preview = createDamagePreview(area, map.features, ['building'], map);
      if (preview.objectIds.length || preview.clipHits.length !== 1 || preview.clipHits[0].featureId !== String(feature.id)) continue;
      const event = commitDamageEvent({ sceneEvents }, area, preview).sceneEvents.at(-1);
      return { featureId: String(feature.id), area, partialEvent: event,
        partialCoverage: preview.hits.find(hit => hit.featureId === String(feature.id)).coverage };
    }
  }
  throw new Error('Packaged map has no isolated, undamaged building for the LAN partial-destruction fixture');
}

async function packagedMap(mapDir) {
  assert(mapDir, 'Packaged destruction recovery requires the real package map directory');
  const appRoot = path.join(path.dirname(mapDir), 'app');
  const manifest = JSON.parse(await readFile(path.join(appRoot, '.vite', 'manifest.json'), 'utf8'));
  const data = manifest['reference/maps/lanzhou/runtime.json']?.file;
  const svg = manifest['reference/maps/lanzhou/runtime.svg']?.file;
  assert(data && svg, 'Package is missing its Lanzhou map resources');
  const map = JSON.parse(await readFile(path.join(appRoot, data), 'utf8'));
  return prepareMapPackage({ ...map, svg: await readFile(path.join(appRoot, svg), 'utf8') }, { source: 'packaged-lan-smoke' });
}

function sceneIn(state, sceneId) {
  const scene = state?.preferences?.worldV2?.scenes.find(item => item.id === sceneId);
  assert(scene, 'Packaged destruction lost the active Scene');
  return scene;
}

export function assertRuinsSceneEventDelta(message, sceneId, event) {
  const changes = message.changes?.filter(change => change.document?.type === 'SceneEvent'
    && change.document.parent?.type === 'Scene' && change.document.parent.id === sceneId) || [];
  assert.equal(changes.length, 1, 'Each destruction transaction must publish exactly one SceneEvent delta');
  assert.equal(changes[0].action, 'create');
  assert.equal(changes[0].document.id, event.id);
  assert.deepEqual(changes[0].changed, event, 'Recipient SceneEvent delta differs from the confirmed history');
  assert(!JSON.stringify(message).includes('smoke-secret-token'), 'Destruction delta exposed a GM-only Token');
  return structuredClone(changes[0]);
}

/** Real GM/Player sockets, fsynced WAL, identity reconnect and packaged restart. */
export async function runPackagedRuinsLanSmoke({ gm, playerSocket, playerIdentity, mapDir, sceneId,
  sourcePoint, joinCode, hello, waitForMessage, waitForFog, canonicalSnapshot, durablePrefix, verifyPackagedRestart }) {
  const packageRoot = path.dirname(mapDir), build = await benchmarkBuildInfo(process.cwd(), packageRoot);
  const map = await packagedMap(mapDir), before = await canonicalSnapshot(gm.socket);
  const originalScene = sceneIn(before.state, sceneId), originalHistory = originalScene.sceneEvents;
  const fixture = createRuinsLanFixture(map, originalHistory), samples = [];
  let recipient = playerSocket, reconnected;
  const commit = async (kind, event) => {
    const current = await waitForFog(gm.socket, mapDir, sceneId, 'smoke-party', sourcePoint), scene = sceneIn(current.state, sceneId);
    const operationId = `smoke-ruins-${kind}`;
    const ack = waitForMessage(gm.socket, value => ['world.operation.ack', 'world.operation.denied'].includes(value.type)
      && value.operationId === operationId, `Ruins ${kind} ACK`);
    const gmDelta = waitForMessage(gm.socket, value => value.type === 'world.operation.committed'
      && value.operationId === operationId, `Ruins ${kind} GM delta`);
    const playerDelta = waitForMessage(recipient, value => value.type === 'world.operation.committed'
      && value.operationId === operationId, `Ruins ${kind} Player delta`);
    const started = performance.now();
    gm.socket.send(JSON.stringify({ type: 'world.operation', operationId, baseRevision: current.revision,
      operations: [{ type: 'scene.content.replace', payload: { sceneId, expectedActiveSceneId: sceneId,
        expectedSceneEvents: scene.sceneEvents, sceneEvents: [...scene.sceneEvents, event] } }] }));
    const [confirmed, gmMessage, playerMessage] = await Promise.all([ack, gmDelta, playerDelta]);
    assert.equal(confirmed.type, 'world.operation.ack', `Ruins ${kind} was rejected: ${JSON.stringify(confirmed)}`);
    assert.equal(confirmed.duplicate, false);
    assert.equal(confirmed.revision, current.revision + 1);
    assert.equal(gmMessage.revision, confirmed.revision);
    assert.equal(playerMessage.revision, confirmed.revision);
    const playerChange = assertRuinsSceneEventDelta(playerMessage, sceneId, event);
    assertRuinsSceneEventDelta(gmMessage, sceneId, event);
    const prefix = await durablePrefix(mapDir, confirmed.revision);
    assert.equal(prefix.world.revision, confirmed.revision, `Ruins ${kind} ACK preceded WAL durability`);
    const expected = [...scene.sceneEvents, event], durableScene = sceneIn(prefix.world.state, sceneId);
    assert.deepEqual(durableScene.sceneEvents, expected, `Ruins ${kind} was not saved in the confirmed WAL prefix`);
    const walRecord = prefix.records.find(record => record.operationId === operationId && record.revision === confirmed.revision);
    assert(walRecord, `Ruins ${kind} has no actual WAL record`);
    const canonical = await canonicalSnapshot(gm.socket);
    assert.deepEqual(sceneIn(canonical.state, sceneId).sceneEvents, expected);
    samples.push({ kind, operationId, baseRevision: current.revision, revision: confirmed.revision,
      elapsedMs: performance.now() - started, playerChange,
      sceneEventsHash: sceneEventsHash(expected), durableSceneEventsHash: sceneEventsHash(durableScene.sceneEvents),
      durableSceneEvents: structuredClone(durableScene.sceneEvents),
      canonicalSceneEvents: structuredClone(sceneIn(canonical.state, sceneId).sceneEvents),
      walRecord: structuredClone(walRecord),
      walConfirmed: true, canonicalConfirmed: true });
    return { prefix, expected, derived: deriveSceneState(expected) };
  };
  try {
    const partial = await commit('partial', fixture.partialEvent);
    assert(partial.derived.clipHits.some(hit => hit.featureId === fixture.featureId));
    assert(!partial.derived.destroyedObjectIds.includes(fixture.featureId), 'Partial range damage became whole destruction');
    const wholeEvent = { id: 'lan-ruins-whole-event', type: 'damage', createdAt: new Date().toISOString(),
      objectIds: [fixture.featureId], clipHits: [] };
    const whole = await commit('whole', wholeEvent);
    assert(whole.derived.destroyedObjectIds.includes(fixture.featureId));
    // Reject both new damage and restoration from a Player, without any WAL
    // revision or hidden rollback data. Do not infer permission from UI state.
    const permissionProofs = [];
    for (const kind of ['damage', 'restore']) {
      const current = await waitForFog(gm.socket, mapDir, sceneId, 'smoke-party', sourcePoint), history = sceneIn(current.state, sceneId).sceneEvents;
      const event = kind === 'damage' ? { ...wholeEvent, id: 'lan-ruins-player-forged-damage' }
        : { id: 'lan-ruins-player-forged-restore', type: 'restore', featureIds: [fixture.featureId] };
      const operationId = `smoke-ruins-player-${kind}`;
      const denied = waitForMessage(recipient, value => value.type === 'world.operation.denied'
        && value.operationId === operationId, `Player ruins ${kind} denial`);
      recipient.send(JSON.stringify({ type: 'world.operation', operationId, baseRevision: current.revision,
        operations: [{ type: 'scene.content.replace', payload: { sceneId, sceneEvents: [...history, event] } }] }));
      const response = await denied;
      assert.equal(response.code, 'scene_content_replace_gm_only');
      assert(!Object.hasOwn(response, 'state'), 'Denied Player destruction exposed a World rollback');
      const after = await canonicalSnapshot(gm.socket);
      assert.equal(after.revision, current.revision, 'Denied Player destruction mutated the World revision');
      assert.deepEqual(sceneIn(after.state, sceneId).sceneEvents, history);
      permissionProofs.push({ kind, operationId, code: response.code, revision: after.revision,
        beforeRevision: current.revision, sceneEvents: structuredClone(sceneIn(after.state, sceneId).sceneEvents),
        denial: structuredClone(response), sceneEventsHash: sceneEventsHash(history), noRollbackState: true });
    }
    const restart = await verifyPackagedRestart(whole.prefix, sceneId, 'smoke-party', sourcePoint,
      { featureId: fixture.featureId, sceneEvents: whole.expected });
    assert(restart?.sceneEventsRetained && restart.wholeDestructionRetained, 'Packaged restart did not preserve destruction');
    const disconnected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { playerSocket.removeEventListener('close', onClose);
        reject(new Error('Player destruction disconnect did not close its socket')); }, 12000);
      const onClose = () => { clearTimeout(timer); resolve(); };
      playerSocket.addEventListener('close', onClose, { once: true });
    });
    playerSocket.close();
    await disconnected;
    assert(playerIdentity?.userId && playerIdentity.authToken, 'Player identity is unavailable for real reconnect');
    reconnected = await hello({ name: 'Packaged Ruins Reconnected Player', requestedRole: 'player',
      userId: playerIdentity.userId, authToken: playerIdentity.authToken, joinCode, visionSourceTokenId: 'smoke-pc-token' });
    recipient = reconnected.socket;
    const playerScene = sceneIn(reconnected.welcome.world.state, sceneId);
    assert.deepEqual(playerScene.sceneEvents, whole.expected, 'Reconnect lost acknowledged destruction history');
    assert.equal(reconnected.welcome.identity.user?.id, playerIdentity.userId, 'Reconnect changed Player identity');
    const sourceTokenId = reconnected.welcome.world.state.preferences.audienceVision?.source?.tokenId;
    assert.equal(sourceTokenId, 'smoke-pc-token', 'Reconnect did not restore its controlled vision source');
    assert(!JSON.stringify(reconnected.welcome.world.state).includes('smoke-secret-token'), 'Reconnect exposed a GM-only Token');
    const restoreEvent = commitRestoreEvent({ sceneEvents: whole.expected }, [fixture.featureId]).sceneEvents.at(-1);
    const restored = await commit('restore', restoreEvent);
    assert(!restored.derived.damagedFeatureIds.includes(fixture.featureId));
    const originalDerived = deriveSceneState(originalHistory);
    assert.deepEqual(restored.derived.destroyedObjectIds, originalDerived.destroyedObjectIds, 'Restore altered another object');
    assert.deepEqual(restored.derived.clipHits, originalDerived.clipHits, 'Restore removed another object\'s partial damage');
    assert.deepEqual(restored.derived.craterRegions, originalDerived.craterRegions, 'Restore removed an independent crater');
    const restoredScene = sceneIn(restored.prefix.world.state, sceneId);
    assert.deepEqual(restoredScene.featureStates, originalScene.featureStates, 'Restore changed door state or manual Tag overrides');
    const restoredRestart = await verifyPackagedRestart(restored.prefix, sceneId, 'smoke-party', sourcePoint,
      { featureId: fixture.featureId, sceneEvents: restored.expected });
    assert(restoredRestart?.sceneEventsRetained && restoredRestart.restorationRetained, 'Restart lost restoration');
    assert.deepEqual(await benchmarkBuildInfo(process.cwd(), packageRoot), build, 'LAN destruction package changed during verification');
    return { passed: true, version: build.metadata.version, build, featureId: fixture.featureId, partialCoverage: fixture.partialCoverage,
      fixture: { mapId: map.id, sceneId, source: 'actual-package', area: fixture.area, partialEventId: fixture.partialEvent.id },
      originalSceneEvents: structuredClone(originalHistory), originalFeatureStates: structuredClone(originalScene.featureStates),
      restoredFeatureStates: structuredClone(restoredScene.featureStates),
      samples, permissions: permissionProofs,
      reconnect: { identityRetained: true, sourceTokenId,
        userId: reconnected.welcome.identity.user.id, expectedUserId: playerIdentity.userId,
        worldId: reconnected.welcome.world.state.preferences.worldV2.id,
        expectedWorldId: before.state.preferences.worldV2.id, identityStatus: reconnected.welcome.identity.status,
        source: structuredClone(reconnected.welcome.world.state.preferences.audienceVision.source),
        sceneEvents: structuredClone(playerScene.sceneEvents),
        sceneEventsHash: sceneEventsHash(playerScene.sceneEvents), wholeDestructionRetained: true, hiddenTokenAbsent: true },
      restart, restoredRestart, restoration: { singleObjectOnly: true, tagsAndDoorStateRetained: true, independentCraterRetained: true } };
  } finally { reconnected?.socket.close(); }
}
