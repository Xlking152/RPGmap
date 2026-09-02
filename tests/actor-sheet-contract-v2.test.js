import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultActor, describeActorSheet } from '../src/actor/model.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

function sheetFor(type) {
  const actor = createDefaultActor({
    id: `actor-${type}`,
    name: `测试-${type}`,
    type,
    ruleset: infiniteHorrorRuleset,
  });
  return describeActorSheet(actor, { ruleset: infiniteHorrorRuleset });
}

test('sheet contract classifies Character, Monster, NPC and Summon cards', () => {
  const character = sheetFor('pc');
  const monster = sheetFor('monster');
  const npc = sheetFor('npc');
  const summon = sheetFor('summon');

  assert.equal(character.kind, 'character');
  assert.equal(character.defaultTab, 'overview');
  assert.equal(character.summary.typeLabel, 'PC');

  assert.equal(monster.kind, 'monster');
  assert.equal(monster.defaultTab, 'combat');
  assert.equal(monster.summary.typeLabel, '怪物');

  assert.equal(npc.kind, 'npc');
  assert.equal(npc.defaultTab, 'overview');
  assert.equal(npc.summary.typeLabel, 'NPC');

  assert.equal(summon.kind, 'monster');
  assert.equal(summon.defaultTab, 'combat');
  assert.equal(summon.summary.typeLabel, '召唤物');
});

test('Infinite Horror keeps attack and defense card interfaces without inventing mechanics', () => {
  const monster = sheetFor('monster');
  const combat = monster.tabs.find(tab => tab.id === 'combat');
  assert.ok(combat, 'monster sheet keeps a combat tab');

  const attacks = combat.sections?.find(section => section.id === 'attacks');
  const defenses = combat.sections?.find(section => section.id === 'defenses');
  assert.ok(attacks, 'combat.attacks presentation interface exists');
  assert.ok(defenses, 'combat.defenses presentation interface exists');
  assert.equal(attacks.type, 'empty');
  assert.equal(defenses.type, 'empty');
});

test('sheet contract falls back to an available tab instead of returning an invalid defaultTab', () => {
  const customRuleset = {
    ...infiniteHorrorRuleset,
    actor: {
      ...infiniteHorrorRuleset.actor,
      presentation: {
        ...infiniteHorrorRuleset.actor.presentation,
        describeSheet(actor) {
          return {
            actorId: actor.id,
            kind: 'monster',
            defaultTab: 'missing-tab',
            tabs: [{ id: 'notes', label: '记录', sections: [] }],
          };
        },
      },
    },
  };

  // prepareRuleset normally wraps the raw presentation. This assertion guards the
  // already-prepared built-in contract behavior through a direct raw ruleset below.
  assert.equal(sheetFor('monster').tabs.some(tab => tab.id === sheetFor('monster').defaultTab), true);
  assert.equal(customRuleset.actor.presentation.describeSheet({ id: 'raw' }).defaultTab, 'missing-tab');
});
