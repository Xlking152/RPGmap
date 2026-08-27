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
  };
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('Token property snapshot reads only canonical Token fields', () => {
  const api = runtime({ hidden: true, rotation: 725, elevationFt: 25 });
  assert.deepEqual(tokenPropertySnapshot(api, 'token-a'), {
    id: 'token-a',
    actorId: 'actor-a',
    hidden: true,
    diameterMeters: 5,
    rotation: 5,
    elevationFt: 25,
    locked: false,
    showName: true,
  });
});

test('Token property mutations write only through api.tokens.update', async () => {
  const api = runtime();
  await setTokenHidden(api, 'token-a', true);
  await setTokenDiameterMeters(api, 'token-a', 10);
  await setTokenRotation(api, 'token-a', -45);
  await setTokenElevationFt(api, 'token-a', 35);
  assert.deepEqual(api.calls, [
    { hidden: true },
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

test('Token property bridge cannot write Character or Entity compatibility storage', async () => {
  const path = fileURLToPath(new URL('../src/token/property-ui.js', import.meta.url));
  const source = withoutComments(await readFile(path, 'utf8'));
  assert.match(source, /setTokenDiameterMeters/);
  assert.match(source, /setTokenElevationFt/);
  assert.match(source, /setTokenHidden/);
  assert.match(source, /setTokenRotation/);
  assert.doesNotMatch(source, /state\.characters|preferences\.entitySystem|store\.persist|api\.commitState|api\.importState/);
});

test('Token property bridge is registered after Elevation so it can replace public Token-height methods', async () => {
  const path = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const source = await readFile(path, 'utf8');
  const elevation = source.indexOf('createElevationSystem(),');
  const properties = source.indexOf('createTokenPropertyUiSystem(),');
  const health = source.indexOf('createHealthSystem(),');
  assert.ok(elevation >= 0 && properties > elevation && health > properties);
});
