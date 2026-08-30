import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const combatIndex = await readFile(new URL('../src/combat/index.js', import.meta.url), 'utf8');
const combatController = await readFile(new URL('../src/combat/controller.js', import.meta.url), 'utf8');
const combatRenderer = await readFile(new URL('../src/combat/turn-origin-renderer.js', import.meta.url), 'utf8');
const combatModel = await readFile(new URL('../src/combat/model.js', import.meta.url), 'utf8');

test('Combat system registers an independent turn-origin renderer', () => {
  assert.match(combatIndex, /createCombatTurnOriginRenderer\(\)\.register\(api\)/);
  assert.match(combatRenderer, /combatTurnOriginPane/);
  assert.match(combatRenderer, /createTokenViewModel/);
  assert.match(combatRenderer, /rpg-token-v2-core/);
  assert.match(combatRenderer, /起点 ·/);
  assert.match(combatRenderer, /opacity: 0\.32/);
  assert.match(combatRenderer, /interactive: false/);
  assert.doesNotMatch(combatRenderer, /api\.world\.commit|api\.commitState|moveSceneToken/);
});

test('turn origin is captured at combat start and every explicit turn advance', () => {
  assert.match(combatController, /startCombat\(combat\)[\s\S]*?captureCurrentTurnOrigin\(api, combat\)[\s\S]*?persist/);
  assert.match(combatController, /const current = nextTurn\(combat\);[\s\S]*?captureCurrentTurnOrigin\(api, combat\)[\s\S]*?persist/);
  assert.match(combatController, /combat\.state === 'active' && !combat\.turnOrigin/);
});

test('Combat schema 2 persists only minimal generic turn-origin geometry', () => {
  assert.match(combatModel, /schemaVersion: 2/);
  assert.match(combatModel, /round:/);
  assert.match(combatModel, /elevationFt:/);
  assert.doesNotMatch(combatModel, /turnOrigin[\s\S]{0,300}combatantId:/);
  assert.doesNotMatch(combatModel, /turnOrigin[\s\S]{0,300}tokenId:/);
  assert.doesNotMatch(combatModel, /characterId|state\.characters|Character/);
});

test('origin ghost is visible only after canonical current Token leaves the stored origin', () => {
  assert.match(combatRenderer, /preferences\?\.combatSystem\?\.combat/);
  assert.match(combatRenderer, /currentCombatant\(combat\)/);
  assert.match(combatRenderer, /combatTurnOriginMoved\(combat, token\)/);
  assert.match(combatRenderer, /state:import/);
  assert.match(combatRenderer, /state:commit/);
});
