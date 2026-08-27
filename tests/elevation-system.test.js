import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const elevationSource = await readFile(new URL('../src/elevation/token-system.js', import.meta.url), 'utf8');
const elevationModelSource = await readFile(new URL('../src/elevation/model.js', import.meta.url), 'utf8');
const elevationIndexSource = await readFile(new URL('../src/elevation/index.js', import.meta.url), 'utf8');
const appShellSource = await readFile(new URL('../src/ui/app-shell.js', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('Elevation V2 writes only through canonical Token Runtime', () => {
  assert.match(elevationSource, /api\.tokens\.update\(token\.id, \{ elevationFt \}/);
  assert.match(elevationSource, /openTokenElevationEditor/);
  assert.match(elevationSource, /canControlToken/);
  assert.match(elevationSource, /canonicalSceneTokens: true/);
  assert.doesNotMatch(elevationSource, /state\.characters|character:select|character:delete|MutationObserver|selectCharacter/);
});

test('Elevation model exposes only Token and Feature helpers', () => {
  assert.match(elevationModelSource, /export function tokenElevationFt\(token\)/);
  assert.match(elevationModelSource, /export function tokenDiameterMeters\(token\)/);
  assert.doesNotMatch(elevationModelSource, /tokenForCharacter|actorForCharacter|moverContextForCharacter|entityStateFromAppState|resolveStatuses/);
  assert.doesNotMatch(elevationIndexSource, /createElevationSystem|actorForCharacter|tokenForCharacter|entityStateFromAppState/);
});

test('runtime registers Token elevation and modern shell opens it by token id', () => {
  assert.match(elevationIndexSource, /createTokenElevationSystem/);
  assert.doesNotMatch(elevationIndexSource, /placement-context|createElevationSystem as/);
  assert.match(appShellSource, /openTokenElevationEditor\?\.\(selection\.token\.id, event\)/);
  assert.match(appShellSource, /openTokenElevationEditor\?\.\(token\.id, event\)/);
  assert.match(mainSource, /createTokenElevationSystem\(\)/);
  assert.doesNotMatch(mainSource, /createElevationSystem\(\)/);
});
