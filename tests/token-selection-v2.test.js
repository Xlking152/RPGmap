import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenIdsInBounds } from '../src/selection/state.js';

test('selection bounds use canonical Scene Token x/y and ignore hidden or feature Tokens', () => {
  const tokens = [
    { id: 'a', placement: 'map', x: 5, y: 5, hidden: false },
    { id: 'b', placement: 'map', x: 8, y: 7, hidden: true },
    { id: 'c', placement: 'feature', x: null, y: null, featureId: 'room-1', hidden: false },
    { id: 'd', placement: 'map', x: 15, y: 15, hidden: false },
  ];
  assert.deepEqual(tokenIdsInBounds(tokens, { x: 0, y: 0 }, { x: 10, y: 10 }), ['a']);
});

test('Character-shaped inputs are not accepted by the runtime selection contract', () => {
  const legacy = [{ id: 'legacy-a', visible: true, location: { type: 'map', x: 2, y: 3 } }];
  assert.deepEqual(tokenIdsInBounds(legacy, { x: 0, y: 0 }, { x: 5, y: 5 }), []);
});
