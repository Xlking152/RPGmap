import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ordinary Actor editor writes use the canonical World operation port', () => {
  const source = readFileSync(path.join(ROOT, 'src/entities/ui.js'), 'utf8');
  assert.match(source, /upsertCanonicalActor/);
  assert.doesNotMatch(source, /entityState\(\)\.actors\.push/);
  assert.doesNotMatch(source, /persistAndRender/);
  assert.doesNotMatch(source, /store\.persist\(\)/);
  // The only remaining EntityStore write in this UI is the explicit legacy
  // marker migration boundary, which supplies a whole migration appState.
  const writes = source.match(/store\.persist\(/g) || [];
  assert.equal(writes.length, 1);
  assert.match(source, /store\.persist\(\{ appState: next \}\)/);
});
