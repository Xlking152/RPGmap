import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildMapArchive, inspectMapArchive, mapFileHash } from '../src/packages/map-archive.js';
import { createInitialActorDelta } from '../src/token/actor.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { createCombat } from '../src/combat/model.js';
import { createDefaultSceneSettings } from '../src/world/scene-defaults.js';
import { isFogCellExplored, normalizeFogState } from '../src/vision/fog.js';

// This module performs no work on import. All mutations below are confined to
// an explicitly enabled acceptance run and the disposable desktop UserData.
export function validateSceneLifecycleOptions({ enabled, sceneAudit, reuseData, installer, legacyDirectory, prepareUpgradeFixture }) {
  if (enabled && (!sceneAudit || reuseData || installer || legacyDirectory || prepareUpgradeFixture)) {
    throw new Error('--scene-lifecycle-audit requires --scene-audit in a new disposable World, without reuse, upgrade or legacy-import modes.');
  }
}

export function lifecyclePersistentContent(state) {
  const world = structuredClone(state.preferences.worldV2);
  delete world.updatedAt;
  // normalizeStatusDefinition defines an omitted defaultDuration and null as
  // the same absent duration. Hosted projections may omit this optional null.
  // Canonicalize only that missing field on the detached comparison value;
  // retain numeric durations, invalid values and every other field verbatim.
  if (Array.isArray(world.statusDefinitions)) for (const definition of world.statusDefinitions) {
    if (definition && typeof definition === 'object' && !Array.isArray(definition)
      && !Object.hasOwn(definition, 'defaultDuration')) definition.defaultDuration = null;
  }
  return { world, chatSystem: structuredClone(state.preferences.chatSystem), combatSystem: structuredClone(state.preferences.combatSystem) };
}

export function assertLifecycleVersionPhysics(result, shouldPass) {
  assert.equal(result.startPlacement.valid, true, 'Each version probe must start at a physically valid location');
  assert.equal(result.targetPlacement.valid, shouldPass, 'Each version must expose the correct physical doorway declaration');
  assert.equal(result.accepted, shouldPass, 'The installed server must enforce that exact version rather than cached geometry from another version');
  if (shouldPass) assert.equal(result.denial, null, 'A successful version probe cannot contain a server refusal');
  else assert.equal(result.denial?.code, 'path_blocked', 'The closed doorway must be refused for physical collision; permissions, revision and schema failures do not prove collision enforcement');
  assert.deepEqual(result.position, shouldPass ? { x: 500, y: 465 } : { x: 500, y: 500 });
}

export function assertLifecycleResetContent(beforeState, afterState, type) {
  assert.ok(['scene.environment.reset', 'scene.clear'].includes(type));
  const before = lifecyclePersistentContent(beforeState), after = lifecyclePersistentContent(afterState);
  const initial = before.world.scenes.find(scene => scene.id === before.world.activeSceneId);
  const result = after.world.scenes.find(scene => scene.id === initial.id);
  for (const key of ['id', 'name', 'mapPackage']) assert.deepEqual(result[key], initial[key]);
  for (const key of ['sceneEvents', 'occlusionShapes']) assert.deepEqual(result[key], []);
  assert.deepEqual(result.featureStates, {});
  const clear = type === 'scene.clear';
  for (const key of ['tokens', 'markers', 'attackAreas']) assert.deepEqual(result[key], clear ? [] : initial[key]);
  assert.deepEqual(result.settings, clear ? createDefaultSceneSettings() : initial.settings);
  assert.deepEqual(after.world.scenes.filter(scene => scene.id !== initial.id), before.world.scenes.filter(scene => scene.id !== initial.id));
  const withoutScenes = value => { const clone = structuredClone(value); delete clone.scenes; return clone; };
  assert.deepEqual(withoutScenes(after.world), withoutScenes(before.world));
  assert.deepEqual(after.chatSystem, before.chatSystem);
  if (clear) {
    assert.deepEqual(result.fog, normalizeFogState());
    assert.equal(after.combatSystem.combat, null);
  } else assert.deepEqual(after.combatSystem, before.combatSystem);
  return result;
}

