import assert from 'node:assert/strict';
import test from 'node:test';

import {
  featureBounds,
  featureIdsForEvent,
  featureSceneStatus,
  inspectableFeaturesAtPoint
} from '../src/engine/feature-selection.js';

function feature(id, category, importance, points, extra = {}) {
  return {
    id,
    name: id,
    category,
    importance,
    geometry: { type: 'polygon', points },
    capabilities: { inspectable: true },
    ...extra
  };
}

test('feature inspection prefers visual importance and then the smaller footprint', () => {
  const point = { x: 5, y: 5 };
  const features = [
    feature('wall', 'wall', 'secondary', [[0, 0], [20, 0], [20, 20], [0, 20]]),
    feature('gate-wide', 'wall', 'primary', [[0, 0], [12, 0], [12, 12], [0, 12]]),
    feature('gate-tight', 'wall', 'primary', [[2, 2], [8, 2], [8, 8], [2, 8]]),
    feature('ground', 'terrain', 'detail', [[0, 0], [30, 0], [30, 30], [0, 30]], { severeOnly: true })
  ];

  assert.deepEqual(
    inspectableFeaturesAtPoint(point, features).map(item => item.id),
    ['gate-tight', 'gate-wide', 'wall']
  );
});

test('inspection no longer falls back to map categories', () => {
  const point = { x: 5, y: 5 };
  const legacyBuilding = {
    id: 'legacy-building',
    category: 'building',
    geometry: { type: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  };
  const genericInspectable = {
    id: 'console',
    category: 'mechanism',
    capabilities: { inspectable: true },
    geometry: { type: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  };
  assert.deepEqual(inspectableFeaturesAtPoint(point, [legacyBuilding, genericInspectable]).map(item => item.id), ['console']);
});

test('scene event feature IDs are unique for damage and restore records', () => {
  assert.deepEqual(featureIdsForEvent({
    type: 'damage',
    objectIds: ['hall', 'gate'],
    clipHits: [{ featureId: 'gate' }, { featureId: 'wall' }]
  }), ['hall', 'gate', 'wall']);
  assert.deepEqual(featureIdsForEvent({ type: 'restore', featureIds: ['wall', 'wall', 'gate'] }), ['wall', 'gate']);
});

test('feature status follows damage, partial clipping, restore and linear undo semantics', () => {
  const damage = {
    id: 'scene-1',
    type: 'damage',
    objectIds: ['hall'],
    clipHits: [{ featureId: 'wall', polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] }]
  };
  assert.equal(featureSceneStatus('hall', [damage]), 'destroyed');
  assert.equal(featureSceneStatus('wall', [damage]), 'partial');
  assert.equal(featureSceneStatus('tree', [damage]), 'intact');
  assert.equal(featureSceneStatus('hall', [damage, {
    id: 'scene-2', type: 'restore', featureIds: ['hall']
  }]), 'intact');
});

test('feature bounds combine all selected object geometry', () => {
  const features = [
    feature('a', 'building', 'secondary', [[10, 20], [30, 20], [30, 40], [10, 40]]),
    feature('b', 'bridge', 'primary', [[-5, 8], [5, 8], [5, 12], [-5, 12]])
  ];
  assert.deepEqual(featureBounds(['a', 'b'], features), {
    minX: -5, minY: 8, maxX: 30, maxY: 40
  });
  assert.equal(featureBounds(['missing'], features), null);
});
