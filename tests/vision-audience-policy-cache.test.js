import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStateForAudience } from '../src/vision/audience.js';
import { createDocumentChanges, createDocumentChangesFull } from '../src/documents/changes.js';

const map = { id: 'policy-map', version: '1', width: 1000, height: 1000, metersPerUnit: 1, features: [] };
const ruleset = { vision: { describe: () => ({ preciseRangeMeters: 120, vagueRangeMeters: 300, senses: {} }) } };
const context = { role: 'player', userId: 'viewer', user: { ownership: { scout: 'owner' }, placementGrants: {} },
  visionSourceTokenId: 'source', ruleset, mapPackage: map, mapMetrics: { metersPerUnit: 1 }, trustedProjection: true,
  opaqueIdFor: (kind, id) => `opaque-${kind}-${id}`, lookupOpaqueId: (kind, id) => `opaque-${kind}-${id}` };

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(frozen);
  return Object.freeze(value);
}

function fixture() {
  const token = (id, actorId, x, y, extra = {}) => ({ id, actorId, actorLink: true, placement: 'map', x, y,
    elevationMeters: 0, diameterMeters: 1, effects: [], controllerUserIds: [],
    visibility: { mode: 'public', userIds: [] }, vision: { enabled: true }, ...extra });
  return frozen({ preferences: { worldV2: { schemaVersion: 3, activeSceneId: 'scene',
    actors: [{ id: 'scout', name: 'Scout', type: 'pc', partyId: 'party-a', effects: [], system: {} },
      { id: 'hostile', name: 'Hostile', type: 'pc', partyId: 'party-b', effects: [], system: {} }],
    statusDefinitions: [{ id: 'invisible', capabilities: { visibility: 'invisible' } }],
    scenes: [{ id: 'scene', mapPackage: { id: map.id, version: map.version }, settings: { lighting: 'normal' },
      sceneEvents: [], featureStates: {}, markers: [], attackAreas: [],
      occlusionShapes: [{ id: 'wall', kind: 'wall', points: [[100, 0], [110, 0], [110, 300], [100, 300]] },
        { id: 'door', kind: 'door', hostShapeId: 'wall', points: [[99, 40], [111, 40], [111, 60], [99, 60]] }],
      tokens: [token('source', 'scout', 50, 50), token('source-2', 'scout', 50, 350),
        token('near', 'hostile', 80, 50), token('vague', 'hostile', 83, 200), token('blocked', 'hostile', 180, 50),
        token('far', 'hostile', 700, 700), token('lamp', 'scout', 80, 20, { light: {
          enabled: true, rangeMeters: 300, intensity: 1, elevationOffsetMeters: 0, occlusion: 'scene' } })],
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} } }],
  } } });
}

function update(before, { tokenId, tokenPatch = {}, actorId, actorPatch = {}, scenePatch = {}, definitions } = {}) {
  const world = before.preferences.worldV2, scene = world.scenes[0];
  return frozen({ ...before, preferences: { ...before.preferences, worldV2: { ...world,
    actors: actorId ? world.actors.map(actor => actor.id === actorId ? { ...actor, ...actorPatch } : actor) : world.actors,
    statusDefinitions: definitions ?? world.statusDefinitions,
    scenes: [{ ...scene, ...scenePatch,
      tokens: scene.tokens.map(token => token.id === tokenId ? { ...token, ...tokenPatch } : token) }],
  } } });
}

function compare(before, projected, after, viewer = context, movedIds = []) {
  const cached = projectStateForAudience(after, { ...viewer, movementCache: {
    beforeState: before, previousProjection: projected, tokenIds: new Set(movedIds) } });
  const full = projectStateForAudience(after, viewer);
  assert.deepEqual(cached, full);
  assert.deepEqual(createDocumentChanges(projected, cached), createDocumentChangesFull(projected, full));
  return cached;
}

test('source motion reuses only same-session canonical policy and stable anonymous fields, with fresh direction', () => {
  const before = fixture(), initial = projectStateForAudience(before, context);
  const priorVague = initial.preferences.worldV2.scenes[0].tokens.find(token => token.id === 'opaque-token-vague');
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  const projected = compare(before, initial, after, context, ['source']);
  const nextVague = projected.preferences.worldV2.scenes[0].tokens.find(token => token.id === priorVague.id);
  assert.notEqual(nextVague, priorVague);
  assert.notEqual(nextVague.approximateDirection, priorVague.approximateDirection);
  for (const key of ['texture', 'light', 'effects', 'publicStatuses', 'controllerUserIds', 'visibility', 'vision']) {
    assert.equal(nextVague[key], priorVague[key], key);
  }
  assert.equal(projected.preferences.worldV2.actors.find(actor => actor.id === 'opaque-actor-vague'),
    initial.preferences.worldV2.actors.find(actor => actor.id === 'opaque-actor-vague'));

  const switched = compare(after, projected, after, { ...context, visionSourceTokenId: 'source-2' });
  const switchedVague = switched.preferences.worldV2.scenes[0].tokens.find(token => token.id === priorVague.id);
  assert.ok(switchedVague);
  assert.notEqual(switchedVague.vision, nextVague.vision);
});

