import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createActorFromRulesetImport } from '../src/actor/index.js';
import { resolveInfiniteHorrorDetection } from '../src/rulesets/infinite-horror/detection.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { applySyntheticActorStatusBatch } from '../src/token/synthetic-status.js';

const movementIndex = await readFile(new URL('../src/movement/index.js', import.meta.url), 'utf8');
const movementController = await readFile(new URL('../src/movement/controller.js', import.meta.url), 'utf8');

function monsterActor() {
  return createActorFromRulesetImport({
    formName: 'Default',
    identity: { name: '怪物模板' },
    resources: { hp: { max: 10 }, stamina: { max: 5 }, willpower: { max: 5 } },
    attributes: [{ id: 'perception', name: '感知', base: 3 }],
    checks: { skills: [], saves: [] },
    badStatuses: [],
    combat: { attacks: [], defenses: [] },
    tokenAppearance: { color: '#334455', scale: 1 },
    source: { type: 'manual' },
  }, {
    id: 'monster-template',
    name: '怪物模板',
    type: 'monster',
    partyId: null,
    variantId: 'monster-form',
    variantName: 'Default',
    ruleset: infiniteHorrorRuleset,
  });
}

function token(id, x) {
  return {
    id,
    actorId: 'monster-template',
    actorLink: false,
    actorDelta: null,
    placement: 'map',
    x,
    y: 20,
    featureId: null,
    diameterMeters: 1,
    rotation: 0,
    elevationFt: 0,
    controllerUserIds: [],
    vision: { enabled: true, rangeOverrideMeters: null, overrideUserIds: [] },
    locked: false,
    showName: true,
    effects: [],
  };
}

function world() {
  return {
    schemaVersion: 3,
    id: 'world-v223',
    name: 'Regression',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    actors: [monsterActor()],
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
    activeSceneId: 'scene-a',
    scenes: [{
      id: 'scene-a', name: 'Scene A', mapPackage: { id: 'map-a', version: '1' },
      tokens: [token('monster-a', 10), token('monster-b', 30)],
      markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, fog: {}, settings: {},
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('Movement V5 keeps document drag lifecycle and coalesces repeated WASD input', () => {
  assert.match(movementIndex, /createMovementController\(\{ settings \}\)\.register\(api\)/);
  assert.match(movementController, /documentNode\.addEventListener\('pointermove', pointerMove, true\)/);
  assert.match(movementController, /documentNode\.addEventListener\('pointerup', pointerUp, true\)/);
  assert.match(movementController, /const keyboardQueue = \[\]/);
  assert.match(movementController, /while \(keyboardQueue\.length/);
  assert.match(movementController, /sameDirection\(last, direction\)/);
  assert.match(movementController, /KEYBOARD_BATCH_DELAY_MS = 50/);
  assert.match(movementController, /MAX_KEYBOARD_BATCH_STEPS = 8/);
  assert.match(movementController, /api\.movementFast\.moveTokenPath/);
  assert.match(movementController, /setPointerCapture|releasePointerCapture/);
});

test('stable Movement Controller restores Ctrl/Cmd segmented waypoints without versioned runtimes', () => {
  assert.match(movementController, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(movementController, /current\.mode = 'click'/);
  assert.match(movementController, /async function addWaypoint/);
  assert.match(movementController, /function removeWaypoint/);
  assert.match(movementController, /\[current\.start, \.\.\.current\.waypoints, target\]/);
  assert.match(movementController, /addWaypoint\(point = interaction\?\.current\)/);
  assert.doesNotMatch(movementController, /addWaypoint\(\) \{ return false; \}/);
});

test('configured and overridden vision keeps ruleset ranges above 120 m', () => {
  const configured = resolveInfiniteHorrorDetection({
    form: { detection: { configured: true, preciseRangeMeters: 300, vagueRangeMeters: 450, senses: {} } },
    lighting: 'normal',
  });
  assert.equal(configured.preciseRangeMeters, 300);
  assert.equal(configured.vagueRangeMeters, 450);

  const overridden = resolveInfiniteHorrorDetection({
    form: { detection: { configured: true, preciseRangeMeters: 30, vagueRangeMeters: 60, senses: {} } },
    runtime: { detectionOverrides: { preciseRangeMeters: 200, vagueRangeMeters: 350 } },
    lighting: 'normal',
  });
  assert.equal(overridden.preciseRangeMeters, 200);
  assert.equal(overridden.vagueRangeMeters, 350);
});

test('monster status batch writes each unlinked Token actorDelta instead of the Actor template', () => {
  const base = world();
  const applied = applySyntheticActorStatusBatch(base, [
    { type: 'status.apply', scope: 'syntheticActor', targetId: 'monster-a', definitionId: 'status-rooted' },
    { type: 'status.apply', scope: 'syntheticActor', targetId: 'monster-b', definitionId: 'status-rooted' },
  ], {
    ruleset: infiniteHorrorRuleset,
    idFactory: (() => { let value = 0; return () => `effect-${++value}`; })(),
    now: '2026-01-01T00:00:01.000Z',
  });

  assert.deepEqual(applied.world.actors[0].effects || [], []);
  assert.equal(applied.world.scenes[0].tokens[0].actorDelta.effects[0].definitionId, 'status-rooted');
  assert.equal(applied.world.scenes[0].tokens[1].actorDelta.effects[0].definitionId, 'status-rooted');
  assert.deepEqual(base.scenes[0].tokens.map(item => item.actorDelta), [null, null]);
});
