import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('Actor placement bridge bypasses legacy Character creation', async () => {
  const path = fileURLToPath(new URL('../src/token/actor-placement-ui.js', import.meta.url));
  const source = await readFile(path, 'utf8');
  assert.match(source, /createActorTokenAtPoint/);
  assert.match(source, /api\.emit\?\.\('token:create'/);
  assert.match(source, /stopImmediatePropagation\(\)/);
  assert.doesNotMatch(source, /api\.placeCharacter/);
  assert.doesNotMatch(source, /state\.characters|\.characters\.push|bindToken\s*\(/);
});

test('placement adapter writes through api.tokens.create and never Character storage', async () => {
  const path = fileURLToPath(new URL('../src/token/placement.js', import.meta.url));
  const source = await readFile(path, 'utf8');
  assert.match(source, /api\.tokens\.create\(/);
  assert.doesNotMatch(source, /state\.characters|bindToken\s*\(/);
});

test('Actor placement bridge is registered after Token Runtime and before Entity UI', async () => {
  const path = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const source = await readFile(path, 'utf8');
  const runtime = source.indexOf('createTokenRuntimeSystem(),');
  const placement = source.indexOf('createActorTokenPlacementUiSystem(),');
  const entities = source.indexOf('createEntitySystem({ dropLegacyMarkers: false }),');
  assert.ok(runtime >= 0 && placement > runtime && entities > placement);
});
