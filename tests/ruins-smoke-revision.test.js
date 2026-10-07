import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCommittedVisionRevision } from '../scripts/ruins-browser-smoke.mjs';

function fixture() {
  let revision = 10;
  const listeners = new Set();
  return { listeners, api: {
    on(_name, callback) { listeners.add(callback); return () => listeners.delete(callback); },
    getStateRevision() { return revision; },
  }, commit(source) { revision += 1; for (const callback of listeners) callback({ detail: { source } }); } };
}

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
