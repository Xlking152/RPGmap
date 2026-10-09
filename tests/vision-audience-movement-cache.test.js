import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStateForAudience } from '../src/vision/audience.js';
import { isImmutableVisionData } from '../src/vision/immutable-data.js';

const ruleset = { vision: { describe: () => ({ preciseRangeMeters: 120, vagueRangeMeters: 300, senses: {} }) } };
const map = { id: 'cache-map', version: '1', width: 1000, height: 1000, metersPerUnit: 1, features: [] };
const token = (id, actorId, x, y, extra = {}) => ({ id, actorId, actorLink: true, actorDelta: null, placement: 'map', x, y,
  elevationMeters: 0, diameterMeters: 1, effects: [], controllerUserIds: [], visibility: { mode: 'public', userIds: [] },
  vision: { enabled: true }, ...extra });
function fixture() {
  const actors = [{ id: 'scout', name: 'Scout', type: 'pc', partyId: 'party-a', system: {}, effects: [] },
    { id: 'hostile', name: 'Hostile', type: 'pc', partyId: 'party-b', system: {}, effects: [] }];
  const scene = { id: 'scene-cache', mapPackage: { id: map.id, version: map.version }, settings: { lighting: 'normal' },
    sceneEvents: [], markers: [], attackAreas: [], featureStates: {},
    occlusionShapes: [{ id: 'wall', kind: 'wall', points: [[100, 0], [110, 0], [110, 300], [100, 300]] },
      { id: 'door', kind: 'door', hostShapeId: 'wall', points: [[99, 40], [111, 40], [111, 60], [99, 60]] }],
    tokens: [token('source', 'scout', 50, 50), token('source-2', 'scout', 50, 350),
      token('near', 'hostile', 80, 50), token('blocked', 'hostile', 180, 50), token('vague', 'hostile', 80, 200),
      token('far', 'hostile', 700, 700), token('lamp', 'scout', 80, 20, { light: { enabled: true, rangeMeters: 300,
        intensity: 1, elevationOffsetMeters: 0, occlusion: 'scene' } })],
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {
      'party-a': { rows: { 1: [[0, 20]] } }, 'party-b': { rows: { 99: [[100, 150]] } } } } };
  return { preferences: { worldV2: { schemaVersion: 3, activeSceneId: scene.id, actors, scenes: [scene], statusDefinitions: [] } } };
}
const context = { role: 'player', userId: 'player-a', user: { ownership: { scout: 'owner' }, placementGrants: {} },
  visionSourceTokenId: 'source', ruleset, mapMetrics: { metersPerUnit: 1 }, mapPackage: map, trustedProjection: true,
  opaqueIdFor: (kind, id) => `opaque-${kind}-${id}` };
function update(before, { tokenId, patch = {}, scenePatch = {}, actorPatch = null } = {}) {
  const world = before.preferences.worldV2, scene = world.scenes[0];
  return { ...before, preferences: { ...before.preferences, worldV2: { ...world,
    actors: actorPatch ? world.actors.map(actor => actor.id === actorPatch.id ? { ...actor, ...actorPatch } : actor) : world.actors,
    scenes: [{ ...scene, ...scenePatch, tokens: scene.tokens.map(item => item.id === tokenId ? { ...item, ...patch } : item) }] } } };
}
function compare(before, previousProjection, after, tokenIds, viewer = context) {
  const cached = projectStateForAudience(after, { ...viewer, movementCache: { beforeState: before,
    previousProjection, tokenIds: new Set(tokenIds) } });
  const oracle = projectStateForAudience(after, viewer);
  assert.deepEqual(cached, oracle);
  return cached;
}

