import test from 'node:test';
import assert from 'node:assert/strict';
import { withinMillisecondsBudget } from '../scripts/performance-budget.mjs';

test('elapsed timestamp subtraction at the budget is compared at nanosecond precision', () => {
  assert.equal(withinMillisecondsBudget(16.7, 16.7), true);
  assert.equal(withinMillisecondsBudget(16.700000047683716, 16.7), true);
  assert.equal(withinMillisecondsBudget(16.699999952316284, 16.7), true);
  for (const value of [16.700001, 16.701, 17, -1, NaN, Infinity, '16.7', null]) {
    assert.equal(withinMillisecondsBudget(value, 16.7), false, String(value));
  }
});
