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
});

test('Token Renderer V2 owns the visible name and elevation labels', () => {
  assert.match(rendererSource, /token-v2-tooltip/);
  assert.match(rendererSource, /token-elevation-label/);
  assert.match(rendererSource, /data-token-id/);
  assert.doesNotMatch(rendererSource, /api\.selectCharacter/);
});
