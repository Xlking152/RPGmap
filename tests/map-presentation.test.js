import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boxesOverlap,
  chooseLabelPlacement,
  zoomTierForScale,
} from '../src/render/map-presentation.js';

test('zoom presentation uses stable overview, mid and detail thresholds', () => {
  assert.equal(zoomTierForScale(0.12), 'overview');
  assert.equal(zoomTierForScale(0.24), 'overview');
  assert.equal(zoomTierForScale(0.25), 'mid');
  assert.equal(zoomTierForScale(0.52), 'mid');
  assert.equal(zoomTierForScale(0.53), 'detail');
});

test('label placement selects the first collision-free candidate', () => {
  const placement = chooseLabelPlacement({
    box: { left: 10, right: 40, top: 10, bottom: 30 },
    candidates: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }],
    occupied: [{ left: 5, right: 45, top: 5, bottom: 35 }],
    viewport: { left: 0, right: 120, top: 0, bottom: 100 },
    padding: 2,
  });

  assert.deepEqual(placement.offset, { x: 40, y: 0 });
  assert.equal(placement.score, 0);
});

test('label overlap treats configured padding as protected breathing room', () => {
  const left = { left: 0, right: 20, top: 0, bottom: 20 };
  const nearby = { left: 23, right: 40, top: 0, bottom: 20 };
  assert.equal(boxesOverlap(left, nearby, 0), false);
  assert.equal(boxesOverlap(left, nearby, 4), true);
});

test('label placement reports unavoidable viewport overflow separately from collisions', () => {
  const placement = chooseLabelPlacement({
    box: { left: -30, right: 20, top: 10, bottom: 30 },
    candidates: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
    viewport: { left: 0, right: 100, top: 0, bottom: 100 },
    padding: 4,
  });

  assert.ok(placement.overflow > 0);
  assert.equal(placement.collisions, 0);
});
