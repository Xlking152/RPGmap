import test from 'node:test';
import assert from 'node:assert/strict';
import {
  combatTurnOriginMoved,
  createCombat,
  nextTurn,
  normalizeCombatState,
  removeCombatant,
  setCombatTurnOrigin,
  startCombat,
} from '../src/combat/model.js';

function refs() {
  return [
    { tokenId: 'token-a', actorId: 'actor-a' },
    { tokenId: 'token-b', actorId: 'actor-b' },
  ];
}

test('legacy Combat schema normalizes forward to schema 2 without inventing an origin', () => {
  const normalized = normalizeCombatState({
    schemaVersion: 1,
    combat: {
      id: 'combat-old', state: 'active', round: 3, turnIndex: 1,
      combatants: refs().map((item, order) => ({ ...item, id: `combatant-${item.tokenId}`, order })),
    },
  });
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.combat.round, 3);
  assert.equal(normalized.combat.turnIndex, 1);
  assert.equal(normalized.combat.turnOrigin, null);
});

test('active combat stores a canonical origin for the current combatant', () => {
  const combat = createCombat(refs());
  assert.equal(startCombat(combat), true);
  const origin = setCombatTurnOrigin(combat, { x: 120, y: 80, elevationFt: 15 });
  assert.deepEqual(origin, {
    combatantId: 'combatant-token-a',
    tokenId: 'token-a',
    round: 1,
    x: 120,
    y: 80,
    elevationFt: 15,
  });
  assert.equal(combatTurnOriginMoved(combat, { id: 'token-a', x: 120, y: 80 }), false);
  assert.equal(combatTurnOriginMoved(combat, { id: 'token-a', x: 125, y: 80 }), true);
});

test('next turn clears the previous origin before the controller captures the next one', () => {
  const combat = createCombat(refs());
  startCombat(combat);
  setCombatTurnOrigin(combat, { x: 1, y: 2, elevationFt: 0 });
  const next = nextTurn(combat);
  assert.equal(next.tokenId, 'token-b');
  assert.equal(combat.turnOrigin, null);
  setCombatTurnOrigin(combat, { x: 9, y: 10, elevationFt: 30 });
  assert.equal(combat.turnOrigin.tokenId, 'token-b');
  assert.equal(combat.turnOrigin.elevationFt, 30);
});

test('removing the active combatant invalidates its origin', () => {
  const combat = createCombat(refs());
  startCombat(combat);
  setCombatTurnOrigin(combat, { x: 20, y: 30, elevationFt: 5 });
  assert.equal(removeCombatant(combat, 'combatant-token-a'), true);
  assert.equal(combat.turnOrigin, null);
  assert.equal(combat.combatants[combat.turnIndex].tokenId, 'token-b');
});

test('shared origin survives normalization only for the current combatant and round', () => {
  const raw = {
    schemaVersion: 2,
    combat: {
      id: 'combat-shared', state: 'active', round: 2, turnIndex: 0,
      combatants: refs().map((item, order) => ({ ...item, id: `combatant-${item.tokenId}`, order })),
      turnOrigin: {
        combatantId: 'combatant-token-a', tokenId: 'token-a', round: 2,
        x: 44, y: 55, elevationFt: 10,
      },
    },
  };
  assert.deepEqual(normalizeCombatState(raw).combat.turnOrigin, raw.combat.turnOrigin);
  raw.combat.turnOrigin.round = 1;
  assert.equal(normalizeCombatState(raw).combat.turnOrigin, null);
});
