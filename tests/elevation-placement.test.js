import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getActiveMoverContext,
  resetElevationNavigationRuntime,
  setActiveMoverContext,
  withActiveMoverContext,
} from '../src/elevation/index.js';

test('elevation Navigation context stores canonical tokenId and non-negative elevation only', () => {
  setActiveMoverContext({ tokenId: 'token-high', elevationMeters: 80 });
  assert.deepEqual(getActiveMoverContext(), { tokenId: 'token-high', elevationMeters: 80 });
  setActiveMoverContext({ tokenId: 'token-low', elevationMeters: -20 });
  assert.deepEqual(getActiveMoverContext(), { tokenId: 'token-low', elevationMeters: 0 });
  resetElevationNavigationRuntime();
});

test('withActiveMoverContext restores the prior Token mover after the task', async () => {
  setActiveMoverContext({ tokenId: 'token-a', elevationMeters: 15 });
  await withActiveMoverContext({ tokenId: 'token-b', elevationMeters: 45 }, async () => {
    assert.deepEqual(getActiveMoverContext(), { tokenId: 'token-b', elevationMeters: 45 });
  });
  assert.deepEqual(getActiveMoverContext(), { tokenId: 'token-a', elevationMeters: 15 });
  resetElevationNavigationRuntime();
});
