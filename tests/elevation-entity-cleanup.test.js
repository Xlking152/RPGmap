import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const entityUi = withoutComments(await readFile(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8'));
const tokenController = withoutComments(await readFile(new URL('../src/entities/token-controller.js', import.meta.url), 'utf8'));
const runtimeSource = withoutComments(await readFile(new URL('../src/engine/runtime.js', import.meta.url), 'utf8'));
const appShellSource = withoutComments(await readFile(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8'));
const interactionIndex = withoutComments(await readFile(new URL('../src/interaction/index.js', import.meta.url), 'utf8'));

test('modern live Entity UI owns an Actor panel and recognizes only canonical Token DOM', () => {
  assert.match(entityUi, /const panel = api\.uiPanels\?\.actors/);
  assert.match(entityUi, /closest\?\.\('\.rpg-token-v2'\)/);
  assert.match(entityUi, /api\.on\('token:select'/);
  assert.match(entityUi, /api\.on\('token:create'/);
  assert.match(entityUi, /api\.on\('token:delete'/);
  assert.match(entityUi, /api\.on\('token:move'/);
  assert.doesNotMatch(entityUi, /\.rpg-character|data-character-id|character:create|character:move|character:delete|api\.placeCharacter|api\.repositionCharacter/);
});

test('Entity Token controller emits only Token runtime identities', () => {
  assert.match(tokenController, /tokenId: token\.id, actorId: token\.actorId/);
  assert.match(tokenController, /api\.emit\?\.\('token:create'/);
  assert.match(tokenController, /api\.emit\?\.\('token:move'/);
  assert.doesNotMatch(tokenController, /characterId|character:create|character:move|character:delete|\.rpg-character|api\.placeCharacter|api\.repositionCharacter/);
});

test('Actor panel is created directly by Runtime V2 with no legacy characters panel bridge', () => {
  assert.match(runtimeSource, /actors:/);
  assert.match(appShellSource, /api\.uiPanels\?\.actors/);
  assert.doesNotMatch(runtimeSource, /data-panel=["']characters["']|panel-ownership|characterPane/);
  assert.doesNotMatch(appShellSource, /data-panel=["']characters["']|legacyProxy|legacyAction/);
});

test('Feature UI public helpers use Token terminology', () => {
  assert.match(interactionIndex, /tokenFeatureId/);
  assert.match(interactionIndex, /tokensInsideFeature/);
  assert.doesNotMatch(interactionIndex, /characterFeatureId|charactersInsideFeature/);
});
