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
  await writeFile(filePath, `${lines.join('\n')}\n`);
  await assert.rejects(
    () => wal.replay({ revision: 0, state: { count: 0 } }),
    error => error.code === 'world_wal_corrupt' && /checksum mismatch/.test(error.message),
  );
});
