import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const retiredFiles = [
  'src/engine/app.js',
  'src/legacy/character-retirement.js',
  'src/ui/app-shell.js',
  'src/ui/legacy-bridge.js',
  'src/ui/panel-ownership.js',
  'src/movement/controller.js',
  'src/movement/ghost-renderer.js',
  'src/movement/distance-renderer.js',
  'src/measurement/controller.js',
];
const modernFiles = [
  'src/main.js',
  'src/engine/runtime.js',
  'src/engine/runtime-state.js',
  'src/ui/app-shell-v2.js',
  'src/world/model.js',
  'src/world/system.js',
  'src/movement/controller-v2.js',
  'src/movement/token-runtime.js',
  'src/measurement/controller-v2.js',
  'src/elevation/model.js',
  'src/elevation/runtime-context.js',
  'src/scene/areas.js',
];

function source(path) {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

function withoutComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('retired Character AppCore and bridge files are physically absent', () => {
  for (const path of retiredFiles) {
    assert.equal(existsSync(new URL(path, ROOT)), false, `${path} must stay retired`);
  }
});

test('modern runtime sources cannot restore Character document identity, events, APIs, or panes', () => {
  const forbidden = /state\.characters|\bcharacterId\b|character:(?:create|move|delete|select)|\b(?:selectCharacter|placeCharacter|repositionCharacter|deleteCharacter|moverContextForCharacter)\b|characterPane/;
  for (const path of modernFiles) {
    const value = withoutComments(source(path));
    assert.doesNotMatch(value, forbidden, `${path} restored a Character runtime dependency`);
  }
});

test('legacy SaveV2 adapter is the explicit Character migration boundary', () => {
  const legacy = source('src/legacy/save-v2.js');
  assert.match(legacy, /legacy\.characters/);
  assert.match(legacy, /token\.characterId/);
  assert.match(legacy, /anchor\?\.type === 'character'/);
  assert.match(legacy, /\{ type: 'token', tokenId: String\(anchor\.characterId\) \}/);
  assert.match(legacy, /delete state\.characters/);
});

test('World V2 server authority rejects Character fields after migration', () => {
  const server = source('deployment/local-server/world-schema.mjs');
  assert.match(server, /World V2 state must not contain state\.characters/);
  assert.match(server, /characterId is forbidden in World V2/);
  assert.match(server, /legacy_character_forbidden/);
});
