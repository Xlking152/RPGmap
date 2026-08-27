import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('Actor placement bridge bypasses legacy Character creation', async () => {
  const path = fileURLToPath(new URL('../src/token/actor-placement-ui.js', import.meta.url));
  const source = await readFile(path, 'utf8');
  const runtimeSource = withoutComments(source);
  assert.match(runtimeSource, /createActorTokenAtPoint/);
  assert.match(runtimeSource, /api\.emit\?\.\('token:create'/);
  assert.match(runtimeSource, /stopImmediatePropagation\(\)/);
  assert.doesNotMatch(runtimeSource, /api\.placeCharacter/);
  assert.doesNotMatch(runtimeSource, /state\.characters|\.characters\.push|bindToken\s*\(/);
});

test('placement adapter writes through api.tokens.create and never Character storage', async () => {
  const path = fileURLToPath(new URL('../src/token/placement.js', import.meta.url));
  const source = withoutComments(await readFile(path, 'utf8'));
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
