import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCombatants,
  createCombat,
  currentCombatant,
  moveCombatant,
  nextTurn,
  removeCombatant,
  setCombatantInitiative,
  startCombat,
} from '../src/combat/model.js';

test('initiative sorts descending and blanks stay at the bottom', () => {
  const combat = createCombat([{tokenId:'a'}, {tokenId:'b'}, {tokenId:'c'}]);
  setCombatantInitiative(combat, 'combatant-a', 12);
  setCombatantInitiative(combat, 'combatant-b', 20);
  assert.deepEqual(combat.combatants.map(item => [item.tokenId,item.initiative]), [['b',20],['a',12],['c',null]]);
});

test('manual drag order works without changing initiative values', () => {
  const combat = createCombat([{tokenId:'a'}, {tokenId:'b'}, {tokenId:'c'}]);
  setCombatantInitiative(combat, 'combatant-a', 20);
  setCombatantInitiative(combat, 'combatant-b', 10);
  setCombatantInitiative(combat, 'combatant-c', 5);
  moveCombatant(combat, 'combatant-c', 'combatant-a');
  assert.deepEqual(combat.combatants.map(item => item.tokenId), ['c','a','b']);
  assert.deepEqual(combat.combatants.map(item => item.initiative), [5,20,10]);
});

test('combat advances turns and rounds, and adding tokens is explicit', () => {
  const combat = createCombat([{tokenId:'a'}, {tokenId:'b'}]);
  setCombatantInitiative(combat, 'combatant-a', 10);
  setCombatantInitiative(combat, 'combatant-b', 5);
  assert.equal(startCombat(combat), true);
  assert.equal(combat.round, 1);
  assert.equal(currentCombatant(combat).tokenId, 'a');
  assert.equal(nextTurn(combat).tokenId, 'b');
  assert.equal(nextTurn(combat).tokenId, 'a');
  assert.equal(combat.round, 2);
  assert.equal(addCombatants(combat, [{tokenId:'c'}]), 1);
  assert.equal(addCombatants(combat, [{tokenId:'c'}]), 0);
});

test('removing current combatant keeps combat usable', () => {
  const combat = createCombat([{tokenId:'a'}, {tokenId:'b'}, {tokenId:'c'}]);
  startCombat(combat);
  assert.equal(removeCombatant(combat, currentCombatant(combat).id), true);
  assert.equal(combat.combatants.length, 2);
  assert.ok(currentCombatant(combat));
});
