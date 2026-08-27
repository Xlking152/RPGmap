import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('Entity Token controller owns Actor placement without legacy Character create/reposition writes', async () => {
  const path = fileURLToPath(new URL('../src/entities/token-controller.js', import.meta.url));
  const source = withoutComments(await readFile(path, 'utf8'));
  assert.match(source, /createActorTokenAtPoint/);
  assert.match(source, /relocateActorTokenAtPoint/);
  assert.match(source, /api\.emit\?\.\('token:create'/);
  assert.match(source, /api\.emit\?\.\('token:move'/);
  assert.match(source, /stopImmediatePropagation\(\)/);
  assert.doesNotMatch(source, /api\.placeCharacter/);
  assert.doesNotMatch(source, /api\.repositionCharacter/);
  assert.doesNotMatch(source, /character:create|character:move|state\.characters|\.characters\.push|bindToken\s*\(/);
});

test('placement adapter writes through canonical Token create/move and never Character storage', async () => {
  const path = fileURLToPath(new URL('../src/token/placement.js', import.meta.url));
  const source = withoutComments(await readFile(path, 'utf8'));
  assert.match(source, /api\.tokens\.create\(/);
  assert.match(source, /api\.tokens\.move\(/);
  assert.doesNotMatch(source, /state\.characters|bindToken\s*\(/);
  assert.doesNotMatch(source, /placeCharacter\s*\(|repositionCharacter\s*\(/);
});

test('Entity UI calls canonical placement directly and startup no longer registers a placement bridge', async () => {
  const ui = withoutComments(await readFile(fileURLToPath(new URL('../src/entities/ui.js', import.meta.url)), 'utf8'));
  const main = withoutComments(await readFile(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8'));
  const index = withoutComments(await readFile(fileURLToPath(new URL('../src/token/index.js', import.meta.url)), 'utf8'));

  assert.match(ui, /createEntityTokenController/);
  assert.match(ui, /tokenController\.beginPlacement\(/);
  assert.match(ui, /tokenController\.handleMapClick/);
  assert.doesNotMatch(ui, /api\.placeCharacter|api\.repositionCharacter|store\.bindToken/);
  assert.doesNotMatch(main, /createActorTokenPlacementUiSystem/);
  assert.doesNotMatch(index, /createActorTokenPlacementUiSystem|actor-placement-ui/);
});
