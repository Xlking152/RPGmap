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
  'src/tools/fvtt-segment-distance.js',
  'src/tools/fvtt-token-ghost.js',
  'src/tools/fvtt-waypoint-movement.js',
];
const liveRuntimeFiles = [
  'src/main.js',
  'src/engine/runtime.js',
  'src/ui/app-shell-v2.js',
  'src/world/model.js',
  'src/world/system.js',
  'src/world/operations.js',
  'src/world/references.js',
  'src/combat/model.js',
  'src/combat/controller.js',
  'src/combat/turn-origin-renderer.js',
  'src/health/sheet-extension.js',
  'src/engine/navigation.js',
  'src/movement/session.js',
  'src/movement/state.js',
  'src/movement/ghost.js',
  'src/movement/ghost-renderer-v2.js',
  'src/token/model.js',
  'src/movement/controller-v2.js',
  'src/movement/controller-v3.js',
  'src/movement/route-inspector.js',
  'src/movement/token-runtime.js',
  'src/render/token-motion.js',
  'src/render/token-layer.js',
  'src/measurement/controller-v2.js',
  'src/elevation/model.js',
  'src/elevation/runtime-context.js',
  'src/interaction/map-inspector.js',
  'src/scene/areas.js',
  'src/scene/area-handle-geometry.js',
  'src/scene/area-handles.js',
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

test('live runtime sources cannot restore Character document identity, events, APIs, or panes', () => {
  const forbidden = /state\.characters|\bcharacterId\b|character:(?:create|move|delete|select)|\b(?:selectCharacter|placeCharacter|repositionCharacter|deleteCharacter|moverContextForCharacter)\b|characterPane/;
  for (const path of liveRuntimeFiles) {
    const value = withoutComments(source(path));
    assert.doesNotMatch(value, forbidden, `${path} restored a Character runtime dependency`);
  }
});

test('SaveV2 migration is isolated to the import/persistence boundary', () => {
  const runtimeState = source('src/engine/runtime-state.js');
  const legacy = source('src/legacy/save-v2.js');
  assert.match(runtimeState, /isLegacySaveV2Payload/);
  assert.match(runtimeState, /migrateLegacySaveV2/);
  assert.match(runtimeState, /delete next\.characters/);
  assert.match(legacy, /legacy\.characters/);
  assert.match(legacy, /token\.characterId/);
  assert.match(legacy, /anchor\?\.type === 'character'/);
  assert.match(legacy, /\{ type: 'token', tokenId: String\(anchor\.characterId\) \}/);
  assert.match(legacy, /delete state\.characters/);
});

test('World V2 server authority rejects Character fields after migration', () => {
  const server = source('deployment/local-server/world-schema.mjs');
  const statusOperations = source('src/status/model.js');
  assert.match(server, /World V2 state must not contain state\.characters/);
  assert.match(server, /characterId is forbidden in World V2/);
  assert.match(server, /legacy_character_forbidden/);
  assert.doesNotMatch(statusOperations, /resolveStatusCapabilitiesForCharacter|item\?\.characterId/);
});
