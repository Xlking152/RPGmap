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

test('policy memo skips repeated status lookups only while canonical documents and source identity are unchanged', () => {
  const before = update(fixture(), { tokenId: 'near', tokenPatch: { effects: [{ definitionId: 'policy-marker' }] } });
  const viewer = context, initial = projectStateForAudience(before, viewer);
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  const mapGet = Map.prototype.get;
  let statusReads = 0;
  Map.prototype.get = function (key) { if (key === 'policy-marker') statusReads++; return mapGet.call(this, key); };
  try {
    const cached = projectStateForAudience(after, { ...viewer, movementCache: {
      beforeState: before, previousProjection: initial, tokenIds: new Set(['source']) } });
    const cachedReads = statusReads;
    statusReads = 0;
    assert.deepEqual(cached, projectStateForAudience(after, viewer));
    assert.ok(cachedReads < statusReads, `cached=${cachedReads}, full=${statusReads}`);
    statusReads = 0;
    compare(after, cached, after, { ...viewer, visionSourceTokenId: 'source-2' });
    assert.ok(statusReads > cachedReads, 'switching source must discard private policy memo');
  } finally { Map.prototype.get = mapGet; }
});

test('accessor and inherited ownership revocation cannot retain cached parties or private Actor data', () => {
  for (const variant of ['non-enumerable-getter', 'enumerable-getter', 'inherited-getter', 'user-getter']) {
    let granted = 'owner';
    let ownership = { scout: 'owner' };
    if (variant === 'inherited-getter') ownership = Object.assign(Object.create({ get hostile() { return granted; } }), ownership);
    else Object.defineProperty(ownership, 'hostile', { enumerable: variant === 'enumerable-getter', get: () => granted });
    const user = { ownership, placementGrants: {} };
    if (variant === 'user-getter') Object.defineProperty(user, 'ownership', { enumerable: true, get: () => ownership });
    const viewer = { ...context, user }, before = fixture();
    const initial = projectStateForAudience(before, viewer);
    assert.ok(initial.preferences.audienceVision.partyIds.includes('party-b'));
    assert.equal(initial.preferences.worldV2.actors.find(actor => actor.id === 'hostile').audienceRestricted, undefined);
    granted = 'none';
    const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
    const revoked = compare(before, initial, after, viewer, ['source']);
    assert.deepEqual(revoked.preferences.audienceVision.partyIds, ['party-a'], variant);
    assert.equal(revoked.preferences.worldV2.actors.find(actor => actor.id === 'hostile').audienceRestricted, true, variant);
  }
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

function partyScanComparison(before, projected, after, viewer = context) {
  const forcedScan = frozen({ ...after, preferences: { ...after.preferences, worldV2: {
    ...after.preferences.worldV2, actors: [...after.preferences.worldV2.actors],
  } } });
  const mapGet = Map.prototype.get;
  let lookups = 0;
  Map.prototype.get = function (key) { if (key === 'hostile') lookups += 1; return mapGet.call(this, key); };
  try {
    const options = { ...viewer, movementCache: { beforeState: before,
      previousProjection: projected, tokenIds: new Set(['source']) } };
    const cached = projectStateForAudience(after, options);
    const cachedLookups = lookups;
    lookups = 0;
    const fullParties = projectStateForAudience(forcedScan, options);
    const fullLookups = lookups;
    assert.deepEqual(cached, fullParties);
    assert.deepEqual(cached, projectStateForAudience(after, viewer));
    return { cached, cachedLookups, fullLookups };
  } finally { Map.prototype.get = mapGet; }
}

test('pure coordinate movement avoids the Token-to-Actor party scan while retaining full projection output', () => {
  const before = fixture(), projected = projectStateForAudience(before, context);
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  const { cachedLookups, fullLookups } = partyScanComparison(before, projected, after);
  assert.equal(fullLookups - cachedLookups, 4, 'each of the four hostile Tokens avoids its viewerParties Actor lookup');
});

test('movement verifies only its new Token deeply and shares immutable array qualification across projections', () => {
  const before = fixture(), projected = projectStateForAudience(before, context);
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  const tokens = after.preferences.worldV2.scenes[0].tokens;
  const source = tokens.find(token => token.id === 'source');
  const priorTokens = new Set(before.preferences.worldV2.scenes[0].tokens);
  const actors = new Set(before.preferences.worldV2.actors);
  const descriptors = Object.getOwnPropertyDescriptors, descriptor = Object.getOwnPropertyDescriptor;
  let sourceChecks = 0, priorTokenChecks = 0, actorChecks = 0, arrayChecks = 0;
  Object.getOwnPropertyDescriptors = function (value) {
    if (value === source) sourceChecks += 1;
    if (priorTokens.has(value)) priorTokenChecks += 1;
    if (actors.has(value)) actorChecks += 1;
    return descriptors(value);
  };
  Object.getOwnPropertyDescriptor = function (value, key) {
    if (value === tokens) arrayChecks += 1;
    return descriptor(value, key);
  };
  try {
    const options = { ...context, movementCache: { beforeState: before,
      previousProjection: projected, tokenIds: new Set(['source']) } };
    const first = projectStateForAudience(after, options);
    assert.equal(sourceChecks, 1);
    assert.equal(priorTokenChecks, 0);
    assert.equal(actorChecks, 0);
    assert.equal(arrayChecks, tokens.length);
    sourceChecks = priorTokenChecks = actorChecks = arrayChecks = 0;
    assert.deepEqual(projectStateForAudience(after, options), first);
    assert.equal(sourceChecks + priorTokenChecks + actorChecks + arrayChecks, 0,
      'subsequent audiences reuse structural qualification while keeping their party decisions private');
  } finally {
    Object.getOwnPropertyDescriptors = descriptors;
    Object.getOwnPropertyDescriptor = descriptor;
  }
});

test('derived party memo ignores mutations of the publicly returned partyIds', () => {
  for (const replacement of [['party-b', 'extra-private-party'], 'invalid-external-value']) {
    const before = fixture(), projected = projectStateForAudience(before, context);
    projected.preferences.audienceVision.partyIds = replacement;
    const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
    const { cached, cachedLookups, fullLookups } = partyScanComparison(before, projected, after);
    assert.deepEqual(cached.preferences.audienceVision.partyIds, ['party-a']);
    assert.equal(fullLookups - cachedLookups, 4);
    assert.equal(cached.preferences.worldV2.actors.find(actor => actor.id === 'hostile')?.audienceRestricted, true);
  }
});

test('controller, Actor, party, source, ownership and collection changes rederive the authoritative party set', () => {
  const before = fixture(), projected = projectStateForAudience(before, context);
  for (const change of [
    { tokenId: 'near', tokenPatch: { controllerUserIds: ['viewer'] } },
    { tokenId: 'near', tokenPatch: { actorId: 'scout' } },
    { actorId: 'scout', actorPatch: { partyId: 'party-b' } },
    { actorId: 'hostile', actorPatch: { type: 'npc' } },
    { scenePatch: { settings: { lighting: 'dark' } } },
  ]) {
    const after = update(before, change);
    const { cachedLookups, fullLookups } = partyScanComparison(before, projected, after);
    assert.equal(cachedLookups, fullLookups, JSON.stringify(change));
  }
  const controlled = update(before, { tokenId: 'near', tokenPatch: { controllerUserIds: ['viewer'] } });
  const withParty = compare(before, projected, controlled, context, ['near']);
  assert.deepEqual(withParty.preferences.audienceVision.partyIds, ['party-a', 'party-b']);
  const revoked = update(controlled, { tokenId: 'near', tokenPatch: { controllerUserIds: [] } });
  assert.deepEqual(compare(controlled, withParty, revoked, context, ['near']).preferences.audienceVision.partyIds, ['party-a']);
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  for (const viewer of [
    { ...context, visionSourceTokenId: 'source-2' },
    { ...context, user: { ownership: { scout: 'owner', hostile: 'owner' }, placementGrants: {} } },
  ]) {
    const { cachedLookups, fullLookups } = partyScanComparison(before, projected, after, viewer);
    assert.equal(cachedLookups, fullLookups);
  }
  const reordered = frozen({ ...after, preferences: { ...after.preferences, worldV2: { ...after.preferences.worldV2,
    scenes: [{ ...after.preferences.worldV2.scenes[0], tokens: [...after.preferences.worldV2.scenes[0].tokens].reverse() }],
  } } });
  const reorderedCounts = partyScanComparison(before, projected, reordered);
  assert.equal(reorderedCounts.cachedLookups, reorderedCounts.fullLookups);
  const twoScenes = frozen({ ...before, preferences: { ...before.preferences, worldV2: { ...before.preferences.worldV2,
    scenes: [...before.preferences.worldV2.scenes, { ...before.preferences.worldV2.scenes[0], id: 'scene-2', tokens: [] }],
  } } });
  const twoProjection = projectStateForAudience(twoScenes, context);
  const sceneOrder = frozen({ ...twoScenes, preferences: { ...twoScenes.preferences, worldV2: {
    ...twoScenes.preferences.worldV2, scenes: [...twoScenes.preferences.worldV2.scenes].reverse(),
  } } });
  const sceneCounts = partyScanComparison(twoScenes, twoProjection, sceneOrder);
  assert.equal(sceneCounts.cachedLookups, sceneCounts.fullLookups);
});

test('mutable, shallow-frozen, accessor and duplicate-ID party inputs never authorize scan reuse', () => {
  for (const variant of ['mutable', 'shallow', 'accessor', 'duplicate-token', 'duplicate-actor', 'duplicate-scene']) {
    let before = structuredClone(fixture());
    const world = before.preferences.worldV2, scene = world.scenes[0];
    if (variant === 'shallow') {
      world.actors.forEach(Object.freeze);
      Object.freeze(world.actors);
      scene.tokens.forEach(Object.freeze);
      Object.freeze(scene.tokens); Object.freeze(scene); Object.freeze(world.scenes);
    }
    if (variant === 'accessor') {
      const target = scene.tokens.find(token => token.id === 'near');
      const controllers = [];
      Object.defineProperty(target, 'controllerUserIds', { enumerable: true, get: () => controllers });
    }
    if (variant === 'duplicate-token') scene.tokens.push({ ...scene.tokens.find(token => token.id === 'near'), x: 90 });
    if (variant === 'duplicate-actor') world.actors.push({ ...world.actors[1], partyId: 'party-c' });
    if (variant === 'duplicate-scene') world.scenes.push({ ...scene, tokens: [] });
    if (!['mutable', 'shallow'].includes(variant)) before = frozen(before);
    const projected = projectStateForAudience(before, context);
    const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
    const { cachedLookups, fullLookups } = partyScanComparison(before, projected, after);
    assert.equal(cachedLookups, fullLookups, variant);
  }
});

test('canonical Actor lookup maps are shared while recipient projection maps are always rebuilt', () => {
  const before = fixture(), projected = frozen(projectStateForAudience(before, context));
  const canonicalActor = before.preferences.worldV2.actors.find(actor => actor.id === 'hostile');
  const projectedActor = projected.preferences.worldV2.actors.find(actor => actor.id === 'hostile');
  assert.notEqual(projectedActor, canonicalActor);
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  const options = { ...context, movementCache: { beforeState: before, previousProjection: projected,
    tokenIds: new Set(['source']) } };
  const mapSet = Map.prototype.set;
  let canonicalInsertions = 0, projectedInsertions = 0;
  Map.prototype.set = function (key, value) {
    if (value === canonicalActor) canonicalInsertions += 1;
    if (value === projectedActor) projectedInsertions += 1;
    return mapSet.call(this, key, value);
  };
  try {
    const first = projectStateForAudience(after, options);
    assert.equal(canonicalInsertions, 0, 'current and previous canonical arrays reuse their already qualified map');
    assert.equal(projectedInsertions, 1, 'a frozen recipient array still builds its own private projection map');
    assert.deepEqual(projectStateForAudience(after, options), first);
    assert.equal(canonicalInsertions, 0);
    assert.equal(projectedInsertions, 2);
    const newArray = frozen({ ...after, preferences: { ...after.preferences, worldV2: {
      ...after.preferences.worldV2, actors: [...after.preferences.worldV2.actors],
    } } });
    assert.deepEqual(projectStateForAudience(newArray, options), first);
    assert.equal(canonicalInsertions, 1, 'a replacement collection builds and qualifies a new map');
    assert.deepEqual(first, projectStateForAudience(after, context));
  } finally { Map.prototype.set = mapSet; }
});

test('mutable, shallow-frozen, accessor and duplicate Actor collections never reuse lookup maps', () => {
  for (const variant of ['mutable', 'shallow', 'accessor', 'duplicate']) {
    let before = structuredClone(fixture());
    const actors = before.preferences.worldV2.actors;
    const hostile = actors.find(actor => actor.id === 'hostile');
    if (variant === 'shallow') Object.freeze(actors);
    if (variant === 'accessor') {
      Object.defineProperty(hostile, 'name', { enumerable: true, get: () => 'Hostile' });
      before = frozen(before);
    }
    if (variant === 'duplicate') {
      actors.push({ ...hostile, name: 'Last Hostile', partyId: 'party-c' });
      before = frozen(before);
    }
    projectStateForAudience(before, context);
    const mapSet = Map.prototype.set;
    let insertions = 0;
    Map.prototype.set = function (key, value) {
      if (value === hostile) insertions += 1;
      return mapSet.call(this, key, value);
    };
    try {
      const first = projectStateForAudience(before, context);
      assert.equal(insertions, 1, variant);
      const second = projectStateForAudience(before, context);
      assert.equal(insertions, 2, variant);
      assert.deepEqual(first, second);
      assert.deepEqual(second, projectStateForAudience(structuredClone(before), context));
    } finally { Map.prototype.set = mapSet; }
  }
});

test('shared canonical Actor maps preserve fresh audience decisions after source, Actor and permission changes', () => {
  const before = fixture(), projected = projectStateForAudience(before, context);
  const moved = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  for (const viewer of [
    { ...context, userId: 'other-viewer', user: { ownership: {}, placementGrants: {} } },
    { ...context, user: { ownership: { scout: 'owner', hostile: 'owner' }, placementGrants: {} } },
    { ...context, user: { ownership: { scout: 'observer' }, placementGrants: {} } },
    { ...context, visionSourceTokenId: 'source-2' },
  ]) compare(before, projected, moved, viewer, ['source']);
  const ownedViewer = { ...context, user: { ownership: { scout: 'owner', hostile: 'owner' }, placementGrants: {} } };
  const owned = projectStateForAudience(before, ownedViewer);
  const revoked = compare(before, owned, moved, context, ['source']);
  assert.equal(revoked.preferences.worldV2.actors.find(actor => actor.id === 'hostile').audienceRestricted, true);
  const changedActor = update(moved, { actorId: 'hostile', actorPatch: { partyId: 'party-a', name: 'Changed Hostile' } });
  const next = compare(moved, revoked, changedActor, context);
  assert.equal(next.preferences.worldV2.actors.find(actor => actor.id === 'hostile').name, 'Changed Hostile');
  assert.notEqual(next.preferences.worldV2.actors.find(actor => actor.id === 'hostile').audienceRestricted, true);
});

test('previous canonical Token indexes are reused while even frozen recipient Token maps are rebuilt', () => {
  const before = fixture(), projected = frozen(projectStateForAudience(before, context));
  const canonicalToken = before.preferences.worldV2.scenes[0].tokens.find(token => token.id === 'near');
  const projectedToken = projected.preferences.worldV2.scenes[0].tokens.find(token => token.id === 'near');
  assert.notEqual(canonicalToken, projectedToken);
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  const options = { ...context, movementCache: { beforeState: before, previousProjection: projected,
    tokenIds: new Set(['source']) } };
  const mapSet = Map.prototype.set;
  let canonicalInsertions = 0, projectedInsertions = 0;
  Map.prototype.set = function (key, value) {
    if (value === canonicalToken) canonicalInsertions += 1;
    if (value === projectedToken) projectedInsertions += 1;
    return mapSet.call(this, key, value);
  };
  try {
    const first = projectStateForAudience(after, options);
    assert.equal(canonicalInsertions, 1, 'the first movement builds the previous canonical Token index');
    assert.equal(projectedInsertions, 1);
    assert.deepEqual(projectStateForAudience(after, options), first);
    assert.equal(canonicalInsertions, 1, 'the next audience reuses that canonical index');
    assert.equal(projectedInsertions, 2, 'recipient maps are always fresh, even after an external freeze');
    assert.deepEqual(first, projectStateForAudience(after, context));
  } finally { Map.prototype.set = mapSet; }
});

test('unqualified mutable, shallow, accessor and duplicate Token arrays never reuse canonical indexes', () => {
  for (const variant of ['mutable', 'shallow', 'accessor', 'duplicate']) {
    let before = structuredClone(fixture());
    const tokens = before.preferences.worldV2.scenes[0].tokens;
    const near = tokens.find(token => token.id === 'near');
    if (variant === 'shallow') Object.freeze(tokens);
    if (variant === 'accessor') {
      Object.defineProperty(near, 'id', { enumerable: true, get: () => 'near' });
      before = frozen(before);
    }
    if (variant === 'duplicate') {
      tokens.push({ ...near, x: 90 }); before = frozen(before);
    }
    const projected = projectStateForAudience(before, context);
    const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
    const options = { ...context, movementCache: { beforeState: before, previousProjection: projected,
      tokenIds: new Set(['source']) } };
    const mapSet = Map.prototype.set;
    let insertions = 0;
    Map.prototype.set = function (key, value) {
      if (value === near) insertions += 1;
      return mapSet.call(this, key, value);
    };
    try {
      const first = projectStateForAudience(after, options);
      assert.equal(insertions, 1, variant);
      assert.deepEqual(projectStateForAudience(after, options), first);
      assert.equal(insertions, 2, variant);
      assert.deepEqual(first, projectStateForAudience(after, context));
    } finally { Map.prototype.set = mapSet; }
  }
});

test('qualified canonical arrays avoid repeated per-document policy qualification with the same full output', () => {
  const before = fixture(), projected = projectStateForAudience(before, context);
  const after = update(before, { tokenId: 'source', tokenPatch: { x: 60 } });
  const options = { ...context, movementCache: { beforeState: before, previousProjection: projected,
    tokenIds: new Set(['source']) } };
  const warmed = projectStateForAudience(after, options);
  const priorDocuments = new Set([...before.preferences.worldV2.actors, ...before.preferences.worldV2.scenes[0].tokens]);
  const weakHas = WeakSet.prototype.has;
  let documentChecks = 0;
  WeakSet.prototype.has = function (value) {
    if (priorDocuments.has(value)) documentChecks += 1;
    return weakHas.call(this, value);
  };
  try {
    assert.deepEqual(projectStateForAudience(after, options), warmed);
    assert.equal(documentChecks, 0, 'whole-array proofs replace Token/Actor qualification on each policy decision');
  } finally { WeakSet.prototype.has = weakHas; }
  assert.deepEqual(warmed, projectStateForAudience(after, context));
  const replacement = update(after, { actorId: 'hostile', actorPatch: { partyId: 'party-a' } });
  compare(after, warmed, replacement, context);
  const invisible = update(after, { tokenId: 'near', tokenPatch: {
    effects: [{ id: 'invisible-effect', definitionId: 'invisible', enabled: true }],
  } });
  const hidden = compare(after, warmed, invisible, context, ['near']);
  assert.equal(hidden.preferences.worldV2.scenes[0].tokens.some(token => token.id === 'near'), false);
  const visible = update(invisible, { definitions: [{ id: 'invisible', capabilities: {} }] });
  assert.equal(compare(invisible, hidden, visible, context).preferences.worldV2.scenes[0].tokens
    .some(token => token.id === 'near'), true);
});
