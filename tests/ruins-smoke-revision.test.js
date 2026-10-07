import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCommittedVisionRevision, matchesCommittedRuinsFeedback } from '../scripts/ruins-browser-smoke.mjs';

function fixture() {
  let revision = 10;
  const listeners = new Set();
  return { listeners, api: {
    on(_name, callback) { listeners.add(callback); return () => listeners.delete(callback); },
    getStateRevision() { return revision; },
  }, commit(source) { revision += 1; for (const callback of listeners) callback({ detail: { source } }); } };
}

test('fixed-source pressure waits for the actual displayed mask to finish its movement', () => {
  const point = { x: 3628.528142813593, y: 1242.984768981114 };
  const frame = { rendered: true, stateRevision: 12, requestedAt: 150, source: { ...point } };
  assert.equal(matchesCommittedRuinsFeedback(frame, 11, 100, point), true);
  assert.equal(matchesCommittedRuinsFeedback({ ...frame, source: { ...point, y: 1333 } }, 11, 100, point), false,
    'a newer frame halfway through the animation is not the confirmed observation point');
  assert.equal(matchesCommittedRuinsFeedback({ ...frame, source: undefined }, 11, 100, point), false);
  assert.equal(matchesCommittedRuinsFeedback(frame, 13, 100, point), false);
  assert.equal(matchesCommittedRuinsFeedback(frame, 11, 151, point), false);
  assert.equal(matchesCommittedRuinsFeedback({ ...frame, rendered: false }, 11, 100, point), false);
  assert.equal(matchesCommittedRuinsFeedback({ ...frame, source: { ...point, y: 1333 } }, 11, 100), true,
    'ordinary movement feedback continues to follow the live animation');
});

test('ruins feedback follows the destruction commit despite a later Fog write before ACK', async () => {
  const f = fixture();
  const result = await captureCommittedVisionRevision(f.api, 'feature:damage', async () => {
    f.commit('document.feature:damage');
    await Promise.resolve();
    f.commit('document.vision:exploration-commit');
    return { ok: true };
  });
  assert.deepEqual(result, { value: { ok: true }, revision: 11 });
  assert.equal(f.api.getStateRevision(), 12);
  assert.equal(f.listeners.size, 0);
});

test('an unrelated Fog commit cannot satisfy a missing destruction authority commit', async () => {
  const f = fixture();
  await assert.rejects(captureCommittedVisionRevision(f.api, 'feature:damage', async () => {
    f.commit('document.vision:exploration-commit');
    return { ok: true };
  }), /No authoritative commit/);
  assert.equal(f.listeners.size, 0);
});

test('failed authority commits propagate and always release the revision observer', async () => {
  const f = fixture();
  const error = new Error('geometry validation failed');
  await assert.rejects(captureCommittedVisionRevision(f.api, 'feature:damage', async () => { throw error; }), error);
  assert.equal(f.listeners.size, 0);
});
