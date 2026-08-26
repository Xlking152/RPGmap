import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const elevationSource = await readFile(new URL('../src/elevation/system.js', import.meta.url), 'utf8');
const entityUiSource = await readFile(new URL('../src/entities/ui.js', import.meta.url), 'utf8');
const appShellSource = await readFile(new URL('../src/ui/app-shell.js', import.meta.url), 'utf8');

test('Token elevation observer does not repeatedly update an already-oriented tooltip', () => {
  const orient = elevationSource.match(/function orientCharacterTooltip[\s\S]*?\n}\n\nexport function createElevationSystem/);
  assert.ok(orient, 'orientation helper should remain isolated');
  assert.match(orient[0], /const needsUpdate =/);
  assert.match(orient[0], /if \(!needsUpdate\) return;/);
  assert.match(orient[0], /tooltip\.update\?\.\(\);/);
});

test('Token elevation supports repeatable HUD edits and a character-sheet entry point', () => {
  assert.match(elevationSource, /function requestedTokenElevationFt\(value, fallback = 0\)/);
  assert.match(elevationSource, /return Number\.isFinite\(number\) \? Math\.max\(0, number\)/);
  assert.match(elevationSource, /api\.commitState\(next, \{ source: 'elevation:token' \}\)/);
  assert.match(elevationSource, /openTokenElevationEditor,/);
  assert.match(elevationSource, /canSetTokenElevation: characterId => canControlCharacter\(api, characterId\)/);
  assert.match(entityUiSource, /data-sheet-action="edit-token-elevation"/);
  assert.match(entityUiSource, /api\.elevation\?\.openTokenElevationEditor\?\./);
  assert.match(appShellSource, /\['调整高度', \(\) => api\.elevation\?\.openTokenElevationEditor\?\.\(characterId, event\)\]/);
});
