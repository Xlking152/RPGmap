import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const elevationSource = await readFile(new URL('../src/elevation/token-system.js', import.meta.url), 'utf8');
const rendererSource = await readFile(new URL('../src/render/token-layer.js', import.meta.url), 'utf8');
const healthBarSource = await readFile(new URL('../src/health/token-bars.js', import.meta.url), 'utf8');

test('Elevation V2 owns Token elevation editing but not a second HP bar or Character DOM', () => {
  assert.match(elevationSource, /openTokenElevationEditor/);
  assert.match(elevationSource, /api\.tokens\.update/);
  assert.match(elevationSource, /tokenId/);
  assert.doesNotMatch(elevationSource, /token-hp-fill/);
  assert.doesNotMatch(elevationSource, /rpg-character/);
});

test('HealthSystem keeps the single canonical Token health bar below the scaled Token', () => {
  assert.match(healthBarSource, /tokenDiameterMeters\(token\)/);
  assert.match(healthBarSource, /iconAnchor: \[barWidth \/ 2, -\(tokenPixels \/ 2 \+ 6\)\]/);
  assert.match(healthBarSource, /rpgmap-token-healthbar/);
  assert.match(healthBarSource, /token:visual-move-start/);
  assert.match(healthBarSource, /token:visual-move-end/);
});

test('Token Renderer V2 places elevation immediately left of the visible name', () => {
  assert.match(rendererSource, /token-v2-tooltip/);
  assert.match(rendererSource, /token-v2-label-row/);
  assert.match(rendererSource, /token-v2-elevation-label/);
  assert.match(rendererSource, /row\.append\(elevation, name\)/);
  assert.doesNotMatch(rendererSource, /class="token-elevation-label"/);
  assert.match(rendererSource, /data-token-id/);
  assert.doesNotMatch(rendererSource, /api\.selectCharacter/);
});

test('Token Renderer V2 visually interpolates canonical movement without intermediate World writes', () => {
  assert.match(rendererSource, /requestAnimationFrame/);
  assert.match(rendererSource, /interpolateTokenPoint/);
  assert.match(rendererSource, /token:visual-move-start/);
  assert.match(rendererSource, /token:visual-move-end/);
  assert.doesNotMatch(rendererSource, /api\.world\.commit|api\.commitState/);
});
