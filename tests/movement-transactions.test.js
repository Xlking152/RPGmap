import test from 'node:test';
import assert from 'node:assert/strict';
import { createMovementAuthority } from '../src/movement/authority.js';
import { applyWorldOperations, projectWorldOperationState } from '../src/world/operations.js';
import { createDefaultActor } from '../src/actor/model.js';
import { createInitialActorDelta } from '../src/token/actor.js';
import { reduceStatusOperation } from '../src/status/model.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';
import { createNavigationGrid, nearestWalkablePoint } from '../src/engine/navigation.js';
import { deriveSceneState } from '../src/engine/state.js';

function fixture({ independent = false, effects = false } = {}) {
  const sourceMap = createMinimalReferencePackage();
  const map = { ...sourceMap, features: structuredClone(sourceMap.features) };
  if (effects) map.features[0].capabilities.statusRules = { enter: { onSuccess: { apply: [{ statusId: 'status-blinded', scope: 'actor' }] } } };
  const actor = createDefaultActor({ id: 'actor-a', ruleset });
  const token = { id: 'token-a', actorId: actor.id, actorLink: !independent,
    actorDelta: independent ? createInitialActorDelta(actor, { ruleset }) : null,
    placement: 'map', x: 500, y: 500, diameterMeters: 1, elevationFt: 0, effects: [] };
  const scene = { id: 'scene-a', mapPackage: { id: map.id, version: map.version },
    tokens: [token, { ...structuredClone(token), id: 'token-b' }], featureStates: { 'demo-door': { open: true } },
    sceneEvents: [], markers: [], attackAreas: [{ id: 'area', anchor: { type: 'token', tokenId: token.id }, origin: { x: 500, y: 500 } }] };
  const world = { schemaVersion: 3, id: 'world-a', ruleset: { id: ruleset.id, version: ruleset.version },
    activeSceneId: scene.id, actors: [actor], statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS), scenes: [scene] };
  const state = projectWorldOperationState({ preferences: { worldV2: world } });
  const authority = createMovementAuthority(() => map);
  const context = { ruleset, source: { role: 'offline' }, mapMetrics: map,
    validateTokenMovePath: args => authority({ ...args, ruleset }),
    applyStatus(value, message) {
      const reduced = reduceStatusOperation(value.preferences.entitySystem, message, { ruleset });
      return { state: { ...value, preferences: { ...value.preferences, entitySystem: reduced.state } }, results: reduced.results };
    },
  };
  return { state, context, map };
}
const move = (x, y) => ({ type: 'token.move', payload: { tokenId: 'token-a', placement: 'map', x, y } });
const enter = { type: 'token.move', payload: { tokenId: 'token-a', placement: 'feature', featureId: 'demo-house' } };

test('legacy movement cannot cross walls, while explicit GM reposition validates only the landing cell', () => {
  const { state, context } = fixture();
  const before = structuredClone(state);
  assert.throws(() => applyWorldOperations(state, [move(500, 620)], context), { code: 'path_blocked' });
  const reposition = { ...move(500, 620), type: 'token.reposition' };
  assert.throws(() => applyWorldOperations(state, [reposition], { ...context, source: { role: 'player' } }), { code: 'token_reposition_gm_only' });
  assert.throws(() => applyWorldOperations(state, [{ ...move(500, 575), type: 'token.reposition' }], context), { code: 'path_blocked' });
  const result = applyWorldOperations(state, [reposition], context);
  assert.equal(result.state.preferences.worldV2.scenes[0].tokens[0].y, 620);
  assert.deepEqual(result.state.attackAreas[0].origin, { x: 500, y: 620 });
  assert.deepEqual(state, before);
});

