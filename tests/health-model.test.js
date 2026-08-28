import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEALTH_MODE_SIMPLE,
  HEALTH_MODE_WOUND_TRACK,
  applySimpleDamage,
  applyWoundDamage,
  createHealthRuntime,
  resolveHealth,
} from '../src/rulesets/infinite-horror/health.js';

test('wound track follows the rulebook 20-slot example', () => {
  let runtime = createHealthRuntime({ mode: HEALTH_MODE_WOUND_TRACK, max: 20, simpleCurrent: 20 });
  runtime = applyWoundDamage(runtime, { amount: 3, type: 'B' }, { max: 20 }).runtime;
  runtime = applyWoundDamage(runtime, { amount: 4, type: 'L' }, { max: 20 }).runtime;
  runtime = applyWoundDamage(runtime, { amount: 5, type: 'A' }, { max: 20 }).runtime;
  assert.deepEqual(resolveHealth(runtime, { max: 20 }), {
    mode: HEALTH_MODE_WOUND_TRACK,
    max: 20,
    current: 8,
    healthy: 8,
    bashing: 3,
    lethal: 4,
    aggravated: 5,
    weightedDamage: 26,
    injury: 'moderate',
    status: 'normal',
    deteriorating: false,
    dead: false,
    unconscious: false,
  });
});

test('mixed B then L overflow upgrades wounds in the documented order', () => {
  let runtime = createHealthRuntime({ mode: HEALTH_MODE_WOUND_TRACK, max: 20, simpleCurrent: 20 });
  runtime = applyWoundDamage(runtime, { bashing: 3, lethal: 4, aggravated: 5 }, { max: 20 }).runtime;
  const result = applyWoundDamage(runtime, { bashing: 10, lethal: 10 }, { max: 20 });
  assert.equal(result.state.healthy, 0);
  assert.equal(result.state.bashing, 0);
  assert.equal(result.state.lethal, 14);
  assert.equal(result.state.aggravated, 6);
  assert.equal(result.state.unconscious, true);
  assert.equal(result.state.deteriorating, true);
});

test('all aggravated slots means dead', () => {
  let runtime = createHealthRuntime({ mode: HEALTH_MODE_WOUND_TRACK, max: 6, simpleCurrent: 6 });
  runtime = applyWoundDamage(runtime, { amount: 6, type: 'A' }, { max: 6 }).runtime;
  const state = resolveHealth(runtime, { max: 6 });
  assert.equal(state.dead, true);
  assert.equal(state.status, 'dead');
});

test('simple hp remains available as a generic mode', () => {
  const result = applySimpleDamage(12, 5, 12);
  assert.deepEqual(result, { current: 7, applied: 5, overflow: 0 });
  const runtime = createHealthRuntime({ mode: HEALTH_MODE_SIMPLE, max: 12, simpleCurrent: 7 });
  const state = resolveHealth(runtime, { max: 12, simpleCurrent: 7 });
  assert.equal(state.mode, HEALTH_MODE_SIMPLE);
  assert.equal(state.current, 7);
});

test('injury state uses B-equivalent weighting from the rulebook', () => {
  let runtime = createHealthRuntime({ mode: HEALTH_MODE_WOUND_TRACK, max: 10, simpleCurrent: 10 });
  runtime = applyWoundDamage(runtime, { amount: 2, type: 'L' }, { max: 10 }).runtime;
  let state = resolveHealth(runtime, { max: 10 });
  assert.equal(state.weightedDamage, 4);
  assert.equal(state.injury, 'minor');
  runtime = applyWoundDamage(runtime, { amount: 4, type: 'A' }, { max: 10 }).runtime;
  state = resolveHealth(runtime, { max: 10 });
  assert.equal(state.weightedDamage, 16);
  assert.equal(state.injury, 'moderate');
});