test('policy memo skips repeated permission lookups only while canonical documents and source identity are unchanged', () => {
  let permissionReads = 0;
  const ownership = { scout: 'owner' };
  Object.defineProperty(ownership, 'hostile', { get: () => { permissionReads += 1; return 'none'; } });
  const viewer = { ...context, user: { ownership, placementGrants: {} } };
  const before = fixture(), initial = projectStateForAudience(before, viewer);
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  permissionReads = 0;
  const cached = projectStateForAudience(after, { ...viewer, movementCache: {
    beforeState: before, previousProjection: initial, tokenIds: new Set(['source']) } });
  const cachedReads = permissionReads;
  permissionReads = 0;
  assert.deepEqual(cached, projectStateForAudience(after, viewer));
  assert.ok(cachedReads < permissionReads, `cached=${cachedReads}, full=${permissionReads}`);

  permissionReads = 0;
  compare(after, cached, after, { ...viewer, visionSourceTokenId: 'source-2' });
  assert.ok(permissionReads > cachedReads * 2, 'switching source must discard private policy memo');
});

test('policy and detection match independent full projections across permissions, invisibility, walls, lights and source ranges', () => {
  const transitions = [
    { tokenId: 'source', tokenPatch: { x: 90 } },
    { tokenId: 'source', tokenPatch: { x: 120 } },
    { tokenId: 'source', tokenPatch: { x: 350 } },
    { tokenId: 'source', tokenPatch: { x: 50 } },
    { tokenId: 'source', tokenPatch: { vision: { enabled: true, preciseRangeOverrideMeters: 250, vagueRangeOverrideMeters: 400 } } },
    { scenePatch: { settings: { lighting: 'dark' } } },
    { tokenId: 'lamp', tokenPatch: { x: 250, y: 250 } },
    { scenePatch: { featureStates: { door: { door: { open: true } } } } },
    { scenePatch: { featureStates: { door: { door: { open: false } } } } },
    { tokenId: 'near', tokenPatch: { visibility: { mode: 'gm', userIds: [] } } },
    { tokenId: 'near', tokenPatch: { visibility: { mode: 'users', userIds: ['viewer'] } } },
    { actorId: 'hostile', actorPatch: { effects: [{ definitionId: 'invisible', enabled: true }] } },
    { definitions: [{ id: 'invisible', capabilities: {} }] },
    { actorId: 'hostile', actorPatch: { partyId: 'party-a' } },
    { actorId: 'scout', actorPatch: { partyId: 'party-b' } },
    { actorId: 'scout', actorPatch: { partyId: 'party-a' } },
  ];
  let before = fixture(), projected = projectStateForAudience(before, context);
  for (const change of transitions) {
    const after = update(before, change);
    projected = compare(before, projected, after, context, change.tokenId ? [change.tokenId] : []);
    before = after;
  }
  for (const viewer of [
    { ...context, userId: 'other-viewer' },
    { ...context, user: { ownership: { scout: 'owner', hostile: 'owner' }, placementGrants: {} } },
    { ...context, user: { ownership: { scout: 'observer' }, placementGrants: {} } },
    { ...context, visionSourceTokenId: 'source-2' },
    { ...context, ruleset: { vision: { describe: () => ({ preciseRangeMeters: 120, vagueRangeMeters: 300,
      senses: { xrayVision: true, darkvision: true, lowLightVision: true } }) } } },
  ]) compare(before, projected, before, viewer);
});

test('map scale and map geometry changes invalidate detection and anonymous coordinate reuse', () => {
  const before = fixture(), initial = projectStateForAudience(before, context);
  const scaleViewer = { ...context, mapMetrics: { metersPerUnit: 0.8 } };
  const scaled = compare(before, initial, before, scaleViewer);
  const previousVague = initial.preferences.worldV2.scenes[0].tokens.find(token => token.id === 'opaque-token-vague');
  const scaledVague = scaled.preferences.worldV2.scenes[0].tokens.find(token => token.id === previousVague.id);
  assert.ok(scaledVague);
  assert.equal(scaledVague.x, 81.25);
  assert.notEqual(scaledVague.x, previousVague.x);
  const changedMap = { ...map, occlusionShapes: [{ id: 'extra-wall', kind: 'wall',
    points: [[65, 0], [70, 0], [70, 250], [65, 250]] }] };
  const reprojected = compare(before, initial, before, { ...context, mapPackage: changedMap });
  assert.ok(initial.preferences.worldV2.scenes[0].tokens.some(token => token.id === 'near'));
  assert.equal(reprojected.preferences.worldV2.scenes[0].tokens.some(token => token.id === 'near'), false);
});

test('mutable and only shallow-frozen token documents cannot preserve stale policy decisions', () => {
  for (const shallow of [false, true]) {
    const before = structuredClone(fixture());
    const token = before.preferences.worldV2.scenes[0].tokens.find(item => item.id === 'near');
    if (shallow) Object.freeze(token);
    const initial = projectStateForAudience(before, context);
    token.visibility.mode = 'gm';
    compare(before, initial, before, context, ['near']);
  }
});
