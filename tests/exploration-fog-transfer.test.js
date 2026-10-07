import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorationFogSender, createExplorationFogReceiver } from '../deployment/local-server/exploration-fog-transfer.mjs';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { computeExplorationChunk } from '../src/server/exploration-compute.js';

function fixture() {
  const validate = createCanonicalWorldValidator();
  const sender = createExplorationFogSender(validate.isImmutableData), receiver = createExplorationFogReceiver();
  const accept = rows => { validate({ fog: { exploredByParty: { party: { rows } } } }); return rows; };
  const transfer = (key, rows) => {
    const message = sender.prepare(key, rows);
    return { message, rows: receiver.receive(structuredClone(message)) };
  };
  return { sender, receiver, accept, transfer };
}

test('eight interleaved parties transfer unchanged accepted Fog only once and apply row edits/deletions exactly', () => {
  const { sender, receiver, accept, transfer } = fixture();
  const parties = Array.from({ length: 8 }, (_, party) => accept(Object.fromEntries(
    Array.from({ length: 320 }, (_, row) => [String(row), [[party, party + 5], [party + 9, party + 12]]]))));
  for (let round = 0; round < 5; round++) for (let party = 0; party < 8; party++) {
    const result = transfer(`party-${party}`, parties[party]);
    assert.deepEqual(result.rows, parties[party]);
    assert.equal(Object.keys(result.message.fogUpdate.rows).length, round ? 0 : 320);
  }
  const edited = { ...parties[2], 7: [[1, 40]], 400: [[2, 5]] }; delete edited[3]; accept(edited);
  const result = transfer('party-2', edited);
  assert.deepEqual(Object.keys(result.message.fogUpdate.rows), ['7', '400']);
  assert.deepEqual(result.message.fogUpdate.removed, ['3']);
  assert.deepEqual(result.rows, edited);
  assert.equal(sender.size(), 8); assert.equal(receiver.size(), 8);
  sender.clear(); receiver.clear(); assert.equal(sender.size(), 0); assert.equal(receiver.size(), 0);
});

test('mutable and pending row arrays are retransmitted rather than trusted by identity', () => {
  const { accept, transfer } = fixture();
  const stable = accept({ 0: [[1, 5]] });
  const rows = { ...stable, 1: [[2, 3]] };
  assert.deepEqual(transfer('pending', rows).rows, rows);
  rows[1][0][1] = 9;
  const result = transfer('pending', rows);
  assert.deepEqual(Object.keys(result.message.fogUpdate.rows), ['1']);
  assert.deepEqual(result.rows, rows);
  const final = accept(rows);
  assert.deepEqual(transfer('pending', final).rows, final);
  assert.deepEqual(transfer('pending', final).message.fogUpdate.rows, {});
});

test('reset generations, cache eviction and Worker failure rebuild complete history without speculative Fog', () => {
  const { sender, receiver, accept, transfer } = fixture(), rows = accept({ 0: [[1, 5]] });
  transfer('world:scene:party:0', rows);
  const reset = transfer('world:scene:party:1', {});
  assert.deepEqual(reset.rows, {}); assert.equal(reset.message.fogUpdate.baseVersion, null);
  for (let index = 0; index < 10; index++) transfer(`party-${index}`, rows);
  assert.equal(sender.size(), 8); assert.equal(receiver.size(), 8);
  assert.equal(transfer('world:scene:party:0', rows).message.fogUpdate.baseVersion, null);
  receiver.clear();
  assert.throws(() => receiver.receive(structuredClone(sender.prepare('world:scene:party:0', rows))), /Fog version/);
  sender.clear(); assert.deepEqual(transfer('world:scene:party:0', rows).rows, rows);
  const job = { id: 'job', cursor: 0, totalSamples: 2, tokenId: 'scout', vagueRangeMeters: 20,
    path: [{ x: 20, y: 20, elevationMeters: 0 }, { x: 22.5, y: 20, elevationMeters: 0 }] };
  const context = { map: { width: 60, height: 60, metersPerUnit: 1 }, occluders: [], lights: [] };
  const received = transfer('compute', rows).rows;
  const before = structuredClone(received);
  assert.deepEqual(computeExplorationChunk({ job, context, exploredRows: received, budgetMs: Infinity }),
    computeExplorationChunk({ job, context, exploredRows: rows, budgetMs: Infinity }));
  assert.deepEqual(received, before, 'computed cells cannot become confirmed transfer history');
  assert.deepEqual(transfer('compute', rows).rows, rows);
});

test('legacy full messages remain compatible; malformed or stale deltas never become empty Fog', () => {
  const { sender, receiver } = fixture();
  assert.deepEqual(receiver.receive({ exploredRows: { 4: [[1, 3]] } }), { 4: [[1, 3]] });
  const extra = { 0: [[1, 3]], extension: 'legacy' };
  assert.deepEqual(sender.prepare('legacy', extra), { exploredRows: extra, fogResetKey: 'legacy' });
  for (const fogUpdate of [
    { key: 'x', version: 1, baseVersion: 99, rows: {}, removed: [] },
    { key: 'x', version: 1, baseVersion: null, rows: { constructor: [] }, removed: [] },
    { key: 'x', version: 1, baseVersion: null, rows: {}, removed: ['__proto__'] },
  ]) assert.throws(() => receiver.receive({ fogUpdate }), /Fog version/);
});