test('per-session movement reuse matches full projection through walls, range and consecutive source changes', () => {
  let before = fixture(), projected = projectStateForAudience(before, context);
  const initialSource = projected.preferences.worldV2.scenes[0].tokens.find(item => item.id === 'source');
  for (const x of [60, 150, 350, 700, 80]) {
    const after = update(before, { tokenId: 'near', patch: { x } });
    projected = compare(before, projected, after, ['near']); before = after;
  }
  assert.equal(projected.preferences.worldV2.scenes[0].tokens.find(item => item.id === 'source'), initialSource);
  for (const x of [90, 120, 350, 50]) {
    const after = update(before, { tokenId: 'source', patch: { x } });
    projected = compare(before, projected, after, ['source']); before = after;
  }
  compare(before, projected, before, [], { ...context, visionSourceTokenId: 'source-2' });
});

test('geometry, doors, light movement and hidden Actor status changes invalidate movement detection reuse', () => {
  let before = fixture(), projected = projectStateForAudience(before, context);
  for (const change of [
    { scenePatch: { featureStates: { door: { door: { open: true } } } } },
    { scenePatch: { featureStates: { door: { door: { open: false } } } } },
    { scenePatch: { settings: { lighting: 'dark' } } },
    { tokenId: 'lamp', patch: { x: 250, y: 250 } },
    { tokenId: 'near', patch: { visibility: { mode: 'gm', userIds: [] } } },
    { actorPatch: { id: 'hostile', effects: [{ definitionId: 'invisible', enabled: true }] } },
  ]) {
    let after = update(before, change);
    if (change.actorPatch) after = { ...after, preferences: { ...after.preferences, worldV2: {
      ...after.preferences.worldV2, statusDefinitions: [{ id: 'invisible', capabilities: { visibility: 'invisible' } }] } } };
    projected = compare(before, projected, after, change.tokenId ? [change.tokenId] : []); before = after;
  }
});

test('another viewer or changed ownership cannot reuse a private movement projection', () => {
  const before = fixture();
  const projected = projectStateForAudience(before, { ...context, userId: 'observer', user: {
    ownership: { scout: 'owner', hostile: 'observer' }, placementGrants: {} } });
  const after = update(before, { tokenId: 'near', patch: { x: 85 } });
  const differentViewer = { ...context, userId: 'different-viewer' };
  const checked = compare(before, projected, after, ['near'], differentViewer);
  assert.equal(checked.preferences.worldV2.actors.find(actor => actor.id === 'hostile')?.audienceRestricted, true);
  compare(before, projected, after, ['near'], { ...context, userId: 'observer', user: {
    ownership: { scout: 'owner' }, placementGrants: {} } });
});

test('movement can look up prior anonymous identities without generating IDs for hidden Tokens', () => {
  const ids = new Map();
  const viewer = { ...context, opaqueIdFor: (kind, id) => {
    const key = `${kind}:${id}`; ids.set(key, `opaque-${kind}-${id}`); return ids.get(key);
  }, lookupOpaqueId: (kind, id) => ids.get(`${kind}:${id}`) };
  const before = fixture(), previousProjection = projectStateForAudience(before, viewer);
  const after = update(before, { tokenId: 'near', patch: { x: 85 } });
  let generatedHidden = false;
  const withLookup = { ...viewer, opaqueIdFor: (kind, id) => {
    if (kind === 'token' && id === 'far') generatedHidden = true;
    return viewer.opaqueIdFor(kind, id);
  } };
  const result = compare(before, previousProjection, after, ['near'], withLookup);
  assert.equal(generatedHidden, false);
  assert.ok(result.preferences.worldV2.scenes[0].tokens.some(token => token.audienceVisibility === 'vague'));
});

test('moving a vague Token reuses only its blank Actor and ownership changes reveal the canonical Actor', () => {
  const before = fixture();
  const previousProjection = projectStateForAudience(before, context);
  const previousVague = previousProjection.preferences.worldV2.actors
    .find(actor => actor.id === 'opaque-actor-vague');
  assert.equal(previousVague?.name, '模糊轮廓');
  const after = update(before, { tokenId: 'vague', patch: { x: 84, y: 205 } });
  const cached = compare(before, previousProjection, after, ['vague']);
  assert.equal(cached.preferences.worldV2.actors.find(actor => actor.id === previousVague.id), previousVague);

  const owner = { ...context, user: { ownership: { scout: 'owner', hostile: 'owner' }, placementGrants: {} } };
  const ownerProjection = compare(before, previousProjection, after, ['vague'], owner);
  assert.equal(ownerProjection.preferences.worldV2.actors.find(actor => actor.id === 'hostile')?.name, 'Hostile');
  assert.equal(ownerProjection.preferences.worldV2.actors.some(actor => actor.id === previousVague.id), false);
});

