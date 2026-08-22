import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const elevationSource = await readFile(new URL('../src/elevation/system.js', import.meta.url), 'utf8');
const healthBarSource = await readFile(new URL('../src/health/token-bars.js', import.meta.url), 'utf8');

test('Elevation owns only the right-side ft label and not a second HP bar', () => {
  assert.match(elevationSource, /left:calc\(100% \+ 5px\); top:50%/);
  assert.doesNotMatch(elevationSource, /token-hp-fill/);
  assert.doesNotMatch(elevationSource, /resolveActor/);
  assert.match(elevationSource, /HealthSystem is the single owner of Token HP bars/);
});

test('HealthSystem keeps the single canonical token health bar below the token', () => {
  assert.match(healthBarSource, /iconAnchor: \[23, -27\]/);
  assert.match(healthBarSource, /rpgmap-token-healthbar/);
});

test('Character name is moved above the token and right-click has DOM plus Leaflet fallback', () => {
  assert.match(elevationSource, /tooltip\.options\.direction = 'top'/);
  assert.match(elevationSource, /tooltip\.options\.offset = \[0, -14\]/);
  assert.match(elevationSource, /closest\?\.\('\.rpg-character'\)/);
  assert.match(elevationSource, /identifyCharacterIcons\(\);\n        const characterId = icon\.dataset\.characterId/);
  assert.match(elevationSource, /api\.map\.on\?\.\('contextmenu', mapTokenContextMenu\)/);
});
