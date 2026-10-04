import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUniqueIds, assertWorldState, createCanonicalWorldValidator, WORLD_LIMITS } from '../deployment/local-server/world-schema.mjs';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

function fixture() {
  const actors = Array.from({ length: 8 }, (_, index) => ({
    id: `actor-${index}`, name: `Actor ${index}`, type: 'pc', partyId: null, system: {}, effects: [],
  }));
  const tokens = actors.map((actor, index) => ({ id: `token-${index}`, actorId: actor.id,
    actorLink: true, actorDelta: null, placement: 'map', x: index + 1, y: 2, featureId: null,
    diameterMeters: 1, rotation: 0, elevationMeters: 0, hidden: false, locked: false,
    showName: true, effects: [] }));
  return migrateTestStateToWorldV3({ preferences: { worldV2: {
    schemaVersion: 2, id: 'world-index', name: 'Index',
    ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: 'scene-index',
    actors, statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
    scenes: [{ id: 'scene-index', mapPackage: { id: 'test', version: '1' }, tokens,
      markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true } }],
  } } });
}

function moved(before) {
  const world = before.preferences.worldV2;
  const scene = world.scenes[0];
  const entities = before.preferences.entitySystem;
  return { ...before, preferences: { ...before.preferences,
    worldV2: { ...world, scenes: [{ ...scene, tokens: [{ ...scene.tokens[0], x: 5 }, ...scene.tokens.slice(1)] }] },
    entitySystem: { ...entities, tokens: [{ ...entities.tokens[0], x: 5 }, ...entities.tokens.slice(1)] },
  } };
}

function sameRejection(validate, candidate) {
  let oracle;
  try { assertWorldState(candidate); } catch (error) { oracle = error; }
  assert.ok(oracle, 'full validation must reject the candidate');
  assert.throws(() => validate(candidate), error => error.code === oracle.code);
}

test('accepted static arrays avoid per-Actor checks while new Tokens are fully checked', () => {
  const validate = createCanonicalWorldValidator();
  const before = fixture();
  validate(before);
  const candidate = moved(before);
  const calls = { worldActor: 0, statusActor: 0, worldToken: 0, statusToken: 0 };
  const originalGet = Map.prototype.get;
  try {
    Map.prototype.get = function (key) {
      if (Object.hasOwn(calls, key)) calls[key] += 1;
      return originalGet.call(this, key);
    };
    assert.equal(validate(candidate), candidate);
  } finally {
    Map.prototype.get = originalGet;
  }
  assert.equal(calls.worldActor, 0);
  assert.equal(calls.statusActor, 0);
  assert.ok(calls.worldToken > 0);
  assert.ok(calls.statusToken > 0);
  assert.equal(validate.serializedBytes(candidate), Buffer.byteLength(JSON.stringify(candidate)));
  assert.equal(assertWorldState(candidate), candidate);

  const duplicate = moved(candidate);
  duplicate.preferences.worldV2.scenes[0].tokens[1] = duplicate.preferences.worldV2.scenes[0].tokens[0];
  sameRejection(validate, duplicate);
  const missingActor = moved(candidate);
  missingActor.preferences.entitySystem.tokens[0].actorId = 'missing-actor';
  sameRejection(validate, missingActor);
  const missingAnchor = moved(candidate);
  missingAnchor.preferences.worldV2.scenes[0].attackAreas = [{ id: 'area', anchor: { type: 'token', tokenId: 'missing-token' } }];
  sameRejection(validate, missingAnchor);
});

test('Fog-only commits reuse accepted Token collections while dependencies and new arrays stay fully checked', () => {
  const validate = createCanonicalWorldValidator(), before = fixture();
  validate(before);
  const world = before.preferences.worldV2, scene = world.scenes[0];
  const after = { ...before, preferences: { ...before.preferences,
    worldV2: { ...world, scenes: [{ ...scene, fog: { ...scene.fog, exploredByParty: { party: { rows: { 0: [[0, 3]] } } } } }] } } };
  const originalGet = Map.prototype.get;
  let perTokenChecks = 0;
  try {
    Map.prototype.get = function (key) {
      if (['worldToken', 'entityToken', 'statusToken'].includes(key)) perTokenChecks++;
      return originalGet.call(this, key);
    };
    validate(after);
  } finally { Map.prototype.get = originalGet; }
  assert.equal(perTokenChecks, 0);
  assert.equal(validate.serializedBytes(after), Buffer.byteLength(JSON.stringify(after)));
  for (const kind of ['removeActor', 'removeDefinition', 'badNewToken', 'duplicateToken']) {
    const next = moved(after);
    if (kind === 'removeActor') next.preferences.worldV2.actors = world.actors.slice(1);
    if (kind === 'removeDefinition') {
      next.preferences.entitySystem.statusDefinitions = [];
      next.preferences.entitySystem.tokens[0].effects = [{ id: 'root', definitionId: 'status-rooted', stacks: 1, enabled: true }];
    }
    if (kind === 'badNewToken') next.preferences.worldV2.scenes[0].tokens[0].placement = 'invalid';
    if (kind === 'duplicateToken') next.preferences.entitySystem.tokens[1] = next.preferences.entitySystem.tokens[0];
    sameRejection(validate, next);
  }
});

