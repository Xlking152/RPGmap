import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorldOperationPatch,
  applyWorldOperations,
  assertWorldOperationMessage,
  createWorldOperationPatch,
  deriveWorldOperations,
} from '../src/world/operations.js';
import { reduceStatusOperation } from '../src/status/model.js';

function actor(id, current = 10) {
  return { id, name: id, system: { resources: { hp: { current, max: 10 } } }, effects: [], notes: '' };
}

function token(id, actorId, overrides = {}) {
  return {
    id, actorId, actorLink: true, actorDelta: null,
    placement: 'map', x: 10, y: 20, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    hidden: false, locked: false, showName: true, effects: [],
    ...overrides,
  };
}

function state() {
  const actors = [actor('actor-a'), actor('actor-b')];
  const tokens = [token('token-a', 'actor-a'), token('token-b', 'actor-b')];
  const world = {
    schemaVersion: 2,
    id: 'world-a', name: 'World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    activeSceneId: 'scene-a', actors: structuredClone(actors), statusDefinitions: [],
    scenes: [{
      id: 'scene-a', name: 'Scene', mapPackage: { id: 'map-a', version: '1.0.0' },
      tokens: structuredClone(tokens), markers: [], attackAreas: [], sceneEvents: [],
      settings: { gridVisible: true },
    }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    saveVersion: 2, mapId: 'map-a', mapVersion: '1.0.0',
    markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      worldV2: world,
      entitySystem: { schemaVersion: 3, actors, tokens, statusDefinitions: [] },
      combatSystem: { schemaVersion: 1, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
      gridVisible: true,
    },
  };
}

test('World operation envelope rejects unknown operations and invalid revisions', () => {
  assert.throws(
    () => assertWorldOperationMessage({
      type: 'world.operation', operationId: 'operation-a', baseRevision: 0,
      operations: [{ type: 'unknown.write', payload: {} }],
    }),
    error => error.code === 'unknown_world_operation',
  );
  assert.throws(
    () => assertWorldOperationMessage({
      type: 'world.operation', operationId: 'operation-a', baseRevision: -1,
      operations: [{ type: 'world.rename', payload: { name: 'Next' } }],
    }),
    error => error.code === 'invalid_revision',
  );
});

test('atomic operations update Actor, Token, Scene and Combat through one reducer', () => {
  const initial = state();
  const updatedActor = actor('actor-a', 7);
  const applied = applyWorldOperations(initial, [
    { type: 'actor.upsert', payload: { actor: updatedActor } },
    { type: 'token.move', payload: { tokenId: 'token-a', x: 40, y: 50 } },
    { type: 'scene.content.replace', payload: {
      sceneId: 'scene-a', markers: [{ id: 'marker-a' }], attackAreas: [], sceneEvents: [],
      settings: { gridVisible: false },
    } },
    { type: 'combat.replace', payload: { combatSystem: {
      schemaVersion: 1,
      combat: {
        id: 'combat-a', state: 'active', round: 1, turnIndex: 0,
        combatants: [{ id: 'combatant-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 10, order: 0 }],
      },
    } } },
  ], { now: '2026-01-02T00:00:00.000Z' });

  const world = applied.state.preferences.worldV2;
  assert.equal(world.actors.find(item => item.id === 'actor-a').system.resources.hp.current, 7);
  assert.deepEqual(world.scenes[0].tokens.find(item => item.id === 'token-a'), token('token-a', 'actor-a', { x: 40, y: 50 }));
  assert.deepEqual(applied.state.markers, [{ id: 'marker-a' }]);
  assert.equal(applied.state.preferences.gridVisible, false);
  assert.equal(applied.state.preferences.combatSystem.combat.combatants[0].tokenId, 'token-a');
  assert.equal(world.updatedAt, '2026-01-02T00:00:00.000Z');
});

test('Synthetic Actor Delta replacement affects only one unlinked Token', () => {
  const initial = state();
  const scene = initial.preferences.worldV2.scenes[0];
  scene.tokens[0].actorLink = false;
  scene.tokens[0].actorDelta = {};
  scene.tokens.push(token('token-a-sibling', 'actor-a', { actorLink: false, actorDelta: {} }));
  initial.preferences.entitySystem.tokens = structuredClone(scene.tokens);

  const applied = applyWorldOperations(initial, [{
    type: 'token.actorDelta.replace',
    payload: {
      tokenId: 'token-a',
      actorDelta: { system: { resources: { hp: { current: 3 } } } },
    },
  }]);
  const tokens = applied.state.preferences.worldV2.scenes[0].tokens;
  assert.equal(tokens.find(item => item.id === 'token-a').actorDelta.system.resources.hp.current, 3);
  assert.deepEqual(tokens.find(item => item.id === 'token-a-sibling').actorDelta, {});
  assert.equal(applied.state.preferences.worldV2.actors.find(item => item.id === 'actor-a').system.resources.hp.current, 10);
});

test('Actor deletion removes its Tokens and prunes Combat atomically', () => {
  const initial = state();
  initial.preferences.combatSystem.combat = {
    id: 'combat-a', state: 'active', round: 1, turnIndex: 0,
    combatants: [
      { id: 'combatant-a', tokenId: 'token-a', actorId: 'actor-a' },
      { id: 'combatant-b', tokenId: 'token-b', actorId: 'actor-b' },
    ],
  };
  const applied = applyWorldOperations(initial, [{ type: 'actor.delete', payload: { actorId: 'actor-a' } }]);
  assert.deepEqual(applied.state.preferences.worldV2.actors.map(item => item.id), ['actor-b']);
  assert.deepEqual(applied.state.preferences.worldV2.scenes[0].tokens.map(item => item.id), ['token-b']);
  assert.deepEqual(applied.state.preferences.combatSystem.combat.combatants.map(item => item.id), ['combatant-b']);
});

test('authoritative operation patches reproduce committed canonical state without a full snapshot', () => {
  const initial = state();
  const committed = applyWorldOperations(initial, [
    { type: 'actor.upsert', payload: { actor: actor('actor-a', 6) } },
    { type: 'token.move', payload: { tokenId: 'token-a', x: 22, y: 24 } },
  ], { now: '2026-01-03T00:00:00.000Z' }).state;
  const patch = createWorldOperationPatch(initial, committed);
  const replayed = applyWorldOperationPatch(initial, patch);
  assert.deepEqual(replayed.preferences.worldV2, committed.preferences.worldV2);
  assert.deepEqual(replayed.preferences.entitySystem, committed.preferences.entitySystem);
  assert.equal(Object.hasOwn(patch, 'state'), false);
});

test('state differences derive generic operations and preserve unsupported boundaries', () => {
  const initial = state();
  const next = structuredClone(initial);
  next.preferences.worldV2.actors[0] = actor('actor-a', 8);
  next.preferences.worldV2.scenes[0].tokens[0].x = 80;
  next.preferences.entitySystem.actors = structuredClone(next.preferences.worldV2.actors);
  next.preferences.entitySystem.tokens = structuredClone(next.preferences.worldV2.scenes[0].tokens);
  next.preferences.combatSystem = { schemaVersion: 1, combat: null };
  const derived = deriveWorldOperations(initial, next);
  assert.deepEqual(derived.unsupported, []);
  assert.deepEqual(derived.operations.map(item => item.type), ['actor.upsert', 'token.move']);

  next.preferences.customPlugin = { enabled: true };
  assert.deepEqual(deriveWorldOperations(initial, next).unsupported, ['runtime_state']);
});

test('derivation activates the replacement Scene before deleting the old active Scene', () => {
  const before = state();
  const after = structuredClone(before);
  const oldScene = after.preferences.worldV2.scenes[0];
  const replacement = { ...structuredClone(oldScene), id: 'scene-b', name: 'Scene B' };
  after.preferences.worldV2.scenes = [replacement];
  after.preferences.worldV2.activeSceneId = replacement.id;
  const derived = deriveWorldOperations(before, after);
  const activateIndex = derived.operations.findIndex(operation => operation.type === 'scene.activate');
  const deleteIndex = derived.operations.findIndex(operation => operation.type === 'scene.delete');
  assert.ok(activateIndex >= 0 && deleteIndex > activateIndex);
  const applied = applyWorldOperations(before, derived.operations, { now: '2026-01-02T00:00:00.000Z' });
  assert.equal(applied.state.preferences.worldV2.activeSceneId, 'scene-b');
  assert.deepEqual(applied.state.preferences.worldV2.scenes.map(scene => scene.id), ['scene-b']);
});

test('Status and Effect operations use the injected reducer in offline and server contexts', () => {
  const initial = state();
  const applied = applyWorldOperations(initial, [{
    type: 'status.apply', payload: { scope: 'actor', targetId: 'actor-a', statusId: 'focused' },
  }], {
    now: '2026-01-04T00:00:00.000Z',
    applyStatus(current) {
      const next = structuredClone(current);
      const effect = { id: 'effect-a', definitionId: 'focused', stacks: 1, enabled: true };
      next.preferences.entitySystem.actors[0].effects = [effect];
      return { state: next, results: [{ action: 'apply', actorId: 'actor-a' }] };
    },
  });
  assert.deepEqual(applied.state.preferences.worldV2.actors[0].effects, [
    { id: 'effect-a', definitionId: 'focused', stacks: 1, enabled: true },
  ]);
  assert.equal(applied.results[0].action, 'apply');
});

test('combat.advance updates turn, round, and Status V4 durations atomically', () => {
  const initial = state();
  const definition = {
    id: 'status-timed', name: 'Timed', category: 'debuff', scopes: ['actor'], maxStacks: 1,
    changes: [], capabilities: {}, defaultDuration: { unit: 'rounds', value: 1 },
  };
  initial.preferences.worldV2.statusDefinitions = [definition];
  initial.preferences.worldV2.actors[0].effects = [{
    id: 'effect-timed', definitionId: 'status-timed', stacks: 1, enabled: true,
    duration: { unit: 'rounds', initial: 1, remaining: 1 },
  }];
  initial.preferences.combatSystem.combat = {
    id: 'combat-a', state: 'active', round: 1, turnIndex: 1,
    combatants: [
      { id: 'combatant-a', tokenId: 'token-a', actorId: 'actor-a' },
      { id: 'combatant-b', tokenId: 'token-b', actorId: 'actor-b' },
    ],
  };
  const applied = applyWorldOperations(initial, [{ type: 'combat.advance', payload: {} }], {
    now: '2026-09-02T00:02:00.000Z',
  });
  const combat = applied.state.preferences.combatSystem.combat;
  const effect = applied.state.preferences.worldV2.actors[0].effects[0];
  assert.equal(combat.round, 2);
  assert.equal(combat.turnIndex, 0);
  assert.equal(effect.duration.remaining, 0);
  assert.equal(effect.enabled, false);
  assert.deepEqual(effect.expiredAt, {
    timestamp: '2026-09-02T00:02:00.000Z', round: 2, turn: 0,
  });
  assert.equal(applied.results[0].expiredCount, 1);
});

test('World Operation V2 carries Status V4 definition imports through the shared reducer', () => {
  const initial = state();
  const applied = applyWorldOperations(initial, [{
    type: 'status.definition.import',
    payload: {
      statusSchemaVersion: 4,
      definitions: [{
        id: 'status-imported', name: 'Imported', category: 'neutral', scopes: ['actor'], maxStacks: 1,
        changes: [], capabilities: {}, defaultDuration: { unit: 'rounds', value: 3 },
      }],
    },
  }], {
    applyStatus(current, operation, context) {
      const next = structuredClone(current);
      const reduced = reduceStatusOperation(next.preferences.entitySystem, operation, context);
      next.preferences.entitySystem = reduced.state;
      return { state: next, results: reduced.results };
    },
  });
  assert.equal(applied.state.preferences.worldV2.statusDefinitions.some(item => item.id === 'status-imported'), true);
  assert.equal(applied.changeSet.statusDefinitionsChanged, true);
});

test('Fog changeSet carries bounded circle and sweep invalidation rectangles', () => {
  const initial = state();
  const applied = applyWorldOperations(initial, [
    { type: 'scene.fog.explore', payload: {
      sceneId: 'scene-a', partyId: 'party-a', x: 20, y: 30, radiusMeters: 10,
    } },
    { type: 'scene.fog.explore', payload: {
      sceneId: 'scene-a', partyId: 'party-a', from: { x: 40, y: 50 }, to: { x: 60, y: 70 }, radiusMeters: 20,
    } },
  ], { mapMetrics: { metersPerUnit: 2 } });
  assert.deepEqual(applied.changeSet.fog, [{
    sceneId: 'scene-a', dirtyBounds: { minX: 15, minY: 25, maxX: 70, maxY: 80 },
  }]);

  const reset = applyWorldOperations(applied.state, [{
    type: 'scene.fog.reset', payload: { sceneId: 'scene-a', partyId: 'party-a' },
  }], { mapMetrics: { metersPerUnit: 2 } });
  assert.deepEqual(reset.changeSet.fog, [{ sceneId: 'scene-a', dirtyBounds: null }]);
});