export function createLifecycleMapFixtures(baseArchive, { sourceCommit, sourceArchiveSha256 }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(sourceArchiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(baseArchive.manifest.id, 'rpgmap-minimal-reference');
  assert.equal(baseArchive.manifest.version, '1.2.0');
  const assets = new Map([...baseArchive.files].filter(([file]) => !['manifest.json', 'map.json', 'map.svg'].includes(file)));
  return ['1.3.0', '1.4.0'].map(version => {
    const data = structuredClone(baseArchive.data);
    data.version = version;
    if (version === '1.3.0') {
      const door = data.features.find(feature => feature.id === 'demo-door');
      assert.ok(door);
      door.interaction = { ...door.interaction, initialState: { ...door.interaction?.initialState, open: true } };
    }
    const bytes = buildMapArchive({ data, svg: baseArchive.svg, assets, metadata: {
      author: 'RPGmap native acceptance fixture', sourceCommit, sourceArchiveSha256, fixture: 'scene-lifecycle-audit-v1',
    } });
    const inspected = inspectMapArchive(bytes);
    return { bytes, receipt: { filename: `最小参考地图-${version}-原生验收.rpgmap`, id: data.id, version,
      sha256: mapFileHash(bytes), fingerprint: inspected.fingerprint, sourceCommit, sourceArchiveSha256,
      purpose: version === '1.3.0' ? 'Same map ID, different initial door state and exact version' : 'Imported without any World, Scene or recovery reference' } };
  });
}

export async function desktopButtonPoint(button) {
  if (!button || button.tagName !== 'BUTTON') throw new Error('The actual confirmation button was not found');
  button.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = button.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const hit = document.elementFromPoint(x,y);
  return {x,y,width:box.width,height:box.height,disabled:button.disabled,
    inViewport:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,hitButton:hit===button||Boolean(hit&&button.contains(hit))};
}

export async function clickDesktopConfirmation({ evaluate, call, getSocket }, locate, expectedText, { accept = true } = {}) {
  await call('Page.enable');
  const socket = getSocket();
  const point = await evaluate(`(${desktopButtonPoint.toString()})((${locate.toString()})())`);
  assert.ok(point && point.width > 0 && point.height > 0 && point.disabled !== true, 'The real visible management/reset button must be enabled');
  assert.equal(point.inViewport,true,'The scrolled button center must be inside the actual viewport');
  assert.equal(point.hitButton,true,'The real click must hit the requested button or its child, without an overlay');
  let timeout, listener;
  const dialog = new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); socket.removeEventListener('message', listener); };
    timeout = setTimeout(() => { cleanup(); reject(new Error('The real UI did not open its confirmation dialog')); }, 10000);
    listener = event => {
      const packet = JSON.parse(String(event.data));
      if (packet.method !== 'Page.javascriptDialogOpening') return;
      cleanup();
      (async () => {
        assert.equal(packet.params.type, 'confirm');
        for (const text of expectedText) assert.ok(packet.params.message.includes(text), `Confirmation must describe ${text}`);
        await call('Page.handleJavaScriptDialog', { accept });
        return { accepted: accept, message: packet.params.message, clickTarget: point };
      })().then(resolve, async error => {
        await call('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
        reject(error);
      });
    };
    socket.addEventListener('message', listener);
  });
  // Do not override confirm(), call the reset helpers directly, or mutate the
  // document. The normal click listener must display and submit the operation.
  dialog.catch(() => {});
  try {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    return await dialog;
  } finally { clearTimeout(timeout); socket.removeEventListener('message', listener); }
}

