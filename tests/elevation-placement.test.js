import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getActiveMoverContext,
  resetElevationNavigationRuntime,
  setActiveMoverContext,
  withActiveMoverContext,
} from '../src/elevation/index.js';

test('elevation Navigation context stores canonical tokenId and non-negative elevation only', () => {
  setActiveMoverContext({ tokenId: 'token-high', elevationFt: 80 });
  assert.deepEqual(getActiveMoverContext(), { tokenId: 'token-high', elevationFt: 80 });
  setActiveMoverContext({ tokenId: 'token-low', elevationFt: -20 });
  assert.deepEqual(getActiveMoverContext(), { tokenId: 'token-low', elevationFt: 0 });
  resetElevationNavigationRuntime();
});

test('withActiveMoverContext restores the prior Token mover after the task', async () => {
  setActiveMoverContext({ tokenId: 'token-a', elevationFt: 15 });
  await withActiveMoverContext({ tokenId: 'token-b', elevationFt: 45 }, async () => {
    assert.deepEqual(getActiveMoverContext(), { tokenId: 'token-b', elevationFt: 45 });
  });
  assert.deepEqual(getActiveMoverContext(), { tokenId: 'token-a', elevationFt: 15 });
  resetElevationNavigationRuntime();
});
