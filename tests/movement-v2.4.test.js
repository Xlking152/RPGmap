import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRuleset } from '../src/ruleset/contract.js';
import { createMovementAuthority } from '../src/movement/authority.js';
import { applyWorldOperations } from '../src/world/operations.js';

function ruleset(capabilities = {}) {
  return prepareRuleset({
    id: 'movement-test', title: 'Movement Test', version: '1',
    movement: {
      describe: () => ({ walk: true, swim: true, waterWalk: false, fly: false,
        swimCostMultiplier: 2, ...capabilities }),
    },
  });
}

function map({ water = true, wallHeight = null } = {}) {
  return {
    id: 'movement-map', version: '1', width: 100, height: 100, metersPerUnit: 1,
    roadBuffers: [], floodRules: {}, navigation: { bridgeFeatureIds: [] },
    liquidBodies: water ? [{ id: 'water', polygon: [[40, 0], [60, 0], [60, 100], [40, 100]] }] : [],
    features: wallHeight === null ? [] : [{
      id: 'wall', geometry: { points: [[45, 0], [55, 0], [55, 100], [45, 100]] },
      capabilities: { navigation: { blocks: true, blockingHeightMeters: wallHeight } },
    }],
  };
}

function fixture({ budget = null } = {}) {
  const token = {
    id: 'token-a', actorId: 'actor-a', actorLink: true, actorDelta: null,
    placement: 'map', x: 10, y: 50, elevationMeters: 0, diameterMeters: 1,
    rotation: 0, movement: { mode: 'walk', spentMeters: 0, turnKey: null, adjudicationRequired: false },
    controllerUserIds: [], visibility: { mode: 'public', userIds: [] },
    vision: { enabled: true, preciseRangeOverrideMeters: null, vagueRangeOverrideMeters: null, overrideUserIds: [] },
    locked: false, showName: true, effects: [],
  };
  const scene = {
    id: 'scene-a', mapPackage: { id: 'movement-map', version: '1' }, tokens: [token],
    markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
    settings: { gridVisible: true, lineOfSightEnabled: false, movementBudgetMetersPerTurn: budget },
  };
  const world = {
    schemaVersion: 4, id: 'world-a', ruleset: { id: 'movement-test', version: '1' },
    activeSceneId: 'scene-a', actors: [{ id: 'actor-a', name: 'A', type: 'pc', partyId: 'party', system: {}, effects: [] }],
    statusDefinitions: [], scenes: [scene],
  };
  const state = { preferences: { worldV2: world, combatSystem: { schemaVersion: 2, combat: {
    id: 'combat-a', state: 'active', round: 1, turnIndex: 0,
    combatants: [{ id: 'combatant-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 1, order: 0 }],
    turnOrigin: { x: 10, y: 50, elevationMeters: 0 },
  } } } };
  return { state, world, scene, token };
}

const status = { capabilities: { canMove: true, collisionBypassGroups: [] }, statusVersion: 'test' };

test('walk cannot enter water while swim and water walk use terrain-specific costs', () => {
  const value = fixture();
  const sourceMap = map();
  const validate = createMovementAuthority(() => sourceMap);
  const common = { ...value, origin: { x: 10, y: 50, elevationMeters: 0 },
    waypoints: [{ x: 90, y: 50, elevationMeters: 0 }], status };
  assert.equal(validate({ ...common, ruleset: ruleset(), movementMode: 'walk' }).code, 'path_blocked');
  const swimming = validate({ ...common, ruleset: ruleset(), movementMode: 'swim' });
  assert.equal(swimming.valid, true);
  assert.ok(swimming.costMeters > 80 && swimming.costMeters < 110);
  const walkingOnWater = validate({ ...common, ruleset: ruleset({ waterWalk: true }), movementMode: 'waterWalk' });
  assert.equal(walkingOnWater.valid, true);
  assert.equal(walkingOnWater.costMeters, 80);
});

test('3D interpolation blocks the exact obstacle top and permits a path above it', () => {
  const value = fixture();
  const sourceMap = map({ water: false, wallHeight: 5 });
  const validate = createMovementAuthority(() => sourceMap);
  const common = { ...value, ruleset: ruleset({ fly: true }), status, movementMode: 'fly', verticalAction: 'takeoff',
    origin: { x: 10, y: 50, elevationMeters: 0 } };
  const touching = validate({ ...common, waypoints: [{ x: 90, y: 50, elevationMeters: 10 }] });
  assert.equal(touching.valid, false);
  assert.equal(touching.code, 'path_blocked');
  const clear = validate({ ...common, waypoints: [{ x: 90, y: 50, elevationMeters: 12 }] });
  assert.equal(clear.valid, true);
  assert.ok(clear.costMeters > 80);
});

test('movement budget and canonical position are committed atomically', () => {
  const value = fixture({ budget: 90 });
  const sourceMap = map();
  const movementRuleset = ruleset({ waterWalk: true });
  const validate = createMovementAuthority(() => sourceMap);
  const result = applyWorldOperations(value.state, [{
    type: 'token.movePath', payload: {
      sceneId: 'scene-a', tokenId: 'token-a', tokenIds: ['token-a'],
      expectedOrigins: { 'token-a': { x: 10, y: 50, elevationMeters: 0 } },
      waypoints: [{ x: 90, y: 50, elevationMeters: 0 }], movementMode: 'waterWalk', method: 'drag',
    },
  }], { ruleset: movementRuleset, mapMetrics: { width: 100, height: 100 },
    validateTokenMovePath: args => validate({ ...args, ruleset: movementRuleset, status }) });
  const moved = result.state.preferences.worldV2.scenes[0].tokens[0];
  assert.equal(moved.x, 90);
  assert.equal(moved.movement.spentMeters, 80);
  assert.equal(result.results[0].motion[0].costMeters, 80);

  const before = structuredClone(result.state);
  assert.throws(() => applyWorldOperations(result.state, [{
    type: 'token.movePath', payload: {
      sceneId: 'scene-a', tokenId: 'token-a', tokenIds: ['token-a'],
      expectedOrigins: { 'token-a': { x: 90, y: 50, elevationMeters: 0 } },
      waypoints: [{ x: 75, y: 50, elevationMeters: 0 }], movementMode: 'walk', method: 'drag',
    },
  }], { ruleset: movementRuleset, mapMetrics: { width: 100, height: 100 },
    validateTokenMovePath: args => validate({ ...args, ruleset: movementRuleset, status }) }),
  { code: 'movement_budget_exceeded' });
  assert.deepEqual(result.state, before);
});

test('takeoff and landing require flight and landing returns to walk mode', () => {
  const value = fixture();
  const validate = createMovementAuthority(() => map({ water: false }));
  const common = { ...value, ruleset: ruleset({ fly: true }), status, movementMode: 'fly' };
  const takeoff = validate({ ...common,
    origin: { x: 10, y: 50, elevationMeters: 0 },
    waypoints: [{ x: 10, y: 50, elevationMeters: 6 }], verticalAction: 'takeoff',
  });
  assert.equal(takeoff.valid, true);
  assert.equal(takeoff.movementState.mode, 'fly');

  value.token.elevationMeters = 6;
  value.token.movement.mode = 'fly';
  const landing = validate({ ...common,
    origin: { x: 10, y: 50, elevationMeters: 6 },
    waypoints: [{ x: 10, y: 50, elevationMeters: 0 }], verticalAction: 'landing',
  });
  assert.equal(landing.valid, true);
  assert.equal(landing.movementState.mode, 'walk');

  const denied = validate({ ...common, ruleset: ruleset({ fly: false }),
    origin: { x: 10, y: 50, elevationMeters: 0 },
    waypoints: [{ x: 10, y: 50, elevationMeters: 6 }], verticalAction: 'takeoff',
  });
  assert.equal(denied.code, 'movement_flight_forbidden');
});