test('feature transitions validate trusted entrances and refuse an arbitrary exit teleport', () => {
  const { state, context, map } = fixture();
  const before = structuredClone(state);
  state.preferences.worldV2.scenes[0].featureStates['demo-door'].open = false;
  assert.throws(() => applyWorldOperations(state, [enter], context), { code: 'path_blocked' });
  state.preferences.worldV2.scenes[0].featureStates['demo-door'].open = true;
  const entered = applyWorldOperations(state, [enter], context).state;
  const token = entered.preferences.worldV2.scenes[0].tokens[0];
  assert.equal(token.placement, 'feature');
  assert.deepEqual(entered.attackAreas[0].origin, { x: 500, y: 370 });
  assert.throws(() => applyWorldOperations(entered, [move(900, 700)], context), { code: 'feature_exit_destination_invalid' });
  const grid = createNavigationGrid(map, deriveSceneState([]), null, { appState: entered, moverContext: token });
  const safe = nearestWalkablePoint(grid, { x: 500, y: 470 }, 120);
  const exited = applyWorldOperations(entered, [move(safe.x, safe.y)], context).state;
  assert.equal(exited.preferences.worldV2.scenes[0].tokens[0].placement, 'map');
  assert.deepEqual(exited.attackAreas[0].origin, { x: safe.x, y: safe.y });
  assert.deepEqual(state, before);
});

test('feature effects are generated atomically and remain isolated to one Synthetic Actor', () => {
  const { state, context } = fixture({ independent: true, effects: true });
  const before = structuredClone(state);
  const result = applyWorldOperations(state, [enter], context);
  const world = result.state.preferences.worldV2;
  assert.equal(world.scenes[0].tokens[0].actorDelta.effects[0].definitionId, 'status-blinded');
  assert.deepEqual(world.scenes[0].tokens[1].actorDelta.effects, []);
  assert.deepEqual(world.actors[0].effects, []);
  assert.equal(result.operations[1].type, 'status.apply');
  assert.equal(result.operations[1].payload.scope, 'syntheticActor');
  assert.throws(() => applyWorldOperations(state, [enter], { ...context, applyStatus() { throw new Error('effect failed'); } }), /effect failed/);
  assert.deepEqual(state, before);
});

test('movement sees canonical in-batch statuses and not stale Entity or same-ID Scene projections', () => {
  const { state, context } = fixture();
  const root = { type: 'status.apply', payload: { scope: 'token', targetId: 'token-a', statusId: 'status-rooted' } };
  assert.throws(() => applyWorldOperations(state, [root, move(510, 500)], context), { code: 'status_movement_forbidden' });
  const rooted = applyWorldOperations(state, [root], context).state;
  const removed = { type: 'status.remove', payload: root.payload };
  assert.equal(applyWorldOperations(rooted, [removed, move(510, 500)], context).state.preferences.worldV2.scenes[0].tokens[0].x, 510);
  const other = structuredClone(state.preferences.worldV2.scenes[0]);
  other.id = 'scene-b'; other.tokens[0].effects = [{ id: 'root', definitionId: 'status-rooted', enabled: true, stacks: 1 }];
  state.preferences.worldV2.scenes.push(other);
  assert.throws(() => applyWorldOperations(state, [{ ...move(510, 500), payload: { ...move(510, 500).payload, sceneId: other.id } }], context), { code: 'status_movement_forbidden' });
});

test('path preconditions require finite numeric coordinates and anchor changes never mutate input', () => {
  const { state, context } = fixture();
  const before = structuredClone(state);
  const operation = { type: 'token.movePath', payload: { tokenId: 'token-a', tokenIds: ['token-a'],
    waypoints: [{ x: 520, y: 500 }], expectedOrigins: { 'token-a': {} } } };
  for (const expected of [{}, { x: null, y: 500 }, { x: '500', y: 500 }, { x: Infinity, y: 500 }]) {
    operation.payload.expectedOrigins['token-a'] = expected;
    assert.throws(() => applyWorldOperations(state, [operation], context), { code: 'entity_conflict' });
  }
  operation.payload.expectedOrigins['token-a'] = { x: 500, y: 500 };
  assert.deepEqual(applyWorldOperations(state, [operation], context).state.attackAreas[0].origin, { x: 520, y: 500 });
  assert.deepEqual(state, before);
});