test('Actor replacement, removal and duplicate IDs invalidate collection indexes', () => {
  const validate = createCanonicalWorldValidator();
  const before = fixture();
  validate(before);
  for (const change of ['replace', 'remove', 'duplicate']) {
    const candidate = moved(before);
    const actors = [...before.preferences.worldV2.actors];
    if (change === 'replace') actors[0] = { ...actors[0], type: 'monster' };
    if (change === 'remove') actors.shift();
    if (change === 'duplicate') actors[1] = { ...actors[1], id: ' actor-0 ' };
    candidate.preferences.worldV2.actors = actors;
    sameRejection(validate, candidate);
  }
  const duplicateMirror = moved(before);
  duplicateMirror.preferences.entitySystem.actors = [before.preferences.entitySystem.actors[0],
    { ...before.preferences.entitySystem.actors[1], id: ' actor-0 ' }];
  sameRejection(validate, duplicateMirror);
});

test('status definitions and schema changes invalidate aggregate Actor-effect validation', () => {
  const validate = createCanonicalWorldValidator();
  const before = fixture();
  before.preferences.entitySystem.actors[0].effects = [{ id: 'rooted', definitionId: 'status-rooted', stacks: 1, enabled: true }];
  validate(before);
  const missing = moved(before);
  missing.preferences.entitySystem.statusDefinitions = [];
  sameRejection(validate, missing);
  const duplicate = moved(before);
  duplicate.preferences.entitySystem.statusDefinitions = [...before.preferences.entitySystem.statusDefinitions,
    before.preferences.entitySystem.statusDefinitions[0]];
  sameRejection(validate, duplicate);

  const legacy = fixture();
  legacy.preferences.entitySystem.schemaVersion = 2;
  legacy.preferences.entitySystem.actors[0].effects = [{ id: 'legacy-effect', name: 'Legacy', changes: [] }];
  validate(legacy);
  const upgraded = moved(legacy);
  upgraded.preferences.entitySystem.schemaVersion = 3;
  sameRejection(validate, upgraded);
});

test('failed whole candidates cannot stage static indexes or freeze new arrays', () => {
  const validate = createCanonicalWorldValidator();
  const before = fixture();
  validate(before);
  const candidate = moved(before);
  const world = candidate.preferences.worldV2;
  world.actors = structuredClone(world.actors);
  candidate.preferences.entitySystem.actors = structuredClone(candidate.preferences.entitySystem.actors);
  candidate.preferences.entitySystem.statusDefinitions = structuredClone(candidate.preferences.entitySystem.statusDefinitions);
  world.scenes[0].fog = { ...world.scenes[0].fog, exploredByParty: { party: { rows: { 1: [[4, 3]] } } } };
  sameRejection(validate, candidate);
  assert.equal(Object.isFrozen(world.actors), false);
  assert.equal(Object.isFrozen(candidate.preferences.entitySystem.actors), false);
  assert.equal(Object.isFrozen(candidate.preferences.entitySystem.statusDefinitions), false);
  world.scenes[0].fog = before.preferences.worldV2.scenes[0].fog;
  world.actors[0].type = 'invalid';
  sameRejection(validate, candidate);
});

