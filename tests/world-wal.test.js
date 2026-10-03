import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorldWal } from '../deployment/local-server/world-wal.mjs';

function applyPatch(state, patch) {
  return { ...state, ...patch };
}

async function temporaryWal(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-wal-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'world.operations.ndjson');
  return { filePath, wal: createWorldWal({ filePath, applyPatch }) };
}

test('WAL replays contiguous durable operations after the baseline snapshot', async t => {
  const { wal } = await temporaryWal(t);
  await wal.append({ baseRevision: 0, revision: 1, operationId: 'one', patch: { count: 1 } });
  await wal.append({ baseRevision: 1, revision: 2, operationId: 'two', patch: { count: 2 } });
  const replayed = await wal.replay({ revision: 0, state: { count: 0 } });
  assert.equal(replayed.revision, 2);
  assert.deepEqual(replayed.state, { count: 2 });
});

test('WAL callers can skip the detached return record without changing durable bytes or replay', async t => {
  const normal = await temporaryWal(t);
  const noReturn = await temporaryWal(t);
  const input = { baseRevision: 0, revision: 1, operationId: 'one',
    patch: { nested: { count: 1 } }, results: [{ value: { count: 1 } }],
    timestamp: '2026-10-03T00:00:00.000Z' };
  const returned = await normal.wal.append(input);
  assert.equal(await noReturn.wal.append(input, { returnRecord: false }), undefined);
  assert.deepEqual(await readFile(noReturn.filePath), await readFile(normal.filePath));
  assert.notEqual(returned.patch, input.patch);
  returned.patch.nested.count = 99;
  returned.results[0].value.count = 99;
  assert.equal(input.patch.nested.count, 1);
  assert.equal(input.results[0].value.count, 1);
  const baseline = { revision: 0, state: {} };
  assert.deepEqual(await noReturn.wal.replay(baseline), await normal.wal.replay(baseline));
  assert.equal((await noReturn.wal.replay(baseline)).state.nested.count, 1);
});

test('WAL append without a return record still rejects a failed durable write', async t => {
  const { filePath } = await temporaryWal(t);
  const wal = createWorldWal({ filePath: path.join(filePath, 'missing.ndjson'), applyPatch });
  await assert.rejects(() => wal.append({ baseRevision: 0, revision: 1,
    operationId: 'one', patch: { count: 1 } }, { returnRecord: false }),
  error => error.code === 'ENOENT');
});

test('WAL truncates an incomplete final line and preserves complete records', async t => {
  const { filePath, wal } = await temporaryWal(t);
  await wal.append({ baseRevision: 0, revision: 1, operationId: 'one', patch: { count: 1 } });
  await appendFile(filePath, '{"baseRevision":1,"revision":2');
  const replayed = await wal.replay({ revision: 0, state: { count: 0 } });
  assert.equal(replayed.revision, 1);
  assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true);
  assert.equal((await readFile(filePath, 'utf8')).includes('"revision":2'), false);
});

test('WAL refuses checksum corruption in the middle of history', async t => {
  const { filePath, wal } = await temporaryWal(t);
  await wal.append({ baseRevision: 0, revision: 1, operationId: 'one', patch: { count: 1 } });
  await wal.append({ baseRevision: 1, revision: 2, operationId: 'two', patch: { count: 2 } });
  const lines = (await readFile(filePath, 'utf8')).trimEnd().split(/\r?\n/);
  const record = JSON.parse(lines[0]);
  record.patch.count = 999;
  lines[0] = JSON.stringify(record);
  const source = `${lines.join('\n')}\n{"incomplete":`;
  await writeFile(filePath, source);
  await assert.rejects(
    () => wal.replay({ revision: 0, state: { count: 0 } }),
    error => error.code === 'world_wal_corrupt' && /checksum mismatch/.test(error.message),
  );
  assert.equal(await readFile(filePath, 'utf8'), source);
});

test('upgrade WAL replay preserves a torn tail until the complete original can be backed up', async t => {
  const { filePath, wal } = await temporaryWal(t);
  await wal.append({ baseRevision: 0, revision: 1, operationId: 'one', patch: { count: 1 } });
  await appendFile(filePath, '{"baseRevision":1');
  const original = await readFile(filePath);
  const replayed = await wal.replay({ revision: 0, state: { count: 0 } }, { repairTail: false });
  assert.equal(replayed.revision, 1);
  assert.equal(replayed.state.count, 1);
  assert.deepEqual(await readFile(filePath), original);
  await wal.replay(replayed);
  assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true);
});