test('precise hostile Tokens and hidden Tokens do not reserve opaque identities', () => {
  const calls = [];
  const viewer = {
    ...context,
    ruleset: { vision: { describe: () => ({ preciseRangeMeters: 120, vagueRangeMeters: 120, senses: {} }) } },
    opaqueIdFor: (kind, id) => { calls.push(`${kind}:${id}`); return `opaque-${kind}-${id}`; },
  };
  const projected = projectStateForAudience(fixture(), viewer);
  const near = projected.preferences.worldV2.scenes[0].tokens.find(item => item.id === 'near');
  assert.equal(near?.audienceVisibility, 'precise');
  assert.deepEqual(calls, []);
});

function freezeGraph(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeGraph(child);
  return Object.freeze(value);
}

test('500 immutable Tokens match independent full projections across source movement and recipients', () => {
  let before = fixture();
  const scene = before.preferences.worldV2.scenes[0];
  while (scene.tokens.length < 500) {
    const index = scene.tokens.length;
    scene.tokens.push(token(`hostile-${index}`, 'hostile', (index * 37) % 950, (index * 19) % 950,
      index % 11 === 0 ? { visibility: { mode: 'gm', userIds: [] } } : {}));
  }
  before = freezeGraph(before);
  const viewers = [
    { ...context, isCanonicalData: isImmutableVisionData },
    { ...context, userId: 'hostile-owner', user: { ownership: { scout: 'owner', hostile: 'owner' }, placementGrants: {} },
      isCanonicalData: isImmutableVisionData },
  ];
  let projections = viewers.map(viewer => projectStateForAudience(before, viewer));
  for (const x of [90, 120, 350, 50]) {
    const after = freezeGraph(update(before, { tokenId: 'source', patch: { x } }));
    projections = viewers.map((viewer, index) => {
      const reused = projectStateForAudience(after, { ...viewer, movementCache: { beforeState: before,
        previousProjection: projections[index], tokenIds: new Set(['source']) } });
      const independent = projectStateForAudience(structuredClone(after), viewer);
      assert.deepEqual(reused, independent);
      return reused;
    });
    before = after;
  }
  assert.equal(projections[0].preferences.worldV2.scenes[0].tokens.some(item => item.id === 'hostile-11'), false);
  assert.equal(projections[1].preferences.worldV2.actors.find(actor => actor.id === 'hostile')?.name, 'Hostile');
});

test('custom Array mapping keeps its observable legacy calls for immutable previous Tokens', () => {
  const before = freezeGraph(fixture()), viewer = { ...context, isCanonicalData: isImmutableVisionData };
  const previousProjection = projectStateForAudience(before, viewer);
  const after = freezeGraph(update(before, { tokenId: 'source', patch: { x: 90 } }));
  const priorTokens = before.preferences.worldV2.scenes[0].tokens;
  const original = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  let observedPrior = false, reused;
  try {
    Object.defineProperty(Array.prototype, 'map', { ...original, value: function(callback, receiver) {
      if (this === priorTokens) observedPrior = true;
      return Reflect.apply(original.value, this, [callback, receiver]);
    } });
    reused = projectStateForAudience(after, { ...viewer, movementCache: { beforeState: before,
      previousProjection, tokenIds: new Set(['source']) } });
  } finally { Object.defineProperty(Array.prototype, 'map', original); }
  assert.equal(observedPrior, true);
  assert.deepEqual(reused, projectStateForAudience(structuredClone(after), viewer));
});
