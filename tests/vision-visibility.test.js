import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibilityRows } from '../src/vision/visibility.js';

test('lighting-grid visibility honors disabled LOS and retains vague range', () => {
  const input = {
    map: { width: 100, height: 100, metersPerUnit: 1 },
    source: { x: 20, y: 50, elevationMeters: 0, preciseRangeMeters: 80, vagueRangeMeters: 90,
      lighting: 'dim', lineOfSightEnabled: false },
    occluders: [{ polygon: [[40, 0], [45, 0], [45, 100], [40, 100]], blockingHeightMeters: 20 }],
  };
  const open = computeVisibilityRows(input);
  assert.deepEqual(open, computeVisibilityRows({ ...input, occluders: [] }));
  const blocked = computeVisibilityRows({ ...input, source: { ...input.source, lineOfSightEnabled: true } });
  const contains = rows => rows.some(([row, spans]) => Number(row) === 10 && spans.some(([a, b]) => a <= 12 && b >= 12));
  assert.equal(contains(open.vague), true);
  assert.equal(contains(blocked.vague), false);
});

test('Worker visibility entry uses the same result as the synchronous fallback', async () => {
  const original = globalThis.self;
  let response;
  globalThis.self = { postMessage(value) { response = value; } };
  try {
    await import('../src/vision/worker.js');
    for (const lighting of ['normal', 'dim', 'dark']) {
      const input = { kind: 'visibility', map: { width: 100, height: 100, metersPerUnit: 1 },
        source: { x: 20, y: 20, rangeMeters: 30, lighting }, lights: [], occluders: [] };
      self.onmessage({ data: { id: 7, input } });
      assert.deepEqual(response, { id: 7, result: computeVisibilityRows(input) });
    }
  } finally { globalThis.self = original; }
});

test('Worker cancels a long exploration slice and can process fresh geometry afterwards', async () => {
  const original = globalThis.self;
  const responses = [];
  globalThis.self = { postMessage(value) { responses.push(value); } };
  try {
    await import('../src/vision/worker.js?cancellation-regression');
    const work = self.onmessage({ data: { id: 88, input: { partyId: 'party',
      map: { width: 10000, height: 10000, metersPerUnit: 1 }, lights: [], occluders: [],
      payload: { from: { x: 500, y: 500 }, to: { x: 4700, y: 500 }, radiusMeters: 1000 },
      lineOfSightEnabled: false } } });
    await self.onmessage({ data: { cancelIds: [88] } });
    await work;
    assert.deepEqual(responses, [], 'cancelled exploration must not send an obsolete result');
    const input = { kind: 'visibility', continuous: true,
      map: { width: 100, height: 100, metersPerUnit: 1 },
      source: { x: 20, y: 20, rangeMeters: 30, lighting: 'normal' }, lights: [], occluders: [] };
    await self.onmessage({ data: { id: 89, input } });
    assert.deepEqual(responses, [{ id: 89, result: computeVisibilityRows(input) }]);
  } finally { globalThis.self = original; }
});