export async function runDesktopSceneLifecycleAudit(context) {
  const { evaluate, call, getSocket, eventually, catalogue, durableWorld, sceneContent, importMap, closeDesktop, launch,
    createSceneObserver, worldId, minimalMapFile, minimalMapSha256, sourceCommit, evidenceRoot, dataRoot, findings,
    captureScreenshots, screenshotPrefix } = context;
  assert.equal((await catalogue()).maps.length, 2, 'The optional lifecycle audit starts only after the unchanged two-map audit');
  const game = (fn, ...args) => evaluate(`(${fn.toString()})(document.querySelector('#app').rpgMapApp,${args.map(value => JSON.stringify(value)).join(',')})`);
  const content = () => game(api => api.getState());
  const request = (route, { method = 'GET', body } = {}) => evaluate(`fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',cache:'no-store',
    ${body === undefined ? '' : `headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(body)}),`}}).then(async response=>({status:response.status,ok:response.ok,body:await response.json()}))`);
  const screenshot = async name => {
    if (!captureScreenshots) return;
    const result = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(evidenceRoot, `${screenshotPrefix}-${name}.png`), Buffer.from(result.data, 'base64'));
  };
  const settle = () => eventually(async () => {
    const disk = await durableWorld(worldId);
    if (Object.keys(disk.exploration?.jobs || {}).length) return false;
    const state = await content();
    assert.deepEqual(lifecyclePersistentContent(state), lifecyclePersistentContent(disk.state), 'GM UI must match completed durable World content');
    return { state, disk };
  }, { timeoutMs: 25000, intervalMs: 100 });
  const enterWorld = async () => {
    await evaluate(`window.rpgmapDesktop.launchWorld(${JSON.stringify(worldId)})`).catch(error => {
      if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error;
    });
    await eventually(() => game((api, expectedId) => api?.multiplayer?.getStatus()?.connected && api.world.get().id === expectedId, worldId)
      .catch(() => false));
  };
  // Browser functions passed to game() must receive all external data explicitly.
  const waitConnected = () => eventually(() => game((api, expectedId) => api?.multiplayer?.getStatus()?.connected && api.world.get().id === expectedId, worldId));
  await waitConnected();
  const initial = (await settle()).state;
  assert.equal(initial.preferences.worldV2.scenes.length, 3);
  const sceneAId = initial.preferences.worldV2.activeSceneId;
  const sourceTokenId = 'desktop-smoke-token';

  const visionFixture = await game(async (api, tokenId) => {
    const token = api.tokens.get(tokenId), actor = api.world.get().actors.find(item => item.id === token.actorId);
    if (!actor?.partyId) throw new Error('The lifecycle source requires a real Actor party');
    const oldPoint = { x: token.x, y: token.y }, scale = Number(api.mapPackage.metersPerUnit) || 1;
    const candidates = [40, 60].flatMap(meters => [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy]) => ({ x: oldPoint.x + dx * meters / scale, y: oldPoint.y + dy * meters / scale })));
    const newPoint = candidates.find(point => api.inspectTokenPlacement(tokenId, point).valid && api.movementFast.inspectTokenMove(tokenId, point).valid);
    if (!newPoint) return { outcome: 'not_executed', reason: 'No physically valid 40–60 m direct fixture route was available', partyId: actor.partyId, oldPoint, scale };
    await api.world.performOperations([
      { type: 'token.upsert', payload: { sceneId: api.world.getActiveScene().id, token: { ...token,
        vision: { ...token.vision, enabled: true, preciseRangeOverrideMeters: 15, vagueRangeOverrideMeters: 15 } } } },
      { type: 'scene.settings.patch', payload: { sceneId: api.world.getActiveScene().id, patch: { lineOfSightEnabled: true } } },
    ], { source: 'desktop-lifecycle-vision' });
    await api.multiplayer.setVisionSource(tokenId);
    return { outcome: 'prepared', partyId: actor.partyId, oldPoint, newPoint, scale };
  }, sourceTokenId);
  if (visionFixture.outcome === 'prepared') {
    const atOrigin = await settle();
    const scene = atOrigin.disk.state.preferences.worldV2.scenes.find(item => item.id === sceneAId);
    assert.ok(isFogCellExplored(scene.fog, visionFixture.partyId, visionFixture.oldPoint, { metersPerUnit: visionFixture.scale }));
    const moved = await game((api, tokenId, target) => api.movementFast.moveTokenTo(tokenId, target), sourceTokenId, visionFixture.newPoint);
    assert.equal(moved.valid, true); assert.equal(moved.committed, true);
    const travelled = await settle(), travelledScene = travelled.disk.state.preferences.worldV2.scenes.find(item => item.id === sceneAId);
    assert.ok(isFogCellExplored(travelledScene.fog, visionFixture.partyId, visionFixture.oldPoint, { metersPerUnit: visionFixture.scale }));
    assert.ok(isFogCellExplored(travelledScene.fog, visionFixture.partyId, visionFixture.newPoint, { metersPerUnit: visionFixture.scale }));
    visionFixture.outcome = 'ready';
  }
  const fixtureActor = await game((api, tokenId) => api.world.get().actors.find(actor => actor.id === api.tokens.get(tokenId).actorId), sourceTokenId);
  const instanceDelta = createInitialActorDelta(fixtureActor, { ruleset: infiniteHorrorRuleset });
  const combatSystem = { schemaVersion: 2, combat: createCombat([{ tokenId: sourceTokenId, actorId: fixtureActor.id }]) };
  await game(async (api, tokenId, actorDelta, combatSystem) => {
    const scene = api.world.getActiveScene(), token = api.tokens.get(tokenId);
    const position = [[5,0],[-5,0],[0,5],[0,-5]].map(([dx,dy]) => ({x:token.x+dx,y:token.y+dy}))
      .find(point => api.inspectTokenPlacement(null, point, { diameterMeters: 1, elevationMeters: 0 }).valid);
    if (!position) throw new Error('No valid independent Token fixture position');
    const instance = { ...token, id: 'lifecycle-instance-token', ...position, actorLink: false, actorDelta,
      vision: { ...token.vision, enabled: false } };
    const marker = { id: 'lifecycle-marker', kind: 'note', name: '原生重置保留验收', ...position, partyId: null,
      controllerUserIds: [], visibility: { mode: 'public', userIds: [] } };
    const area = { id: 'lifecycle-area', name: '重置范围验收', shape: 'circle', origin: { x: token.x, y: token.y },
      anchor: { type: 'token', tokenId }, radius: 5, color: '#d63d32', opacity: .18, visible: true,
      destructionEnabled: false, severeDamage: false, craterEnabled: false, destructionTargets: ['building'] };
    await api.world.performOperations([
      { type: 'token.upsert', payload: { sceneId: scene.id, token: instance } },
      { type: 'marker.upsert', payload: { sceneId: scene.id, marker } },
      { type: 'scene.content.replace', payload: { sceneId: scene.id, expectedActiveSceneId: scene.id,
        expectedAttackAreas: scene.attackAreas, attackAreas: [...scene.attackAreas, area] } },
      { type: 'scene.occlusionShape.upsert', payload: { sceneId: scene.id,
        shape: { id: 'lifecycle-obstacle', kind: 'wall', points: [[20,20],[23,20],[23,23],[20,23]], blockingHeightMeters: 2 } } },
      { type: 'scene.settings.patch', payload: { sceneId: scene.id, patch: { gridVisible: false,
        lineOfSightEnabled: true, movementBudgetMetersPerTurn: 10, defaultDoorInteractionRangeMeters: 4 } } },
      { type: 'combat.replace', payload: { combatSystem } },
    ], { source: 'desktop-lifecycle-fixture' });
  }, sourceTokenId, instanceDelta, combatSystem);
  const beforeReset = await settle(), beforeScene = beforeReset.state.preferences.worldV2.scenes.find(scene => scene.id === sceneAId);
  const modifiedFeatures = findings.find(finding => finding.doorId && finding.buildingId);
  assert.ok(modifiedFeatures, 'The unchanged Scene audit must supply its actual modified map features');
  const authoredDoorOpen = await game((api, doorId) => {
    const feature=api.mapPackage.features.find(item=>item.id===doorId);
    return Boolean(feature.interaction?.initialState?.open??feature.interaction?.initialOpen??feature.initialOpen??false);
  }, modifiedFeatures.doorId);
  assert.ok(beforeScene.tokens.some(token => token.actorLink === false && token.actorDelta));
  for (const key of ['sceneEvents', 'markers', 'attackAreas', 'occlusionShapes']) assert.ok(beforeScene[key].length, `${key} must be present before testing reset scope`);
  assert.ok(Object.keys(beforeScene.featureStates).length);
  const initialBackups = (await catalogue()).worlds.find(world => world.id === worldId).backups;
  const environmentButton = () => {
    const button = [...document.querySelectorAll('.toolbar-right button.ui-primary-tool')].find(node => node.textContent === '恢复地图环境');
    return button;
  };
  const canceled = await clickDesktopConfirmation(context, environmentButton, ['恢复地图环境', '保留 Token', '恢复点'], { accept: false });
  await eventually(() => game(() => [...document.querySelectorAll('.toolbar-right button.ui-primary-tool')].every(button => !button.disabled)));
  assert.deepEqual(lifecyclePersistentContent((await settle()).state), lifecyclePersistentContent(beforeReset.state));
  assert.deepEqual((await catalogue()).worlds.find(world => world.id === worldId).backups, initialBackups);
  findings.push({ test: 'real environment-reset UI cancellation preserves World content and creates no recovery point', passed: true, confirmation: canceled });
  const confirmation = await clickDesktopConfirmation(context, environmentButton, ['恢复地图环境', '保留 Token', '恢复点']);
  const environment = await eventually(async () => {
    const value = await settle();
    assertLifecycleResetContent(beforeReset.state, value.state, 'scene.environment.reset');
    return value;
  });
  const environmentScene = environment.state.preferences.worldV2.scenes.find(scene => scene.id === sceneAId);
  const restoredFeatures = await game((api, featureIds) => ({door:api.interaction.stateForFeature(featureIds.doorId),building:api.interaction.stateForFeature(featureIds.buildingId)}),
    {doorId:modifiedFeatures.doorId,buildingId:modifiedFeatures.buildingId});
  assert.equal(restoredFeatures.door.open,authoredDoorOpen,'Door rendering and runtime physics must use its authored initial state');
  assert.equal(restoredFeatures.building.destroyed,false,'The actual damaged building must return to its initial runtime geometry');
  if (visionFixture.outcome === 'ready') {
    const options = { metersPerUnit: visionFixture.scale };
    assert.equal(isFogCellExplored(environmentScene.fog, visionFixture.partyId, visionFixture.oldPoint, options), false, 'Historical exploration outside the retained current vision must be cleared');
    assert.equal(isFogCellExplored(environmentScene.fog, visionFixture.partyId, visionFixture.newPoint, options), true, 'The retained current vision must be recomputed by the server');
    visionFixture.outcome = 'passed';
  } else assert.deepEqual(environmentScene.fog, normalizeFogState());
  const afterEnvironmentCatalog = await catalogue();
  const newBackups = afterEnvironmentCatalog.worlds.find(world => world.id === worldId).backups.filter(point => !initialBackups.some(old => old.id === point.id));
  const recovery = newBackups.find(point => point.reason === 'scene.environment.reset');
  assert.ok(recovery, 'The real UI must establish its explicit recovery point before resetting');
  assert.ok(newBackups.some(point => point.reason === 'authoritative-scene-reset'));
  const recoveryEnvelope = JSON.parse(await readFile(path.join(dataRoot, 'backups', `${recovery.id}.json`), 'utf8'));
  assert.equal(recoveryEnvelope.checksum, createHash('sha256').update(JSON.stringify(recoveryEnvelope.record)).digest('hex'));
  assert.deepEqual(lifecyclePersistentContent(recoveryEnvelope.record.snapshot.state), lifecyclePersistentContent(beforeReset.state));
  findings.push({ test: 'real environment reset clears physical overrides and history while preserving Tokens, ActorDelta, markers, areas, combat, settings and other Scenes', passed: true,
    confirmation, recoveryPointId: recovery.id, additionalAuthoritativeRecoveryPoints: newBackups.filter(point => point.reason === 'authoritative-scene-reset').map(point => point.id),
    fogRecalculation: visionFixture, revision: environment.disk.revision, restoredFeatures:{doorId:modifiedFeatures.doorId,buildingId:modifiedFeatures.buildingId,authoredDoorOpen,...restoredFeatures} });
  await screenshot('environment-reset');
  await eventually(() => game(() => [...document.querySelectorAll('.toolbar-right button.ui-primary-tool')].every(button => !button.disabled)));
  const clearedConfirmation = await clickDesktopConfirmation(context, () => {
    const button = [...document.querySelectorAll('.toolbar-right button.ui-primary-tool')].find(node => node.textContent === '清空当前场景');
    return button;
  }, ['清空当前场景', '清除 Token', '保留角色卡', '恢复点']);
  const cleared = await eventually(async () => {
    const value = await settle(); assertLifecycleResetContent(environment.state, value.state, 'scene.clear'); return value;
  });
  assert.ok((await catalogue()).worlds.find(world => world.id === worldId).backups.some(point => point.reason === 'scene.clear'));
  findings.push({ test: 'real clear-Scene UI clears only the declared Scene scope, saves recovery and cancels old exploration', passed: true,
    confirmation: clearedConfirmation, revision: cleared.disk.revision, pendingExplorationJobs: Object.keys(cleared.disk.exploration.jobs).length });
  await screenshot('scene-cleared');
  await closeDesktop(); await launch();
  assert.deepEqual(lifecyclePersistentContent((await durableWorld(worldId)).state), lifecyclePersistentContent(cleared.state), 'A normal process restart cannot resurrect cleared Tokens or old Fog');
  const setup = await catalogue(), worldName = setup.worlds.find(world => world.id === worldId).name;
  const points = setup.worlds.find(world => world.id === worldId).backups;
  const restoreIndex = points.findIndex(point => point.id === recovery.id);
  assert.notEqual(restoreIndex, -1);
  await evaluate(`(() => {
    const section=[...document.querySelectorAll('.setup-section')].find(node=>node.querySelector('h2')?.textContent==='World');
    const row=[...section.querySelectorAll('.setup-row')].find(node=>node.querySelector('h3')?.textContent===${JSON.stringify(worldName)});
    const select=row.querySelector('select');select.value=${JSON.stringify(String(restoreIndex))};select.dispatchEvent(new Event('change',{bubbles:true}));
    window.__desktopLifecycleRestoreRow=row;
  })()`);
  const beforeRestoreTimeOrigin = await evaluate('performance.timeOrigin');
  const restoredConfirmation = await clickDesktopConfirmation(context, () => {
    const button = [...window.__desktopLifecycleRestoreRow.querySelectorAll('button')].find(node => node.textContent === '恢复');
    return button;
  }, ['恢复点替换', '操作前会保存当前状态']);
  await eventually(async () => {
    const disk = await durableWorld(worldId);
    assert.deepEqual(lifecyclePersistentContent(disk.state), lifecyclePersistentContent(recoveryEnvelope.record.snapshot.state));
    return evaluate(`performance.timeOrigin!==${JSON.stringify(beforeRestoreTimeOrigin)}&&location.pathname==='/setup'&&Boolean(document.querySelector('.setup-content')?.children.length)`).catch(() => false);
  });
  await enterWorld(); await waitConnected();
  const restored = await settle();
  assert.deepEqual(lifecyclePersistentContent(restored.state), lifecyclePersistentContent(beforeReset.state), 'The selected recovery point restores the entire World, not just one Scene');
  const access = JSON.parse(await readFile(path.join(dataRoot, 'worlds', worldId, 'users.json'), 'utf8'));
  assert.deepEqual(access, recoveryEnvelope.record.access, 'Recovery restores the corresponding permissions and approved identities');
  assert.ok((await catalogue()).worlds.find(world => world.id === worldId).backups.some(point => point.reason === 'before-restore'));
  findings.push({ test: 'real management recovery UI restores complete World content and access after clear and service restart', passed: true,
    confirmation: restoredConfirmation, recoveryPointId: recovery.id, scope: 'complete World and access', accessSha256: createHash('sha256').update(JSON.stringify(access)).digest('hex') });
  await screenshot('world-restored');
  await closeDesktop(); await launch(); await enterWorld(); await waitConnected();
  assert.deepEqual(lifecyclePersistentContent((await settle()).state), lifecyclePersistentContent(restored.state));
  findings.push({ test: 'recovered complete World survives another normal desktop process restart', passed: true });

  await game(async (api, tokenId) => {
    await api.multiplayer.setVisionSource(null);
    const token = api.tokens.get(tokenId);
    await api.world.performOperations([{ type:'token.upsert',payload:{sceneId:api.world.getActiveScene().id,token:{...token,vision:{...token.vision,enabled:false}}} }], {source:'desktop-lifecycle-stop-vision'});
    await api.multiplayer.setVisionSource(null);
  }, sourceTokenId);
  await settle();
  const baseBytes = await readFile(minimalMapFile);
  assert.equal(mapFileHash(baseBytes), minimalMapSha256);
  const fixtures = createLifecycleMapFixtures(inspectMapArchive(baseBytes), { sourceCommit, sourceArchiveSha256: minimalMapSha256 });
  const fixtureDirectory = path.join(evidenceRoot, 'lifecycle-fixtures'); await mkdir(fixtureDirectory, { recursive: true });
  for (const fixture of fixtures) {
    fixture.receipt.file = path.join(fixtureDirectory, fixture.receipt.filename);
    await writeFile(fixture.receipt.file, fixture.bytes, { flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      assert.equal(mapFileHash(await readFile(fixture.receipt.file)), fixture.receipt.sha256, 'Previous supplemental fixture bytes cannot be silently replaced');
    });
    const base64 = fixture.bytes.toString('base64');
    const inspected = await evaluate(`fetch('/api/manage/maps/inspect',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Uint8Array.from(atob(${JSON.stringify(base64)}),character=>character.charCodeAt(0))}).then(async response=>{if(!response.ok)throw new Error(await response.text());return response.json();})`);
    assert.equal(inspected.id, fixture.receipt.id); assert.equal(inspected.version, fixture.receipt.version);
    const installed = await importMap(fixture.receipt.file, fixture.receipt.sha256);
    assert.equal(installed.fingerprint, fixture.receipt.fingerprint);
  }
  assert.equal((await catalogue()).maps.length, 4);
  // Packages imported through management become available to a newly mounted
  // game registry. Re-enter through the real launcher rather than mutating the
  // current registry or pretending that its original package list is live.
  await evaluate('window.rpgmapDesktop.showSetup()').catch(error => { if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error; });
  await eventually(() => evaluate(`Boolean(document.querySelector('.setup-content')?.children.length)`));
  await enterWorld(); await waitConnected();
  const newer = fixtures[0].receipt, unused = fixtures[1].receipt;
  const beforeVersions = (await settle()).state;
  const originalScene = beforeVersions.preferences.worldV2.scenes.find(scene => scene.mapPackage.id === newer.id && scene.mapPackage.version === '1.2.0');
  assert.ok(originalScene);
  const versionScene = await game((api, reference) => api.scenes.create({name:'同地图新版场景 D',mapPackage:reference}), { id:newer.id, version:newer.version });
  assert.equal((await content()).preferences.worldV2.scenes.length, 4);
  const observer = await createSceneObserver();
  const switches = [];
  const probePrototype = beforeVersions.preferences.worldV2.scenes.find(scene => scene.id === sceneAId).tokens.find(token => token.id === sourceTokenId);
  const probeVersionPhysics = async shouldPass => {
    const result = await game(async (api, prototype) => {
      const sceneId = api.world.getActiveScene().id, tokenId = 'lifecycle-version-token';
      const token = { ...prototype, id: tokenId, x: 500, y: 500, elevationMeters: 0,
        vision: { ...prototype.vision, enabled: false }, movement: { mode:'walk',spentMeters:0,turnKey:null,adjudicationRequired:false } };
      const target = {x:500,y:465,elevationMeters:0};
      const startPlacement = api.inspectTokenPlacement(null,token,{diameterMeters:1,elevationMeters:0});
      const targetPlacement = api.inspectTokenPlacement(null,target,{diameterMeters:1,elevationMeters:0});
      if (!startPlacement.valid) throw new Error('Version probe start must be physically valid');
      await api.world.performOperations([{type:'token.upsert',payload:{sceneId,token}}],{source:'desktop-lifecycle-version-fixture'});
      let accepted = false, denial = null;
      try {
        await api.world.performOperations([{type:'token.movePath',payload:{sceneId,tokenId,tokenIds:[tokenId],
          expectedOrigins:{[tokenId]:{x:500,y:500,elevationMeters:0}},waypoints:[target],method:'drag',movementMode:'walk'}}],{source:'desktop-lifecycle-version-physics'});
        accepted = true;
      } catch(error) { denial = {code:error.code||null,message:error.message}; }
      const final = api.tokens.get(tokenId);
      return {sceneId,tokenId,accepted,denial,startPlacement,targetPlacement,position:{x:final.x,y:final.y}};
    }, probePrototype);
    assertLifecycleVersionPhysics(result, shouldPass);
    return result;
  };
  const activate = async (sceneId, reference) => {
    const beforeTimeOrigin = await evaluate('performance.timeOrigin');
    await game((api, id) => api.scenes.activate(id), sceneId).catch(error => { if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error; });
    await eventually(() => game((api, id, map) => api.multiplayer.getStatus().connected && api.world.getActiveScene().id === id
      && api.mapPackage.id === map.id && api.mapPackage.version === map.version, sceneId, reference));
    await observer.expectScene(sceneId, reference);
    const runtime = await game(api => ({ timeOrigin:performance.timeOrigin,id:api.mapPackage.id,version:api.mapPackage.version,fingerprint:api.mapPackage.fingerprint,
      doorOpen:api.mapPackage.features.some(feature=>feature.id==='demo-door')?api.interaction.stateForFeature('demo-door').open:null }));
    assert.notEqual(runtime.timeOrigin, beforeTimeOrigin, 'Different exact package versions must rebuild the actual map Runtime');
    const served = await request(`/api/packages/maps/${encodeURIComponent(reference.id)}/${encodeURIComponent(reference.version)}`);
    assert.equal(served.ok, true); assert.equal(runtime.fingerprint, served.body.fingerprint);
    switches.push({ sceneId, ...runtime }); return runtime;
  };
  try {
    const oldRuntime = await activate(originalScene.id, originalScene.mapPackage);
    assert.equal(oldRuntime.doorOpen, false);
    const oldPhysics = await probeVersionPhysics(false);
    const expectedOldScene = sceneContent((await settle()).state.preferences.worldV2.scenes.find(scene => scene.id === originalScene.id));
    const firstRuntime = await activate(versionScene.id, versionScene.mapPackage);
    assert.equal(firstRuntime.version, '1.3.0'); assert.equal(firstRuntime.fingerprint, newer.fingerprint); assert.equal(firstRuntime.doorOpen, true);
    const newPhysics = await probeVersionPhysics(true);
    const expectedNewScene = sceneContent((await settle()).state.preferences.worldV2.scenes.find(scene => scene.id === versionScene.id));
    const returned = await activate(originalScene.id, originalScene.mapPackage);
    assert.equal(returned.version, '1.2.0'); assert.equal(returned.doorOpen, false);
    assert.deepEqual(sceneContent((await content()).preferences.worldV2.scenes.find(scene => scene.id === originalScene.id)), expectedOldScene);
    assert.deepEqual(sceneContent((await content()).preferences.worldV2.scenes.find(scene => scene.id === versionScene.id)), expectedNewScene,
      'The same Token and feature IDs in another version cannot share Scene state');
    await activate(sceneAId, beforeVersions.preferences.worldV2.scenes.find(scene => scene.id === sceneAId).mapPackage);
    findings.push({ test:'actual same-map ID versions 1.2.0 and 1.3.0 rebuild Runtime with independent default door state and approved Player scene synchronization',passed:true,
      mapFixtures:fixtures.map(fixture=>fixture.receipt),switches,serverPhysics:[oldPhysics,newPhysics],playerEvents:observer.events,playerTransport:'approved Origin WebSocket; not a Player browser or VPN client' });
  } finally { observer.close(); }
  const beforeUninstallRestart = lifecyclePersistentContent((await settle()).state);
  assert.equal(beforeUninstallRestart.world.scenes.length, 4);
  await evaluate('window.rpgmapDesktop.showSetup()').catch(error => { if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error; });
  await eventually(() => evaluate(`Boolean(document.querySelector('.setup-content')?.children.length)`));
  await evaluate(`(() => {
    const section=[...document.querySelectorAll('.setup-section')].find(node=>node.querySelector('h2')?.textContent==='地图');
    window.__desktopLifecycleUnusedMapRow=[...section.querySelectorAll('.setup-row')].find(node=>node.querySelector('p')?.textContent===${JSON.stringify(`${unused.id}@${unused.version}`)});
  })()`);
  const uninstall = await clickDesktopConfirmation(context, () => {
    const button = [...window.__desktopLifecycleUnusedMapRow.querySelectorAll('button')].find(node => node.textContent === '卸载');
    return button;
  }, ['卸载地图', '1.4.0', '引用中的内容不能卸载']);
  await eventually(async () => {
    const catalog=await catalogue();
    return catalog.maps.length===3&&!catalog.maps.some(map=>map.id===unused.id&&map.version===unused.version);
  });
  const missing = await request(`/api/packages/maps/${encodeURIComponent(unused.id)}/${encodeURIComponent(unused.version)}`);
  assert.equal(missing.ok, false); assert.equal(missing.body.error, 'map_package_not_found');
  for (const reference of [originalScene.mapPackage,versionScene.mapPackage]) {
    const protectedMap=await request(`/api/manage/maps?id=${encodeURIComponent(reference.id)}&version=${encodeURIComponent(reference.version)}`,{method:'DELETE'});
    assert.equal(protectedMap.ok,false);assert.equal(protectedMap.body.error,'map_package_in_use');
    assert.ok((protectedMap.body.references||protectedMap.body.details?.references||protectedMap.body.details||[]).some(item=>item.worldId===worldId));
  }
  findings.push({test:'real map-uninstall UI removes an unreferenced version and keeps both Scene-referenced versions protected',passed:true,confirmation:uninstall,removed:{id:unused.id,version:unused.version},retained:[originalScene.mapPackage,versionScene.mapPackage]});
  await screenshot('unused-map-uninstalled');
  assert.deepEqual(lifecyclePersistentContent((await durableWorld(worldId)).state), beforeUninstallRestart,
    'Uninstalling an unreferenced map version cannot change any Scene, Actor, Journal, chat or combat');
  await closeDesktop();await launch();
  const finalCatalog=await catalogue();assert.equal(finalCatalog.maps.length,3);
  assert.equal(finalCatalog.maps.some(map=>map.id===unused.id&&map.version===unused.version),false);
  await enterWorld();await waitConnected();
  const final=await settle();assert.equal(final.state.preferences.worldV2.scenes.length,4);assert.equal(final.state.preferences.worldV2.activeSceneId,sceneAId);
  assert.deepEqual(lifecyclePersistentContent(final.state), beforeUninstallRestart,
    'The final normal restart must preserve complete World, every exact-version Scene, Token, door, Fog, chat and combat content');
  assert.equal(mapFileHash(await readFile(minimalMapFile)),minimalMapSha256,'The original minimal archive must remain unchanged');
  findings.push({test:'normal restart retains complete World content and all four exact-version Scenes, and does not reinstall the unreferenced removed map version',passed:true,
    persistentContentSha256:createHash('sha256').update(JSON.stringify(beforeUninstallRestart)).digest('hex')});
  return {expectedMapCount:3,expectedSceneCount:4,activeSceneId:sceneAId,fogRecalculation:visionFixture,fixtureReceipts:fixtures.map(fixture=>fixture.receipt),
    limitations:[...(visionFixture.outcome==='not_executed'?[`Retained-source Fog recalculation was not executed: ${visionFixture.reason}`]:[]),
      'Recovery failure injection, clean Windows and VPN multi-machine behavior are not exercised by this local extension.',
      'Reset and restore use actual desktop buttons and native confirmation dialogs; package import uses the official inspected management API.']};
}
