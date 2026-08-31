import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  normalizeTokenRotation,
  setTokenDiameterMeters,
  setTokenElevationFt,
  setTokenHidden,
  setTokenRotation,
  tokenPropertySnapshot,
} from '../src/token/properties.js';

function runtime(overrides = {}) {
  let token = {
    id: 'token-a',
    actorId: 'actor-a',
    hidden: false,
    visibility: { mode: 'public', userIds: [] },
    diameterMeters: 5,
    rotation: 15,
    elevationFt: 10,
    locked: false,
    showName: true,
    ...overrides,
  };
  const calls = [];
  return {
    calls,
    tokens: {
      get(id) { return String(id) === token.id ? structuredClone(token) : null; },
      async update(id, changes) {
        assert.equal(String(id), token.id);
        calls.push(structuredClone(changes));
        token = { ...token, ...structuredClone(changes) };
        return structuredClone(token);
      },
    },
    world: {
      get() { return { activeSceneId: 'scene-a' }; },
      async performOperations(operations) {
        assert.equal(operations.length, 1);
        const operation = operations[0];
        assert.equal(operation.type, 'token.access.patch');
        calls.push(structuredClone(operation.payload.patch));
        token = {
          ...token,
          visibility: { ...token.visibility, ...structuredClone(operation.payload.patch.visibility) },
        };
        return true;
      },
    },
  };
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('Token property snapshot reads only canonical Token fields', () => {
  const api = runtime({ visibility: { mode: 'gm', userIds: [] }, rotation: 725, elevationFt: 25 });
  assert.deepEqual(tokenPropertySnapshot(api, 'token-a'), {
    id: 'token-a',
    actorId: 'actor-a',
    hidden: true,
    visibility: { mode: 'gm', userIds: [] },
    diameterMeters: 5,
    rotation: 5,
    elevationFt: 25,
    locked: false,
    showName: true,
  });
});

test('Token property mutations use access operation for visibility and Token updates for geometry', async () => {
  const api = runtime();
  await setTokenHidden(api, 'token-a', true);
  await setTokenDiameterMeters(api, 'token-a', 10);
  await setTokenRotation(api, 'token-a', -45);
  await setTokenElevationFt(api, 'token-a', 35);
  assert.deepEqual(api.calls, [
    { visibility: { mode: 'gm', userIds: [] } },
    { diameterMeters: 10 },
    { rotation: 315 },
    { elevationFt: 35 },
  ]);
});

test('Token rotation is normalized into [0, 360)', () => {
  assert.equal(normalizeTokenRotation(0), 0);
  assert.equal(normalizeTokenRotation(360), 0);
  assert.equal(normalizeTokenRotation(725), 5);
  assert.equal(normalizeTokenRotation(-15), 345);
});

test('Entity Token controller owns property edits without Character or Entity projection writes', async () => {
  const path = fileURLToPath(new URL('../src/entities/token-controller.js', import.meta.url));
  const source = withoutComments(await readFile(path, 'utf8'));
  assert.match(source, /setTokenDiameterMeters/);
  assert.match(source, /setTokenElevationFt/);
  assert.match(source, /setTokenHidden/);
  assert.match(source, /setTokenRotation/);
  assert.doesNotMatch(source, /state\.characters|preferences\.entitySystem|store\.persist|api\.commitState|api\.importState/);
  assert.doesNotMatch(source, /data-character-id|api\.elevation\?\.setTokenElevation/);
});

test('startup no longer registers the Token property bridge', async () => {
  const main = withoutComments(await readFile(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8'));
  const tokenIndex = withoutComments(await readFile(fileURLToPath(new URL('../src/token/index.js', import.meta.url)), 'utf8'));
  const entityUi = withoutComments(await readFile(fileURLToPath(new URL('../src/entities/ui.js', import.meta.url)), 'utf8'));

  assert.doesNotMatch(main, /createTokenPropertyUiSystem/);
  assert.doesNotMatch(tokenIndex, /createTokenPropertyUiSystem|property-ui/);
  assert.match(entityUi, /tokenController\.handleChange\(event\.target\)/);
});