test('getter and Proxy branches keep the full fallback after a successful canonical call', () => {
  for (const target of ['actor-type', 'actor-system', 'definition', 'proxy']) {
    const validate = createCanonicalWorldValidator();
    const before = fixture();
    let value = target === 'actor-type' ? 'pc' : target === 'actor-system' ? { valid: 1 } : 1;
    let reads = 0;
    if (target === 'actor-type' || target === 'actor-system') {
      Object.defineProperty(before.preferences.worldV2.actors[0], target === 'actor-type' ? 'type' : 'system', {
        enumerable: true, configurable: true, get() { reads += 1; return value; },
      });
    } else if (target === 'definition') {
      Object.defineProperty(before.preferences.entitySystem.statusDefinitions[0], 'maxStacks', {
        enumerable: true, configurable: true, get() { reads += 1; return value; },
      });
    } else {
      before.preferences.worldV2.actors[0] = new Proxy(before.preferences.worldV2.actors[0], {
        get(object, key, receiver) { if (key === 'id') reads += 1; return Reflect.get(object, key, receiver); },
      });
    }
    validate(before);
    reads = 0;
    const candidate = moved(before);
    if (target === 'proxy') {
      assert.equal(validate(candidate), candidate);
      assert.ok(reads > 0, 'a Proxy must not reuse a static index');
    } else {
      value = target === 'actor-type' ? 'invalid' : target === 'actor-system' ? { invalid: Infinity } : 0;
      sameRejection(validate, candidate);
      assert.ok(reads > 0, 'accessors must be checked again');
    }
  }
});

test('static index reuse preserves raw String definition IDs and global JSON budgets', () => {
  const validate = createCanonicalWorldValidator();
  const before = fixture();
  const definition = before.preferences.entitySystem.statusDefinitions.find(item => item.id === 'status-rooted');
  definition.id = ' status-rooted ';
  validate(before);
  const candidate = moved(before);
  candidate.preferences.entitySystem.tokens[0].effects = [{ id: 'effect', definitionId: 'status-rooted', stacks: 1, enabled: true }];
  sameRejection(validate, candidate);

  const shared = Array(1000).fill(0);
  const accepted = moved(before);
  accepted.extra = Array(100).fill(shared);
  validate(accepted);
  const tooMany = moved(accepted);
  tooMany.more = Array(100).fill(shared);
  sameRejection(validate, tooMany);
  let nested = { leaf: 1 };
  for (let index = 0; index < WORLD_LIMITS.maxDepth - 3; index += 1) nested = { child: nested };
  const depthAccepted = moved(before);
  depthAccepted.extra = nested;
  validate(depthAccepted);
  const tooDeep = moved(depthAccepted);
  tooDeep.extra = { child: { child: { child: nested } } };
  sameRejection(validate, tooDeep);
});

test('serialized byte counts re-read accepted accessor and Proxy branches', () => {
  for (const proxy of [false, true]) {
    const validate = createCanonicalWorldValidator();
    let text = 'small';
    const payload = { get text() { return text; } };
    const before = { preferences: {}, payload: proxy ? new Proxy(payload, {}) : payload };
    validate(before);
    assert.equal(validate.serializedBytes(before), Buffer.byteLength(JSON.stringify(before)));
    text = 'larger value '.repeat(100);
    assert.equal(validate.serializedBytes(before), Buffer.byteLength(JSON.stringify(before)));
    assert.equal(validate(before), before);
    assert.equal(validate.serializedBytes(before), Buffer.byteLength(JSON.stringify(before)));
  }
});

test('untrusted mutable and shallow-frozen static arrays retain full validation', () => {
  const validate = createCanonicalWorldValidator();
  validate(fixture());
  for (const target of ['actors', 'definitions']) {
    const candidate = fixture();
    assert.equal(assertWorldState(candidate), candidate);
    if (target === 'actors') {
      Object.freeze(candidate.preferences.worldV2.actors);
      candidate.preferences.worldV2.actors[0].type = 'invalid';
    } else {
      Object.freeze(candidate.preferences.entitySystem.statusDefinitions);
      candidate.preferences.entitySystem.statusDefinitions[0].icon = 'invalid';
    }
    sameRejection(validate, candidate);
  }
});

test('public ID sets cannot mutate the canonical validator private indexes', () => {
  const validate = createCanonicalWorldValidator();
  const before = fixture();
  validate(before);
  const publicIds = assertUniqueIds(before.preferences.entitySystem.actors, 'public-actors');
  publicIds.clear();
  publicIds.add('missing-actor');
  assert.equal(validate(moved(before)).preferences.worldV2.actors, before.preferences.worldV2.actors);
  const invalid = moved(before);
  invalid.preferences.entitySystem.tokens[0].actorId = 'missing-actor';
  sameRejection(validate, invalid);
});
