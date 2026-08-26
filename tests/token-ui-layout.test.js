import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const elevationSource = await readFile(new URL('../src/elevation/system.js', import.meta.url), 'utf8');
const healthBarSource = await readFile(new URL('../src/health/token-bars.js', import.meta.url), 'utf8');

test('Elevation owns only the top-right ft label and not a second HP bar', () => {
  assert.match(elevationSource, /left:calc\(100% \+ 3px\); top:-3px/);
  assert.doesNotMatch(elevationSource, /token-hp-fill/);
  assert.doesNotMatch(elevationSource, /resolveActor/);
  assert.match(elevationSource, /HealthSystem is the single owner of Token HP bars/);
});

test('HealthSystem keeps the single canonical token health bar below the scaled Token', () => {
  assert.match(healthBarSource, /tokenDiameterMeters\(token\)/);
  assert.match(healthBarSource, /iconAnchor: \[barWidth \/ 2, -\(tokenPixels \/ 2 \+ 6\)\]/);
  assert.match(healthBarSource, /rpgmap-token-healthbar/);
});

test('Character name stays above token and right-click has direct layer plus fallbacks', () => {
  assert.match(elevationSource, /tooltip\.options\.direction = 'top'/);
  assert.match(elevationSource, /tooltip\.options\.offset = \[0, -14\]/);
  assert.match(elevationSource, /layer\.on\?\.\('contextmenu'/);
  assert.match(elevationSource, /closest\?\.\('\.rpg-character'\)/);
  assert.match(elevationSource, /api\.map\.on\?\.\('contextmenu', mapTokenContextMenu\)/);
});
