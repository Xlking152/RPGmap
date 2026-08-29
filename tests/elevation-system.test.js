import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const elevationSource = await readFile(new URL('../src/elevation/token-system.js', import.meta.url), 'utf8');
const elevationModelSource = await readFile(new URL('../src/elevation/model.js', import.meta.url), 'utf8');
const elevationIndexSource = await readFile(new URL('../src/elevation/index.js', import.meta.url), 'utf8');
const appShellSource = await readFile(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const mapRuntimeSource = await readFile(new URL('../src/runtime/map-runtime.js', import.meta.url), 'utf8');

test('Elevation V2 writes only through canonical Token Runtime', () => {
  assert.match(elevationSource, /api\.tokens\.update\(token\.id, \{ elevationFt \}/);
  assert.match(elevationSource, /openTokenElevationEditor/);
  assert.match(elevationSource, /canControlToken/);
  assert.match(elevationSource, /canonicalSceneTokens: true/);
  assert.doesNotMatch(elevationSource, /state\.characters|character:select|character:delete|MutationObserver|selectCharacter|moverContextForCharacter/);
});

test('Elevation implementation is Token/Feature-only with no AppCore compatibility alias', () => {
  assert.match(elevationModelSource, /export function tokenElevationFt\(token\)/);
  assert.match(elevationModelSource, /export function tokenDiameterMeters\(token\)/);
  assert.doesNotMatch(elevationModelSource, /tokenForCharacter|actorForCharacter|entityStateFromAppState|resolveStatuses|moverContextForCharacter|legacyAppCoreMoverContext/);
  assert.doesNotMatch(elevationIndexSource, /createElevationSystem|actorForCharacter|tokenForCharacter|entityStateFromAppState|moverContextForCharacter/);
});

test('runtime registers Token elevation and modern shell opens it by token id', () => {
  assert.match(elevationIndexSource, /createTokenElevationSystem/);
  assert.doesNotMatch(elevationIndexSource, /placement-context|createElevationSystem as|moverContextForCharacter/);
  assert.match(appShellSource, /openTokenElevationEditor\?\.\(token\.id, event\)/);
  assert.match(mainSource, /runtime\/map-runtime\.js/);
  assert.match(mapRuntimeSource, /createTokenElevationSystem\(\)/);
  assert.doesNotMatch(`${mainSource}\n${mapRuntimeSource}`, /createElevationSystem\(\)|moverContextForCharacter|character-retirement/);
});
